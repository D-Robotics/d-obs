/** Request-scoped assistant tools reuse the registered HTTP handlers and their guards. */
import { ServerResponse } from 'node:http';
import type { Request, Response, Router } from 'express';
import type { McpTool } from '../observability/agent-mcp.js';
import { PLATFORM_OPERATION_EXCLUSIONS, type PlatformOperationMetadata } from './platform-operation-metadata.js';
import { observeRsiPlatformFailure } from './rsi-failure-observer.js';
export type PlatformOperation = {
  id: string;
  description: string;
  group: string;
  method: string;
  path: string;
  mutating: boolean;
  tenantAccessible: boolean;
  parameters: { params: Record<string, string>; query: Record<string, string>; body: Record<string, string> };
};
export type PlatformOperationArguments = {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
};
export type PlatformOperationResult = { ok: boolean; status: number; data: unknown };
type ExecutionOptions = { timeoutMs?: number; maxResultBytes?: number; signal?: AbortSignal };
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const PLUGIN_READ_ONLY_OPERATIONS = new Set(['POST /api/ops/observability/plugins/:id/workflows/:workflowId/run']);
// This bounded POST evaluates a supplied panel; it never saves a definition.
const READ_ONLY_POST_OPERATIONS = new Set(['POST /api/ops/observability/boards/query']);
const CONTROL_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const registeredOperations = new WeakMap<Router, Map<string, PlatformOperation>>();

/** No auth, ingest, callback, external proxy, or recursive assistant/MCP surfaces. */
export function isPlatformOperationPath(routePath: string): boolean {
  return routePath.startsWith('/api/ops/observability/') &&
    !/^\/api\/ops\/observability\/(?:assistant(?:\/|$)|remediate$)/.test(routePath) &&
    !/(?:\/mcp|\/stream)$/.test(routePath) && !/[?*()]/.test(routePath);
}

/**
 * The composition root explicitly publishes its reviewed business contract.
 * Adding a HTTP route does not automatically add an assistant/MCP capability.
 * Registered handlers remain the authority for access and payload validation.
 */
export function registerPlatformOperations(router: Router, declarations: Record<string, PlatformOperationMetadata>): void {
  const additions = new Map<string, PlatformOperation>();
  for (const [id, declaration] of Object.entries(declarations)) {
    const match = /^([A-Z]+) (\/\S+)$/.exec(id);
    if (!match || !ALLOWED_METHODS.has(match[1]) || !isPlatformOperationPath(match[2]) || PLATFORM_OPERATION_EXCLUSIONS[id] ||
      !declaration || typeof declaration.tenantAccessible !== 'boolean' ||
      typeof declaration.description !== 'string' || !declaration.description.trim() ||
      typeof declaration.group !== 'string' || !declaration.group.trim()) {
      throw new Error(`invalid_platform_operation_declaration: ${id}`);
    }
    const [, method, path] = match;
    const params = Object.fromEntries([...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((parameter) => [parameter[1], `路径参数 ${parameter[1]}（必填）`]));
    additions.set(id, {
      id, method, path, mutating: method !== 'GET' && !PLUGIN_READ_ONLY_OPERATIONS.has(id) && !READ_ONLY_POST_OPERATIONS.has(id), tenantAccessible: declaration.tenantAccessible,
      description: declaration.description, group: declaration.group,
      parameters: { params, query: { ...declaration.query }, body: { ...declaration.body } },
    });
  }
  // Validate a batch before publishing any entry; invalid declarations fail closed.
  const operations = new Map(registeredOperations.get(router));
  for (const [id, operation] of additions) operations.set(id, operation);
  registeredOperations.set(router, operations);
}

export function listPlatformOperations(router: Router): PlatformOperation[] {
  return [...(registeredOperations.get(router)?.values() ?? [])]
    .map((operation) => ({ ...operation, parameters: {
      params: { ...operation.parameters.params }, query: { ...operation.parameters.query }, body: { ...operation.parameters.body },
    } }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.id.localeCompare(b.id));
}

export function visiblePlatformOperations(router: Router, req: Request): PlatformOperation[] {
  return listPlatformOperations(router).filter((operation) => !req.opsTenantAccess || operation.tenantAccessible);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((key) => !CONTROL_KEYS.has(key));
}

function operationUrl(operation: PlatformOperation, args: PlatformOperationArguments, req: Request): string {
  const expected = [...operation.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  if (args.params && (!record(args.params) || Object.keys(args.params).some((key) => !expected.includes(key)))) {
    throw new Error('invalid_operation_params');
  }
  let url = operation.path;
  for (const key of expected) {
    const value = args.params?.[key];
    const opaqueId = (operation.path === '/api/ops/observability/objects/:objectId' && key === 'objectId')
      || (operation.path === '/api/ops/observability/model-prices/:model' && key === 'model');
    // Disallow path traversal/secondary route selectors, even after URL decoding.
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value)
      || (!opaqueId && value.includes('/')) || value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
      || (opaqueId && /%(?:2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value))) {
      throw new Error('invalid_operation_params');
    }
    url = url.replace(`:${key}`, encodeURIComponent(value));
  }
  if (args.query !== undefined && !record(args.query)) throw new Error('invalid_operation_query');
  // Only tenant-aware contracts accept the administrator's selected view.
  // Explicit arguments still override it; identity headers remain untouched.
  const query = { ...(Object.hasOwn(operation.parameters.query, 'tenant') && typeof req.query.tenant === 'string' ? { tenant: req.query.tenant } : {}), ...args.query };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(key)) throw new Error('invalid_operation_query');
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      if (!['string', 'number', 'boolean'].includes(typeof entry) || String(entry).length > 8192) {
        throw new Error('invalid_operation_query');
      }
      search.append(key, String(entry));
    }
  }
  return url + (search.size ? `?${search}` : '');
}

/** In-process dispatch: identity headers and session state come only from req. */
export async function executePlatformOperation(
  router: Router, req: Request, res: Response, id: string, args: PlatformOperationArguments = {}, options: ExecutionOptions = {},
): Promise<PlatformOperationResult> {
  const operation = visiblePlatformOperations(router, req).find((item) => item.id === id);
  if (!operation) return { ok: false, status: 404, data: { ok: false, error: 'unknown_platform_operation' } };
  if (operation.mutating && req.header('x-rdk-ops-read-only') === '1') {
    return { ok: false, status: 403, data: { ok: false, error: 'platform_read_only_operation_denied' } };
  }
  if (res.destroyed || req.aborted || options.signal?.aborted) return { ok: false, status: 499, data: { ok: false, error: 'platform_request_closed', outcome: operation.mutating ? 'unknown' : 'failed' } };
  if (!record(args) || Object.keys(args).some((key) => !['params', 'query', 'body'].includes(key)) ||
    (args.body !== undefined && !record(args.body))) {
    return { ok: false, status: 400, data: { ok: false, error: 'invalid_operation_arguments' } };
  }
  // The outer MCP request must carry the same mutation guard as the UI. The
  // agent cannot manufacture it using arguments. Protected reads use their own context guard.
  if (operation.mutating && req.header('x-rdk-ops-action') !== 'observability') {
    return { ok: false, status: 400, data: { ok: false, error: 'missing_ops_action_guard' } };
  }
  let url: string;
  try { url = operationUrl(operation, args, req); }
  catch (error) { return { ok: false, status: 400, data: { ok: false, error: (error as Error).message } }; }
  const innerReq = Object.create(req) as Request;
  Object.assign(innerReq, {
    method: operation.method, url, originalUrl: url, baseUrl: '', params: {},
    body: args.body ?? {}, query: Object.fromEntries(new URL(url, 'http://platform.invalid').searchParams),
    headers: { ...req.headers, 'x-rdk-ops-action': operation.mutating || PLUGIN_READ_ONLY_OPERATIONS.has(operation.id) || READ_ONLY_POST_OPERATIONS.has(operation.id) ? 'observability' : 'observability-context' },
    _parsedUrl: undefined, _parsedOriginalUrl: undefined, opsTenantAccess: undefined,
  });
  const captured = new ServerResponse(innerReq) as Response;
  Object.setPrototypeOf(captured, Object.getPrototypeOf(res));
  captured.req = innerReq;
  innerReq.res = captured;
  const chunks: Buffer[] = [];
  let size = 0;
  let done = false;
  let sent = false;
  Object.defineProperty(captured, 'headersSent', { get: () => sent });
  return new Promise((resolve) => {
    let abortListener: (() => void) | undefined;
    const finish = (data?: unknown, status = captured.statusCode) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (abortListener) options.signal?.removeEventListener('abort', abortListener);
      const text = Buffer.concat(chunks).toString('utf8');
      if (data === undefined) {
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      }
      const ok = status >= 200 && status < 300 && !(record(data) && data.ok === false);
      // Large exports stay downloadable through the original guarded route.
      const disposition = String(captured.getHeader('content-disposition') ?? '');
      if (ok && disposition.includes('attachment')) data = { ok: true, downloadUrl: url, contentType: captured.getHeader('content-type') };
      const result = { ok, status, data };
      observeRsiPlatformFailure(req, operation, result);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: 'platform_operation_timeout', outcome: operation.mutating ? 'unknown' : 'failed', message: '结果未确认，请查询状态；不要重复提交变更。' }, 504);
      captured.destroy();
    }, options.timeoutMs ?? 45_000);
    captured.destroy = ((error?: Error) => {
      if (captured.destroyed) return captured;
      // This response has no socket. Emit close ourselves to release a CSV
      // writer waiting for drain/close and let its async iterator run finally.
      captured.destroyed = true;
      if (error) captured.emit('error', error);
      captured.emit('close');
      return captured;
    }) as Response['destroy'];
    captured.flushHeaders = () => { sent = true; };
    captured.write = ((chunk: unknown) => {
      if (done) return true;
      sent = true;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > (options.maxResultBytes ?? MAX_RESULT_BYTES)) {
        const attachment = String(captured.getHeader('content-disposition') ?? '').includes('attachment');
        if (attachment) finish(undefined);
        else finish({ ok: false, error: 'platform_operation_result_too_large', outcome: operation.mutating ? 'unknown' : 'failed' }, 413);
        captured.destroy();
        return true;
      }
      chunks.push(buffer);
      return true;
    }) as Response['write'];
    captured.end = ((chunk?: unknown) => {
      if (chunk !== undefined) captured.write(chunk);
      sent = true;
      finish();
      captured.emit('finish');
      return captured;
    }) as Response['end'];
    captured.on('error', () => finish({ ok: false, error: 'platform_operation_failed', outcome: operation.mutating ? 'unknown' : 'failed' }, 500));
    captured.on('close', () => { if (!done) finish({ ok: false, error: 'platform_operation_interrupted', outcome: operation.mutating ? 'unknown' : 'failed' }, 503); });
    if (options.signal) {
      abortListener = () => { finish({ ok: false, error: 'platform_operation_cancelled', outcome: operation.mutating ? 'unknown' : 'failed' }, 499); captured.destroy(); };
      options.signal.addEventListener('abort', abortListener, { once: true });
      if (options.signal.aborted) { abortListener(); return; }
    }
    try {
      (router as unknown as { handle: (request: Request, response: Response, next: (error?: unknown) => void) => void }).handle(innerReq, captured, (error) => {
        finish({ ok: false, error: error ? 'platform_operation_failed' : 'platform_operation_not_found', outcome: error && operation.mutating ? 'unknown' : 'failed' }, error ? 500 : 404);
      });
    } catch { finish({ ok: false, error: 'platform_operation_failed', outcome: operation.mutating ? 'unknown' : 'failed' }, 500); }
  });
}

export function buildPlatformMcpTools(router: Router, req: Request, res: Response): McpTool[] {
  return [
    {
      name: 'list_platform_capabilities',
      description: '发现平台全部已注册功能，包括告警/租户/设备/模型池/看板/数据库/链路/日志调查/行动审批。返回准确的 operationId、参数说明与读写属性；可按分组或关键词筛选。',
      inputSchema: { type: 'object', properties: { group: { type: 'string' }, search: { type: 'string' } }, additionalProperties: false },
      handler: async (args) => {
        const group = String(args.group ?? '');
        const search = String(args.search ?? '').toLowerCase();
        return { operations: visiblePlatformOperations(router, req).filter((operation) => (!group || operation.group === group) && (!search || `${operation.id} ${operation.description} ${operation.group}`.toLowerCase().includes(search))) };
      },
    },
    {
      name: 'execute_platform_operation',
      description: '执行能力目录返回的 operationId，params/query/body 按目录填写。复用当前身份、租户隔离、API校验与审批审计；生产处置必须先证据proof与提案，再由有权限的其他操作者审批。变更需HTTP头 x-rdk-ops-action: observability，不能在工具参数中伪造凭证或身份。下载操作返回受保护的下载链接。',
      inputSchema: { type: 'object', properties: { operationId: { type: 'string' }, params: { type: 'object', additionalProperties: { type: 'string' } }, query: { type: 'object' }, body: { type: 'object' } }, required: ['operationId'], additionalProperties: false },
      handler: async (args) => {
        if (Object.keys(args).some((key) => !['operationId', 'params', 'query', 'body'].includes(key))) throw new Error('invalid_operation_arguments');
        const { operationId, ...input } = args;
        const result = await executePlatformOperation(router, req, res, String(operationId ?? ''), input as PlatformOperationArguments);
        if (!result.ok) throw new Error(`platform_http_${result.status}: ${JSON.stringify(result.data)}`);
        return result;
      },
    },
  ];
}
