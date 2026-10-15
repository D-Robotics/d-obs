/**
 * Server-configured, read-only MCP connector boundary.
 *
 * Supports the initialize/session Streamable HTTP revisions 2025-03-26,
 * 2025-06-18 and 2025-11-25 (JSON and request-scoped SSE). It deliberately
 * does not spawn stdio processes, resume streams, advertise sampling/roots/
 * elicitation, or execute remote instructions. The 2026 stateless protocol
 * is a separate transport lifecycle and is not claimed by this adapter.
 * Sources: modelcontextprotocol.io/specification/2025-11-25/basic/{transports,lifecycle}
 * and /server/tools. An annotation alone is not an authorization decision.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';

export type PluginMcpJson = null | boolean | number | string | PluginMcpJson[] | { [key: string]: PluginMcpJson };
export interface PluginMcpConnectorConfig {
  url: string;
  readOnlyTools: string[];
  /** Server-side environment variable containing a bearer token; never a token value. */
  credentialEnv?: string;
}
export interface PluginMcpTool {
  name: string;
  description?: string;
  inputSchema: { [key: string]: PluginMcpJson };
  annotations: { readOnlyHint: true };
}
export interface PluginMcpReceipt {
  connectorId: string;
  toolName: string;
  status: 'succeeded' | 'failed';
  isError: boolean;
  content: PluginMcpJson[];
  structuredContent?: PluginMcpJson;
}
export class PluginMcpError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PluginMcpError';
  }
}
interface ClientOptions {
  connectors?: Record<string, PluginMcpConnectorConfig>;
  env?: NodeJS.ProcessEnv;
  /** Test/host seam. Production uses a dedicated DNS-pinned undici dispatcher. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
interface Runtime {
  id: string;
  config: PluginMcpConnectorConfig;
  url: URL;
  agent: Agent;
  signal: AbortSignal;
  credential?: string;
  sessionId?: string;
  version?: string;
}
const VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26']);
const MAX_BYTES = 1024 * 1024;
const MAX_PAGES = 8;
const MAX_TOOLS = 256;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const TOOL_NAME = /^[a-zA-Z0-9_.:-]{1,128}$/;
const bad = (code: string, message: string): never => { throw new PluginMcpError(code, message); };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
const loopback = (host: string) => host === 'localhost' || host === '::1' || isIP(host) === 4 && host.startsWith('127.');
function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 168 || b === 0) || a === 100 && b >= 64 && b <= 127 || a >= 224
      || a === 198 && (b === 18 || b === 19);
  }
  const normalized = address.toLowerCase();
  // Reject IPv4-mapped and transition IPv6 addresses rather than risk alternate
  // encodings of a private IPv4 destination bypassing the IPv4 boundary.
  return normalized === '::' || normalized === '::1' || normalized.startsWith('::ffff:')
    || normalized.startsWith('64:ff9b:') || normalized.startsWith('2002:') || normalized.startsWith('2001:0:')
    || /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(normalized);
}
function validateUrl(raw: string, privateHosts: Set<string>): URL {
  let url: URL;
  try { url = new URL(raw); } catch { return bad('invalid_connector', 'MCP connector URL is invalid'); }
  const host = hostOf(url);
  if (url.username || url.password || url.hash || url.search || !host
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(host)))) {
    return bad('invalid_connector', 'MCP connectors require HTTPS (HTTP is limited to loopback), without URL credentials, query or fragment');
  }
  if (isIP(host) && privateAddress(host) && !loopback(host) && !privateHosts.has(host)) {
    return bad('private_destination', 'Private MCP destinations require an explicit server host allowlist');
  }
  return url;
}
function safeJson(value: unknown, secret?: string, depth = 0): PluginMcpJson {
  if (depth > 32) return bad('invalid_response', 'MCP JSON nesting exceeds the limit');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return secret ? value.split(secret).join('[redacted]') : value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => safeJson(item, secret, depth + 1));
  if (record(value)) {
    const result: { [key: string]: PluginMcpJson } = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      result[secret ? key.split(secret).join('[redacted]') : key] = safeJson(item, secret, depth + 1);
    }
    return result;
  }
  return bad('invalid_json', 'MCP values must be finite JSON data');
}
function stringify(value: unknown): string {
  const serialized = JSON.stringify(safeJson(value));
  if (Buffer.byteLength(serialized) > MAX_BYTES) return bad('payload_too_large', 'MCP request exceeds the size limit');
  return serialized;
}
function hasExternalReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExternalReference);
  if (!record(value)) return false;
  return Object.entries(value).some(([key, item]) => key === '$ref' && (typeof item !== 'string' || !item.startsWith('#')) || hasExternalReference(item));
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // A caller may have created a fetch promise immediately before noticing an
    // already-aborted signal. Consume its rejection before returning early.
    void promise.catch(() => {});
    return bad('aborted', 'MCP operation was cancelled');
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new PluginMcpError('aborted', 'MCP operation was cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class PluginMcpClient {
  private readonly env: NodeJS.ProcessEnv;
  private readonly connectors = new Map<string, PluginMcpConnectorConfig>();
  private readonly privateHosts: Set<string>;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly active = new Set<AbortController>();
  private readonly agents = new Set<Agent>();
  private disposed = false;
  private nextId = 0;

  constructor(options: ClientOptions = {}) {
    this.env = options.env ?? process.env;
    this.privateHosts = new Set((this.env.RDK_PLUGIN_MCP_PRIVATE_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = Math.min(120_000, Math.max(10, options.timeoutMs ?? 15_000));
    let configs: unknown = options.connectors;
    if (configs === undefined) {
      try { configs = JSON.parse(this.env.RDK_PLUGIN_MCP_CONNECTORS ?? '{}'); }
      catch { return bad('invalid_connector', 'RDK_PLUGIN_MCP_CONNECTORS must contain a JSON object'); }
    }
    if (!record(configs) || Object.keys(configs).length > 32) return bad('invalid_connector', 'MCP connector configuration is invalid');
    for (const [id, config] of Object.entries(configs)) {
      if (!ID.test(id) || !record(config) || typeof config.url !== 'string'
        || !Array.isArray(config.readOnlyTools) || config.readOnlyTools.length > MAX_TOOLS
        || config.readOnlyTools.some((name) => typeof name !== 'string' || !TOOL_NAME.test(name))
        || Object.keys(config).some((key) => !['url', 'readOnlyTools', 'credentialEnv'].includes(key))
        || config.credentialEnv !== undefined && (typeof config.credentialEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(config.credentialEnv))) {
        return bad('invalid_connector', 'MCP connectors accept only URL, read-only tool names and an environment credential reference');
      }
      validateUrl(config.url, this.privateHosts);
      this.connectors.set(id, { url: config.url, readOnlyTools: [...new Set(config.readOnlyTools as string[])],
        ...(config.credentialEnv ? { credentialEnv: config.credentialEnv as string } : {}) });
    }
  }

  /** URLs, environment references, session IDs and credentials never leave this boundary. */
  listConnectors(): Array<{ id: string; configured: boolean; readOnlyTools: string[] }> {
    return [...this.connectors.entries()].map(([id, config]) => ({ id,
      configured: !config.credentialEnv || Boolean(this.env[config.credentialEnv]), readOnlyTools: [...config.readOnlyTools] }));
  }

  discover(connectorId: string, signal?: AbortSignal): Promise<PluginMcpTool[]> {
    return this.operation(connectorId, signal, (runtime) => this.listTools(runtime));
  }

  call(connectorId: string, toolName: string, args: unknown, signal?: AbortSignal): Promise<PluginMcpReceipt> {
    const config = this.connectors.get(connectorId);
    if (!config?.readOnlyTools.includes(toolName)) return Promise.reject(new PluginMcpError('tool_not_allowed', 'MCP tool is not in the server read-only allowlist'));
    if (!record(args)) return Promise.reject(new PluginMcpError('invalid_arguments', 'MCP tool arguments must be a JSON object'));
    let cleanArgs: PluginMcpJson;
    try { cleanArgs = safeJson(args); stringify(cleanArgs); } catch (error) { return Promise.reject(error); }
    return this.operation(connectorId, signal, async (runtime) => {
      // Discover on every call so a changed remote declaration cannot retain an
      // earlier read-only permission. This is intentionally not a schema cache.
      const tools = await this.listTools(runtime);
      if (!tools.some((tool) => tool.name === toolName)) return bad('tool_not_read_only', 'MCP tool must also declare readOnlyHint=true and must not declare destructiveHint=true');
      const result = await this.rpc(runtime, 'tools/call', { name: toolName, arguments: cleanArgs });
      if (!record(result) || !Array.isArray(result.content)
        || result.content.some((block) => !record(block) || typeof block.type !== 'string')
        || result.structuredContent !== undefined && !record(result.structuredContent)
        || result.isError !== undefined && typeof result.isError !== 'boolean') return bad('invalid_response', 'MCP tools/call result is invalid');
      const isError = result.isError === true;
      return { connectorId, toolName, status: isError ? 'failed' : 'succeeded', isError,
        content: safeJson(result.content, runtime.credential) as PluginMcpJson[],
        ...(result.structuredContent === undefined ? {} : { structuredContent: safeJson(result.structuredContent, runtime.credential) }) };
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.active) controller.abort();
    await Promise.all([...this.agents].map((agent) => agent.destroy().catch(() => {})));
  }

  private async operation<T>(id: string, signal: AbortSignal | undefined, work: (runtime: Runtime) => Promise<T>): Promise<T> {
    if (this.disposed) return bad('disposed', 'MCP client has been disposed');
    const config = this.connectors.get(id);
    if (!config) return bad('connector_not_found', 'MCP connector is not configured');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    this.active.add(controller);
    let runtime: Runtime | undefined;
    try {
      runtime = await this.runtime(id, config, controller.signal);
      await this.initialize(runtime);
      return await work(runtime);
    } catch (error) {
      if (controller.signal.aborted) return bad(timedOut ? 'timeout' : 'aborted', timedOut ? 'MCP operation timed out' : 'MCP operation was cancelled');
      if (error instanceof PluginMcpError) throw error;
      // Never expose remote body text, URL, transport errors or env values.
      return bad('transport_failed', 'MCP connector request failed');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.active.delete(controller);
      if (runtime) await this.close(runtime);
    }
  }

  private async runtime(id: string, config: PluginMcpConnectorConfig, signal: AbortSignal): Promise<Runtime> {
    if (signal.aborted) return bad('aborted', 'MCP operation was cancelled');
    const url = validateUrl(config.url, this.privateHosts);
    const host = hostOf(url);
    const addresses = host === 'localhost' ? [{ address: '127.0.0.1', family: 4 }]
      : isIP(host) ? [{ address: host, family: isIP(host) }]
        : await abortable(lookup(host, { all: true, verbatim: true }), signal);
    if (!addresses.length || addresses.some((item) => privateAddress(item.address) && !loopback(host) && !this.privateHosts.has(host))) {
      return bad('private_destination', 'MCP DNS resolved to a destination outside the server allowlist');
    }
    const credential = config.credentialEnv ? this.env[config.credentialEnv] : undefined;
    if (config.credentialEnv && (!credential || /[\r\n]/.test(credential) || credential.length > 8192)) return bad('credential_unavailable', 'MCP connector credential is unavailable');
    // Pin vetted DNS answers into this operation's dispatcher; fetch cannot
    // perform a second lookup that a rebinding domain could redirect privately.
    const agent = new Agent({ connect: { lookup: (_hostname, options, callback) => {
      const selected = addresses.filter((item) => !options.family || item.family === options.family);
      if (!selected.length) { callback(new Error('MCP address family unavailable'), '', 4); return; }
      if (options.all) callback(null, selected);
      else callback(null, selected[0]!.address, selected[0]!.family);
    } } });
    this.agents.add(agent);
    return { id, config, url, agent, signal, credential };
  }

  private headers(runtime: Runtime): Record<string, string> {
    return { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(runtime.version ? { 'MCP-Protocol-Version': runtime.version } : {}),
      ...(runtime.sessionId ? { 'MCP-Session-Id': runtime.sessionId } : {}),
      ...(runtime.credential ? { authorization: `Bearer ${runtime.credential}` } : {}) };
  }

  private async initialize(runtime: Runtime): Promise<void> {
    const result = await this.rpc(runtime, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'd-obs-plugin-host', version: '1.0.0' } });
    if (!record(result) || typeof result.protocolVersion !== 'string' || !VERSIONS.has(result.protocolVersion)) return bad('unsupported_protocol', 'MCP server negotiated an unsupported protocol revision');
    if (!record(result.capabilities) || !record(result.capabilities.tools)) return bad('tools_unavailable', 'MCP server did not advertise tools capability');
    runtime.version = result.protocolVersion;
    const response = await this.post(runtime, { jsonrpc: '2.0', method: 'notifications/initialized' });
    try {
      if (response.status !== 202) return bad('invalid_response', 'MCP initialized notification was not accepted');
    } finally { await response.body?.cancel(); }
  }

  private async listTools(runtime: Runtime): Promise<PluginMcpTool[]> {
    const tools: PluginMcpTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let count = 0;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.rpc(runtime, 'tools/list', cursor ? { cursor } : {});
      if (!record(result) || !Array.isArray(result.tools)) return bad('invalid_response', 'MCP tools/list result is invalid');
      count += result.tools.length;
      if (count > MAX_TOOLS) return bad('too_many_tools', 'MCP tool list exceeds the limit');
      for (const tool of result.tools) {
        if (!record(tool) || typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name) || names.has(tool.name)) return bad('invalid_response', 'MCP tool names must be valid and unique');
        names.add(tool.name);
        if (!runtime.config.readOnlyTools.includes(tool.name) || !record(tool.annotations)
          || tool.annotations.readOnlyHint !== true || tool.annotations.destructiveHint === true) continue;
        if (!record(tool.inputSchema) || tool.inputSchema.type !== 'object' || hasExternalReference(tool.inputSchema)) return bad('invalid_response', 'MCP input schema must describe an object without external references');
        tools.push({ name: tool.name, ...(typeof tool.description === 'string' ? { description: safeJson(tool.description, runtime.credential) as string } : {}),
          inputSchema: safeJson(tool.inputSchema, runtime.credential) as PluginMcpTool['inputSchema'], annotations: { readOnlyHint: true } });
      }
      if (result.nextCursor === undefined) return tools;
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 4096 || cursors.has(result.nextCursor)) return bad('invalid_pagination', 'MCP pagination cursor is invalid or repeated');
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    return bad('too_many_pages', 'MCP pagination exceeds the page limit');
  }

  private async post(runtime: Runtime, payload: unknown): Promise<Response> {
    const response = await abortable(this.fetchImpl(runtime.url, { method: 'POST', headers: this.headers(runtime),
      body: stringify(payload), signal: runtime.signal, redirect: 'manual', dispatcher: runtime.agent } as RequestInit & { dispatcher: Agent }), runtime.signal);
    if (!response.ok) {
      await response.body?.cancel();
      return bad(response.status === 404 && runtime.sessionId ? 'session_expired'
        : response.status >= 300 && response.status < 400 ? 'redirect_rejected' : 'http_error', `MCP server returned HTTP ${response.status}`);
    }
    return response;
  }

  private async rpc(runtime: Runtime, method: string, params: unknown, retried = false): Promise<unknown> {
    const id = ++this.nextId;
    let response: Response;
    try { response = await this.post(runtime, { jsonrpc: '2.0', id, method, params }); }
    catch (error) {
      if (error instanceof PluginMcpError && error.code === 'session_expired' && method !== 'initialize' && !retried) {
        runtime.sessionId = undefined;
        runtime.version = undefined;
        await this.initialize(runtime);
        return this.rpc(runtime, method, params, true);
      }
      throw error;
    }
    if (method === 'initialize') {
      const sessionId = response.headers.get('MCP-Session-Id');
      if (sessionId !== null) {
        if (!/^[\x21-\x7e]{1,512}$/.test(sessionId)) { await response.body?.cancel(); return bad('invalid_session', 'MCP server session header is invalid'); }
        runtime.sessionId = sessionId;
      }
    }
    const message = await this.readMessage(response, id, runtime.signal);
    if ('error' in message) return bad('rpc_error', 'MCP server returned a JSON-RPC error');
    return message.result;
  }

  private async readMessage(response: Response, id: number, signal: AbortSignal): Promise<Record<string, unknown>> {
    const media = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (media !== 'application/json' && media !== 'text/event-stream') { await response.body?.cancel(); return bad('invalid_response', 'MCP response content type is unsupported'); }
    if (!response.body) return bad('invalid_response', 'MCP server response body is empty');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    const parse = (raw: string): Record<string, unknown> | undefined => {
      let value: unknown;
      try { value = JSON.parse(raw); } catch { return bad('invalid_response', 'MCP server returned invalid JSON'); }
      if (!record(value) || value.jsonrpc !== '2.0') return bad('invalid_response', 'MCP server returned an invalid JSON-RPC message');
      if ('method' in value) {
        if (!('id' in value) && typeof value.method === 'string' && value.method.startsWith('notifications/')) return undefined;
        return bad('unsupported_server_request', 'MCP server-initiated requests are not supported');
      }
      if (value.id !== id || ('result' in value) === ('error' in value)) return bad('response_id_mismatch', 'MCP response does not match the request');
      return value;
    };
    try {
      for (;;) {
        const chunk = await abortable(reader.read(), signal);
        if (chunk.value) {
          bytes += chunk.value.byteLength;
          if (bytes > MAX_BYTES) return bad('response_too_large', 'MCP response exceeds the size limit');
          text += decoder.decode(chunk.value, { stream: true });
        }
        if (chunk.done) text += decoder.decode();
        if (media === 'text/event-stream') {
          // Normalize line endings only after a full line arrived; retaining a
          // trailing CR avoids splitting CRLF across transport chunks.
          text = text.replace(/\r\n/g, '\n').replace(/\r(?!$)/g, '\n');
          if (chunk.done) text = text.replace(/\r/g, '\n');
          let boundary: number;
          while ((boundary = text.indexOf('\n\n')) >= 0) {
            const event = text.slice(0, boundary);
            text = text.slice(boundary + 2);
            const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
            if (data) { const message = parse(data); if (message) return message; }
          }
        }
        if (chunk.done) {
          if (media === 'application/json') { const message = parse(text); if (message) return message; }
          return bad('incomplete_response', 'MCP stream ended without a matching response');
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  private async close(runtime: Runtime): Promise<void> {
    if (runtime.sessionId && !runtime.signal.aborted) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 1000));
      try {
        const response = await abortable(this.fetchImpl(runtime.url, { method: 'DELETE', headers: this.headers(runtime), signal: controller.signal,
          redirect: 'manual', dispatcher: runtime.agent } as RequestInit & { dispatcher: Agent }), controller.signal);
        await response.body?.cancel();
      } catch { /* Session cleanup is best effort; never return transport/credential details. */ }
      finally { clearTimeout(timer); }
    }
    runtime.credential = undefined;
    runtime.sessionId = undefined;
    await runtime.agent.destroy().catch(() => {});
    this.agents.delete(runtime.agent);
  }
}
