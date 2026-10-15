import type { Request, RequestHandler, Response, Router } from 'express';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z, ZodError } from 'zod';
import { PluginRuntime, PluginError } from '../plugins/plugin-runtime.js';
import { BUILTIN_PLUGIN_TEMPLATES } from '../plugins/plugin-builtins.js';
import type { PluginExecutionContext, PluginManifest } from '../plugins/plugin-types.js';
import { PluginMcpClient } from '../plugins/plugin-mcp-client.js';
import { requireSshLogAccess, sessionOwner } from './ssh-log-routes.js';
import { clientErrorCode, requireOpsMutationGuard } from './observability-route-kit.js';
import { executePlatformOperation, visiblePlatformOperations, registerPlatformOperations } from './platform-operations.js';
import { PLUGIN_API, PLUGIN_OPERATIONS } from './plugin-operations.js';

export const PLUGIN_CONTRACT = 'rdk.plugin-host.v1';
let configuredRuntime: PluginRuntime | undefined;
let configuredMcp: PluginMcpClient | undefined;
export function getConfiguredPluginRuntime(): PluginRuntime {
  return configuredRuntime ??= new PluginRuntime({ stateDir: process.env.RDK_PLUGIN_STATE_DIR || join(homedir(), '.local', 'state', 'd-obs', 'plugins'), builtins: BUILTIN_PLUGIN_TEMPLATES });
}
export function getConfiguredPluginMcp(): PluginMcpClient { return configuredMcp ??= new PluginMcpClient(); }
export async function disposeConfiguredPlugins(): Promise<void> {
  const runtime = configuredRuntime; const mcp = configuredMcp;
  configuredRuntime = undefined; configuredMcp = undefined;
  await Promise.all([runtime?.dispose(), mcp?.dispose()]);
}
type Options = { runtime?: PluginRuntime; mcp?: PluginMcpClient; access?: RequestHandler; owner?: (req: Request) => string };
const revisionSchema = z.object({ expectedRevision: z.number().int().min(1) }).strict();
const argsSchema = z.record(z.unknown());
const queryArgs = (req: Request) => {
  if (Object.keys(req.query).some(key => !['args', 'tenant'].includes(key)) || (req.query.tenant !== undefined && (typeof req.query.tenant !== 'string' || req.query.tenant.length > 128)) || (req.query.args !== undefined && (typeof req.query.args !== 'string' || req.query.args.length > 8192))) throw new PluginError('plugin_invalid_arguments', 400);
  if (req.query.args === undefined) return {};
  try { return argsSchema.parse(JSON.parse(req.query.args as string)); }
  catch { throw new PluginError('plugin_invalid_arguments', 400); }
};
function failure(res: Response, error: unknown): void {
  if (error instanceof PluginError) { res.status(error.status).json({ ok: false, contract: PLUGIN_CONTRACT, error: error.code }); return; }
  if (error instanceof ZodError) { res.status(400).json({ ok: false, contract: PLUGIN_CONTRACT, error: 'plugin_invalid_request' }); return; }
  res.status(503).json({ ok: false, contract: PLUGIN_CONTRACT, error: clientErrorCode(error, 'plugin_unavailable') });
}
export function registerPluginRoutes(router: Router, options: Options = {}): void {
  const runtime = () => options.runtime ?? getConfiguredPluginRuntime();
  const mcp = () => options.mcp ?? getConfiguredPluginMcp();
  const access = options.access ?? requireSshLogAccess;
  const owner = options.owner ?? sessionOwner;
  const writable: RequestHandler = (req, res, next) => {
    if (req.header('x-rdk-ops-read-only') === '1') res.status(403).json({ ok: false, error: 'platform_read_only_operation_denied' });
    else next();
  };
  const guardOwner: RequestHandler = (req, res, next) => {
    if (req.opsTenantAccess || owner(req) === 'ops-admin') { res.status(403).json({ ok: false, error: 'plugin_identity_required' }); return; }
    next();
  };
  const context = (req: Request, res: Response, signal?: AbortSignal): PluginExecutionContext => {
    const reads = new Set(visiblePlatformOperations(router, req).filter(item => item.method === 'GET' && !item.mutating && !item.path.startsWith(PLUGIN_API) && !item.path.includes('/assistant/')).map(item => item.id));
    const canMcp = (connectorId: string, toolName: string) => mcp().listConnectors().some(item => item.configured && item.id === connectorId && item.readOnlyTools.includes(toolName));
    return {
      signal, timeoutMs: 30_000,
      canExecutePlatform: id => reads.has(id),
      executePlatform: async (id, args, toolSignal) => {
        if (!reads.has(id) || toolSignal.aborted) throw new PluginError('plugin_operation_denied', 403);
        const result = await executePlatformOperation(router, req, res, id, args, { timeoutMs: 25_000, maxResultBytes: 512 * 1024, signal: toolSignal });
        if (!result.ok) throw new PluginError('plugin_upstream_failed', result.status >= 400 && result.status < 600 ? result.status : 502);
        return result;
      },
      canExecuteMcp: canMcp,
      executeMcp: async (connectorId, toolName, args, toolSignal) => {
        if (!canMcp(connectorId, toolName)) throw new PluginError('plugin_mcp_tool_denied', 403);
        const result = await mcp().call(connectorId, toolName, args, toolSignal);
        if (result.isError) throw new PluginError('plugin_mcp_tool_failed', 502);
        return result.structuredContent ?? result.content;
      },
    };
  };
  const validateSources = async (manifest: PluginManifest, ctx: PluginExecutionContext) => {
    const external = new Map<string, Set<string>>();
    for (const tool of manifest.tools) {
      if (tool.source.type === 'platform' && !ctx.canExecutePlatform(tool.source.operationId)) throw new PluginError('plugin_operation_denied', 403);
      if (tool.source.type === 'mcp' && !ctx.canExecuteMcp?.(tool.source.connectorId, tool.source.toolName)) throw new PluginError('plugin_mcp_connector_unavailable', 503);
      if (tool.source.type === 'mcp') { const names = external.get(tool.source.connectorId) ?? new Set<string>(); names.add(tool.source.toolName); external.set(tool.source.connectorId, names); }
    }
    for (const [connectorId, names] of external) {
      try {
        const tools = await mcp().discover(connectorId, ctx.signal);
        if ([...names].some(name => !tools.some(tool => tool.name === name && tool.annotations.readOnlyHint))) throw new PluginError('plugin_mcp_tool_unavailable', 503);
      } catch (error) {
        if (error instanceof PluginError) throw error;
        throw new PluginError('plugin_mcp_preflight_failed', 503);
      }
    }
  };
  const wrap = (handler: (req: Request, res: Response, signal: AbortSignal) => unknown): RequestHandler => async (req, res) => {
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnected);
    try { await handler(req, res, controller.signal); }
    catch (error) { if (!res.destroyed && !res.headersSent) failure(res, error); }
    finally { res.removeListener('close', disconnected); }
  };
  const reply = (res: Response, data: object, status = 200) => res.status(status).json({ ok: true, contract: PLUGIN_CONTRACT, ...data });
  const get = (suffix: string, handler: (req: Request, res: Response, signal: AbortSignal) => unknown) => router.get(PLUGIN_API + suffix, access, guardOwner, wrap(handler));
  const post = (suffix: string, handler: (req: Request, res: Response, signal: AbortSignal) => unknown) => router.post(PLUGIN_API + suffix, access, guardOwner, requireOpsMutationGuard, writable, wrap(handler));
  get('/capabilities', (_req, res) => reply(res, { schema: PLUGIN_CONTRACT, lifecycle: ['draft', 'publish', 'enable', 'disable', 'rollback', 'uninstall'], executable: true, readOnlyTools: true, arbitraryCodeExecution: false, adapters: ['platform', 'mcp-streamable-http'], connectors: mcp().listConnectors(), identityScope: 'authenticated-operator', configCredentials: 'server-environment-only' }));
  get('/catalog', async (req, res) => reply(res, await runtime().catalog(owner(req))));
  get('', async (req, res) => reply(res, await runtime().catalog(owner(req))));
  post('/draft', async (req, res) => reply(res, { plugin: await runtime().saveDraft(owner(req), req.body) }, 201));
  get('/:id', async (req, res) => reply(res, { plugin: await runtime().detail(owner(req), String(req.params.id)) }));
  post('/:id/publish', async (req, res, signal) => {
    const input = revisionSchema.parse(req.body); const detail = await runtime().detail(owner(req), String(req.params.id));
    if (detail.revision !== input.expectedRevision) throw new PluginError('plugin_revision_conflict', 409);
    if (!detail.draft) throw new PluginError('plugin_draft_required', 409);
    const ctx = context(req, res, signal); await validateSources(detail.draft.manifest, ctx);
    reply(res, { plugin: await runtime().publish(owner(req), String(req.params.id), input, ctx) });
  });
  post('/:id/enabled', async (req, res, signal) => {
    const input = revisionSchema.extend({ enabled: z.boolean() }).strict().parse(req.body);
    if (input.enabled) { const detail = await runtime().detail(owner(req), String(req.params.id)); if (detail.revision !== input.expectedRevision) throw new PluginError('plugin_revision_conflict', 409); if (!detail.published) throw new PluginError('plugin_published_required', 409); await validateSources(detail.published.manifest, context(req, res, signal)); }
    reply(res, { plugin: await runtime().setEnabled(owner(req), String(req.params.id), input) });
  });
  post('/:id/rollback', async (req, res, signal) => {
    const input = revisionSchema.extend({ version: z.string().min(1).max(80) }).strict().parse(req.body);
    const detail = await runtime().detail(owner(req), String(req.params.id)); if (detail.revision !== input.expectedRevision) throw new PluginError('plugin_revision_conflict', 409); const version = detail.history.find(item => item.manifest.version === input.version);
    if (!version) throw new PluginError('plugin_version_not_found', 404);
    await validateSources(version.manifest, context(req, res, signal)); reply(res, { plugin: await runtime().rollback(owner(req), String(req.params.id), input) });
  });
  router.delete(PLUGIN_API + '/:id', access, guardOwner, requireOpsMutationGuard, writable, wrap(async (req, res) => reply(res, await runtime().uninstall(owner(req), String(req.params.id), revisionSchema.parse(req.body)))));
  get('/:id/data/:sourceId', async (req, res, signal) => reply(res, { result: await runtime().query(owner(req), String(req.params.id), String(req.params.sourceId), queryArgs(req), context(req, res, signal)) }));
  get('/:id/tools/:toolId', async (req, res, signal) => reply(res, { result: await runtime().callTool(owner(req), String(req.params.id), String(req.params.toolId), queryArgs(req), context(req, res, signal)) }));
  router.post(PLUGIN_API + '/:id/workflows/:workflowId/run', access, guardOwner, requireOpsMutationGuard, wrap(async (req, res, signal) => {
    const input = z.object({ args: argsSchema.optional() }).strict().parse(req.body);
    reply(res, { result: await runtime().runWorkflow(owner(req), String(req.params.id), String(req.params.workflowId), input.args ?? {}, context(req, res, signal)) });
  }));
  registerPlatformOperations(router, PLUGIN_OPERATIONS);
}
