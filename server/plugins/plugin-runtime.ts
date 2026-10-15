import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PluginError, pluginManifestSchema, type JsonSchema, type PluginDetail, type PluginExecutionContext,
  type PluginManifest, type PluginPackage, type PluginPublication, type PluginQueryResult, type PluginReceipt,
  type PluginSummary, type PluginToolResult, type PluginWorkflowResult } from './plugin-types.js';

const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const CREDENTIAL_KEYS = new Set(['password', 'apikey', 'authorization', 'cookie', 'secret', 'credentials', 'accesstoken', 'refreshtoken', 'clientsecret', 'bearertoken']);
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 128 * 1024;
const schemaKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'description', 'default']);
export type PluginLifecycleEvent = { id: string; pluginId: string; action: string; revision: number; version: string | null; at: string; ownerKey: string };
type State = { plugins: Record<string, PluginDetail>; events: PluginLifecycleEvent[] };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fail(code: string, status = 400, message?: string): never { throw new PluginError(code, status, message); }

/** Publication equivalence only; persisted bytes and immutable history keep their original order. */
function canonicalPublicationJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPublicationJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalPublicationJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function assertJson(value: unknown, depth = 0): void {
  if (depth > 16) fail('plugin_json_too_deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { if (value.length > 10000) fail('plugin_json_too_large'); value.forEach((v) => assertJson(v, depth + 1)); return; }
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('plugin_invalid_json');
  for (const [key, entry] of Object.entries(value)) { if (RESERVED.has(key)) fail('plugin_unsafe_key'); assertJson(entry, depth + 1); }
}
function assertNoCredentials(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(assertNoCredentials); return; }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (CREDENTIAL_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''))) fail('plugin_inline_credential_denied', 400, '插件资源不接受内联凭据；连接器身份由服务端环境配置。');
    assertNoCredentials(entry);
  }
}

function validateSchema(value: JsonSchema, depth = 0): void {
  if (depth > 8 || !isRecord(value) || Object.keys(value).some((key) => !schemaKeys.has(key))) fail('plugin_invalid_schema');
  if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(value.type)) fail('plugin_invalid_schema');
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 2000)) fail('plugin_invalid_schema');
  if (value.properties !== undefined) {
    if (value.type !== 'object' || !isRecord(value.properties) || Object.keys(value.properties).length > 64) fail('plugin_invalid_schema');
    for (const [key, entry] of Object.entries(value.properties)) {
      if (RESERVED.has(key) || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(key)) fail('plugin_invalid_schema');
      validateSchema(entry, depth + 1);
    }
  }
  if (value.required !== undefined && (value.type !== 'object' || !Array.isArray(value.required) || value.required.length > 64 ||
    value.required.some((key) => typeof key !== 'string' || !Object.hasOwn(value.properties ?? {}, key)) || new Set(value.required).size !== value.required.length)) fail('plugin_invalid_schema');
  if (value.additionalProperties !== undefined) {
    if (value.type !== 'object') fail('plugin_invalid_schema');
    if (typeof value.additionalProperties !== 'boolean') validateSchema(value.additionalProperties, depth + 1);
  }
  if (value.items !== undefined) { if (value.type !== 'array') fail('plugin_invalid_schema'); validateSchema(value.items, depth + 1); }
  if (value.type === 'array' && !value.items) fail('plugin_invalid_schema');
  if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 128)) fail('plugin_invalid_schema');
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    const n = value[key]; if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || ((key.includes('Length') || key.includes('Items')) && (!Number.isInteger(n) || n < 0 || n > 10000)))) fail('plugin_invalid_schema');
  }
  if ((value.minimum ?? -Infinity) > (value.maximum ?? Infinity) || (value.minLength ?? 0) > (value.maxLength ?? Infinity) ||
    (value.minItems ?? 0) > (value.maxItems ?? Infinity)) fail('plugin_invalid_schema');
  assertJson(value);
}

function validateValue(schema: JsonSchema, value: unknown, location = '$'): void {
  const typeMatches = schema.type === 'null' ? value === null : schema.type === 'array' ? Array.isArray(value)
    : schema.type === 'object' ? isRecord(value) : schema.type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
    : typeof value === schema.type;
  if (!typeMatches || (schema.enum && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value)))) fail('plugin_schema_validation_failed', 400, `配置或参数不符合类型：${location}`);
  if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) fail('plugin_schema_validation_failed', 400, `数值超出范围：${location}`);
  if (typeof value === 'string' && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity))) fail('plugin_schema_validation_failed', 400, `文本长度超出范围：${location}`);
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) fail('plugin_schema_validation_failed');
    value.forEach((entry, index) => validateValue(schema.items!, entry, `${location}[${index}]`));
  }
  if (isRecord(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail('plugin_schema_validation_failed', 400, `缺少字段：${location}.${key}`);
    for (const [key, entry] of Object.entries(value)) {
      const property = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (property) validateValue(property, entry, `${location}.${key}`);
      else if (schema.additionalProperties === false) fail('plugin_schema_validation_failed', 400, `未知字段：${location}.${key}`);
      else if (isRecord(schema.additionalProperties)) validateValue(schema.additionalProperties as JsonSchema, entry, `${location}.${key}`);
    }
  }
}

function validatePath(value: string | undefined): void {
  if (value !== undefined && value !== '' && (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(value) || value.split('.').some((key) => RESERVED.has(key)))) fail('plugin_invalid_result_path');
}
function select(value: unknown, selection?: string): unknown {
  if (!selection) return value;
  validatePath(selection);
  for (const key of selection.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
function substitute(value: unknown, config: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const match = /^\$\{config\.([A-Za-z0-9_.-]+)\}$/.exec(value);
    if (match) { validatePath(match[1]); const resolved = select(config, match[1]); if (resolved === undefined) fail('plugin_missing_config_reference'); return clone(resolved); }
    if (value.includes('${')) fail('plugin_invalid_config_reference');
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, config));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry, config)]));
  return value;
}
function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((key) => [key,
    Object.hasOwn(b, key) ? isRecord(a[key]) && isRecord(b[key]) ? merge(a[key], b[key]) : b[key] : a[key]]));
}

export function validatePluginPackage(manifestInput: unknown, configInput: unknown = {}): PluginPackage {
  assertJson(manifestInput); assertJson(configInput);
  assertNoCredentials(manifestInput); assertNoCredentials(configInput);
  if (Buffer.byteLength(JSON.stringify({ manifest: manifestInput, config: configInput })) > MAX_PACKAGE_BYTES) fail('plugin_package_too_large', 413);
  const parsed = pluginManifestSchema.safeParse(manifestInput);
  if (!parsed.success) fail('plugin_invalid_manifest', 400, parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 1500));
  const manifest = parsed.data;
  if (!isRecord(configInput)) fail('plugin_invalid_config');
  if (manifest.configSchema.type !== 'object') fail('plugin_invalid_config_schema');
  validateSchema(manifest.configSchema); validateValue(manifest.configSchema, configInput);
  for (const list of [manifest.dependencies, manifest.tools, manifest.dataSources, manifest.panels, manifest.workflows, manifest.prompts]) {
    if (new Set(list.map((item) => item.id)).size !== list.length) fail('plugin_duplicate_id');
  }
  if (manifest.dependencies.some((dependency) => dependency.id === manifest.id)) fail('plugin_dependency_cycle');
  const tools = new Set(manifest.tools.map((tool) => tool.id)); const sources = new Set(manifest.dataSources.map((source) => source.id));
  for (const tool of manifest.tools) {
    if (tool.inputSchema.type !== 'object') fail('plugin_invalid_input_schema'); validateSchema(tool.inputSchema);
    if (tool.source.type === 'platform' && (!/^GET \/api\/ops\/observability\/[A-Za-z0-9_:/-]+$/.test(tool.source.operationId) ||
      /^GET \/api\/ops\/observability\/(?:plugins|assistant|remediate)(?:\/|$)/.test(tool.source.operationId) || /\/(?:mcp|stream)$/.test(tool.source.operationId))) fail('plugin_write_tool_denied', 403);
    substitute(tool.defaults ?? {}, configInput);
  }
  for (const source of manifest.dataSources) { if (!tools.has(source.toolId)) fail('plugin_unknown_tool'); validatePath(source.resultPath); substitute(source.args ?? {}, configInput); }
  for (const panel of manifest.panels) { if (!sources.has(panel.dataSourceId)) fail('plugin_unknown_data_source'); validatePath(panel.valuePath); for (const column of panel.columns ?? []) validatePath(column.key); }
  for (const workflow of manifest.workflows) for (const step of workflow.steps) { if (!tools.has(step.toolId)) fail('plugin_unknown_tool'); substitute(step.args ?? {}, configInput); }
  return clone({ manifest, config: configInput });
}

/** A declarative plugin host. Each operation receives its caller's guarded adapters. */
export class PluginRuntime {
  private readonly stateDir: string;
  private readonly builtins: PluginPackage[];
  private readonly running = new Map<string, Set<AbortController>>();
  private disposed = false;
  constructor(options: { stateDir: string; builtins?: PluginPackage[] }) {
    this.stateDir = path.resolve(options.stateDir); this.builtins = (options.builtins ?? []).map((item) => validatePluginPackage(item.manifest, item.config));
    if (new Set(this.builtins.map((item) => item.manifest.id)).size !== this.builtins.length) fail('plugin_duplicate_template');
  }
  private ownerKey(owner: string): string {
    if (typeof owner !== 'string' || !owner.trim() || owner.length > 512 || /[\x00-\x1f\x7f]/.test(owner)) fail('plugin_invalid_owner');
    return hash(owner);
  }
  private assertOpen(): void { if (this.disposed) fail('plugin_runtime_disposed', 503); }
  private directory(owner: string): string { return path.join(this.stateDir, this.ownerKey(owner)); }
  private async ensureDirectory(directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('plugin_unsafe_state_path', 500);
    await fs.chmod(directory, 0o700);
  }
  private async read(owner: string): Promise<State> {
    this.assertOpen(); const filename = path.join(this.directory(owner), 'state.json');
    let raw: string;
    try {
      const stat = await fs.lstat(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) fail('plugin_state_corrupt', 503);
      raw = await fs.readFile(filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try { await fs.lstat(path.join(this.directory(owner), 'state.previous.json')); }
        catch (previousError) { if ((previousError as NodeJS.ErrnoException).code === 'ENOENT') return { plugins: {}, events: [] }; throw previousError; }
        return fail('plugin_state_corrupt', 503, '当前插件状态缺失，已保留上一份状态；禁止重置。');
      }
      throw error;
    }
    try {
      const envelope = JSON.parse(raw);
      if (envelope.schemaVersion !== 1 || envelope.ownerKey !== this.ownerKey(owner) || typeof envelope.payload !== 'string' || envelope.checksum !== hash(envelope.payload)) throw new Error('checksum');
      const state: State = JSON.parse(envelope.payload); assertJson(state);
      if (!isRecord(state.plugins) || Object.keys(state.plugins).length > 32 || !Array.isArray(state.events) || state.events.length > 200 ||
        state.events.some((entry) => !entry.id || !entry.pluginId || !entry.action || !Number.isSafeInteger(entry.revision) || !entry.at || entry.ownerKey !== this.ownerKey(owner))) throw new Error('shape');
      for (const [id, item] of Object.entries(state.plugins)) {
        if (item.id !== id || !Number.isSafeInteger(item.revision) || item.revision < 1 || typeof item.enabled !== 'boolean' ||
          !Array.isArray(item.history) || item.history.length > 20 || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string') throw new Error('record');
        if (item.draft) { const checked = validatePluginPackage(item.draft.manifest, item.draft.config); if (checked.manifest.id !== id) throw new Error('id'); }
        if (item.published && (!item.history.some((entry) => JSON.stringify(entry) === JSON.stringify(item.published)))) throw new Error('history');
        if (!item.published && item.enabled) throw new Error('activation');
        const versions = new Set<string>();
        for (const publication of item.history) { const checked = validatePluginPackage(publication.manifest, publication.config); if (checked.manifest.id !== id || !publication.publishedAt || versions.has(checked.manifest.version)) throw new Error('history'); versions.add(checked.manifest.version); }
      }
      this.validateGraph(state); return state;
    } catch { return fail('plugin_state_corrupt', 503, '插件状态校验失败；已保留原文件与上一份状态，禁止覆盖。'); }
  }
  private async lock<T>(owner: string, task: () => Promise<T>): Promise<T> {
    this.assertOpen(); const directory = this.directory(owner); await this.ensureDirectory(this.stateDir); await this.ensureDirectory(directory);
    const lockDirectory = path.join(directory, '.lock'); let acquired = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await fs.mkdir(lockDirectory, { mode: 0o700 }); acquired = true; await fs.writeFile(path.join(lockDirectory, 'holder.json'), JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600, flag: 'wx' }); break; }
      catch (error) {
        if (acquired) { await fs.rm(lockDirectory, { recursive: true, force: true }); throw error; }
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const stat = await fs.lstat(lockDirectory); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('plugin_unsafe_state_path', 500);
          const holder = JSON.parse(await fs.readFile(path.join(lockDirectory, 'holder.json'), 'utf8'));
          if (Number.isInteger(holder.pid) && Date.now() - Number(holder.at) > 30_000) {
            try { process.kill(holder.pid, 0); } catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { await fs.rm(lockDirectory, { recursive: true, force: true }); continue; } }
          }
        } catch (probe) { if (probe instanceof PluginError) throw probe; /* A new holder can still be writing its metadata. */ }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (!acquired) fail('plugin_state_busy', 409);
    try { this.assertOpen(); return await task(); } finally { await fs.rm(lockDirectory, { recursive: true, force: true }); }
  }
  private async write(owner: string, state: State): Promise<void> {
    const directory = this.directory(owner); const payload = JSON.stringify(state);
    const raw = JSON.stringify({ schemaVersion: 1, ownerKey: this.ownerKey(owner), checksum: hash(payload), payload });
    if (Buffer.byteLength(raw) > MAX_STATE_BYTES) fail('plugin_state_quota_exceeded', 413);
    const filename = path.join(directory, 'state.json'); const temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
    const atomic = async (destination: string, value: string) => {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(value, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, destination);
    };
    try {
      try { const previous = await fs.readFile(filename, 'utf8'); await atomic(path.join(directory, 'state.previous.json'), previous); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await atomic(filename, raw);
      const directoryHandle = await fs.open(directory, 'r'); try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } finally { await fs.rm(temporary, { force: true }); }
  }
  private validateGraph(state: State): void {
    const active = Object.values(state.plugins).filter((item) => item.enabled && item.published);
    for (const item of active) for (const dependency of item.published!.manifest.dependencies) {
      const target = state.plugins[dependency.id];
      if (!target?.enabled || !target.published) fail('plugin_dependency_missing', 409, `需要启用依赖 ${dependency.id}@${dependency.version}`);
      if (target.published.manifest.version !== dependency.version) fail('plugin_dependency_version_conflict', 409, `依赖版本不兼容：${dependency.id}@${dependency.version}`);
    }
    const seen = new Set<string>(); const stack = new Set<string>();
    const visit = (id: string) => {
      if (stack.has(id)) fail('plugin_dependency_cycle', 409); if (seen.has(id)) return; stack.add(id);
      for (const dependency of state.plugins[id]?.published?.manifest.dependencies ?? []) if (state.plugins[dependency.id]?.enabled) visit(dependency.id);
      stack.delete(id); seen.add(id);
    };
    active.forEach((item) => visit(item.id));
  }
  private item(state: State, id: string): PluginDetail { if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) fail('plugin_invalid_id'); const item = state.plugins[id]; if (!item) fail('plugin_not_found', 404); return item; }
  private cas(item: PluginDetail, expectedRevision: unknown): void { if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== item.revision) fail('plugin_revision_conflict', 409, '插件已变化，请刷新后重试。'); }
  private abort(owner: string, id: string): void { for (const controller of this.running.get(`${this.ownerKey(owner)}:${id}`) ?? []) controller.abort(new PluginError('plugin_execution_interrupted', 409)); }
  private event(owner: string, state: State, item: PluginDetail, action: string): void {
    state.events.push({ id: randomUUID(), pluginId: item.id, action, revision: item.revision,
      version: item.published?.manifest.version ?? item.draft?.manifest.version ?? null, at: item.updatedAt, ownerKey: this.ownerKey(owner) });
    if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
  }
  private async mutate(owner: string, id: string, expectedRevision: number, task: (item: PluginDetail, state: State) => void, action: string, interrupt = false): Promise<PluginDetail> {
    return this.lock(owner, async () => {
      const state = await this.read(owner); const item = this.item(state, id); this.cas(item, expectedRevision); task(item, state);
      item.revision++; item.updatedAt = new Date().toISOString(); this.validateGraph(state); this.event(owner, state, item, action); await this.write(owner, state);
      if (interrupt) this.abort(owner, id); return clone(item);
    });
  }
  async catalog(owner: string): Promise<{ plugins: PluginSummary[]; templates: PluginPackage[]; events: PluginLifecycleEvent[] }> {
    const state = await this.read(owner);
    return { plugins: Object.values(state.plugins).map((item) => {
      const manifest = item.published?.manifest ?? item.draft!.manifest;
      return { id: item.id, revision: item.revision, enabled: item.enabled, createdAt: item.createdAt, updatedAt: item.updatedAt,
        label: manifest.label, description: manifest.description, version: item.published?.manifest.version ?? null,
        draftVersion: item.draft?.manifest.version ?? null, hasDraft: !!item.draft,
        tools: manifest.tools.length, dataSources: manifest.dataSources.length, panels: manifest.panels.length, workflows: manifest.workflows.length };
    }).sort((a, b) => a.label.localeCompare(b.label)), templates: clone(this.builtins), events: clone(state.events) };
  }
  async detail(owner: string, id: string): Promise<PluginDetail> { return clone(this.item(await this.read(owner), id)); }
  private validateAdapters(pack: PluginPackage, ctx?: PluginExecutionContext): void {
    if (!ctx) return;
    for (const tool of pack.manifest.tools) {
      if (tool.source.type === 'platform' && !ctx.canExecutePlatform(tool.source.operationId)) fail('plugin_operation_denied', 403, `当前身份无法读取：${tool.source.operationId}`);
      if (tool.source.type === 'mcp' && (!ctx.executeMcp || !ctx.canExecuteMcp?.(tool.source.connectorId, tool.source.toolName))) fail('plugin_mcp_tool_denied', 403, `外部 MCP 未开放只读工具：${tool.source.connectorId}/${tool.source.toolName}`);
    }
  }
  async validate(owner: string, id: string, ctx?: PluginExecutionContext): Promise<{ valid: true; id: string; version: string; tools: number; dataSources: number; panels: number; workflows: number }> {
    const state = await this.read(owner); const item = this.item(state, id); const pack = item.draft ?? item.published;
    if (!pack) fail('plugin_no_draft', 409); this.validateAdapters(pack, ctx);
    item.published = { ...pack, publishedAt: item.published?.publishedAt ?? new Date().toISOString() }; item.enabled = true; this.validateGraph(state);
    return { valid: true, id, version: pack.manifest.version, tools: pack.manifest.tools.length, dataSources: pack.manifest.dataSources.length, panels: pack.manifest.panels.length, workflows: pack.manifest.workflows.length };
  }
  async saveDraft(owner: string, input: { manifest: unknown; config?: unknown; expectedRevision?: number }): Promise<PluginDetail> {
    const pack = validatePluginPackage(input.manifest, input.config ?? {});
    return this.lock(owner, async () => {
      const state = await this.read(owner); let item = state.plugins[pack.manifest.id];
      if (item) { this.cas(item, input.expectedRevision); item.draft = pack; item.revision++; item.updatedAt = new Date().toISOString(); }
      else {
        if (input.expectedRevision !== undefined && input.expectedRevision !== 0) fail('plugin_revision_conflict', 409);
        if (Object.keys(state.plugins).length >= 32) fail('plugin_install_quota_exceeded', 413);
        const now = new Date().toISOString(); item = { id: pack.manifest.id, revision: 1, enabled: false, draft: pack, published: null, history: [], createdAt: now, updatedAt: now }; state.plugins[item.id] = item;
      }
      this.event(owner, state, item, 'draft_saved'); await this.write(owner, state); return clone(item);
    });
  }
  async publish(owner: string, id: string, input: { expectedRevision: number }, ctx?: PluginExecutionContext): Promise<PluginDetail> {
    return this.mutate(owner, id, input.expectedRevision, (item) => {
      if (!item.draft) fail('plugin_no_draft', 409);
      this.validateAdapters(item.draft, ctx);
      const previous = item.history.find((entry) => entry.manifest.version === item.draft!.manifest.version);
      if (previous && canonicalPublicationJson({ manifest: previous.manifest, config: previous.config }) !== canonicalPublicationJson(item.draft)) fail('plugin_version_exists', 409, '此版本已发布且不可修改，请提升 manifest.version。');
      if (!previous && item.history.length >= 20) fail('plugin_history_quota_exceeded', 413);
      const publication: PluginPublication = previous ?? { ...clone(item.draft), publishedAt: new Date().toISOString() };
      if (!previous) item.history.push(publication); item.published = publication; item.draft = null; item.enabled = true;
    }, 'published', true);
  }
  async setEnabled(owner: string, id: string, input: { enabled: boolean; expectedRevision: number }): Promise<PluginDetail> {
    if (typeof input.enabled !== 'boolean') fail('plugin_invalid_enabled');
    return this.mutate(owner, id, input.expectedRevision, (item) => { if (input.enabled && !item.published) fail('plugin_not_published', 409); item.enabled = input.enabled; }, input.enabled ? 'enabled' : 'disabled', true);
  }
  async rollback(owner: string, id: string, input: { version: string; expectedRevision: number }): Promise<PluginDetail> {
    return this.mutate(owner, id, input.expectedRevision, (item) => {
      const previous = item.history.find((entry) => entry.manifest.version === input.version); if (!previous) fail('plugin_version_not_found', 404);
      item.published = clone(previous); item.enabled = true;
    }, 'rolled_back', true);
  }
  async uninstall(owner: string, id: string, input: { expectedRevision: number }): Promise<{ id: string; uninstalled: true }> {
    return this.lock(owner, async () => { const state = await this.read(owner); const item = this.item(state, id); this.cas(item, input.expectedRevision); delete state.plugins[id]; this.validateGraph(state); item.revision++; item.updatedAt = new Date().toISOString(); this.event(owner, state, item, 'uninstalled'); await this.write(owner, state); this.abort(owner, id); return { id, uninstalled: true }; });
  }
  private async execute<T>(owner: string, id: string, ctx: PluginExecutionContext, task: (publication: PluginPublication, signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertOpen(); const key = `${this.ownerKey(owner)}:${id}`; const controller = new AbortController();
    const snapshot = await this.lock(owner, async () => {
      const item = this.item(await this.read(owner), id); if (!item.enabled || !item.published) fail('plugin_disabled', 409);
      this.assertOpen(); if (ctx.signal?.aborted) fail('plugin_execution_interrupted', 409);
      let running = this.running.get(key); if (!running) { running = new Set(); this.running.set(key, running); }
      if (running.size >= 8 || [...this.running.values()].reduce((n, entry) => n + entry.size, 0) >= 128) fail('plugin_execution_busy', 429);
      running.add(controller); return { publication: clone(item.published), controllers: running };
    });
    const { publication, controllers } = snapshot; const timeoutMs = Math.max(50, Math.min(ctx.timeoutMs ?? 30_000, 60_000));
    const timer = setTimeout(() => controller.abort(new PluginError('plugin_execution_timeout', 504)), timeoutMs);
    const onAbort = () => controller.abort(new PluginError('plugin_execution_interrupted', 409));
    ctx.signal?.addEventListener('abort', onAbort, { once: true }); if (ctx.signal?.aborted) onAbort();
    const watcher = setInterval(() => { void this.read(owner).then((state) => {
      const current = state.plugins[id]; if (!current?.enabled || !current.published || JSON.stringify(current.published) !== JSON.stringify(publication)) onAbort();
    }).catch(() => onAbort()); }, 250); watcher.unref();
    let onExecutionAbort: (() => void) | undefined;
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const interrupted = new Promise<never>((_, reject) => { onExecutionAbort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', onExecutionAbort, { once: true }); });
      return await Promise.race([task(publication, controller.signal), interrupted]);
    } finally {
      clearTimeout(timer); clearInterval(watcher); ctx.signal?.removeEventListener('abort', onAbort);
      if (onExecutionAbort) controller.signal.removeEventListener('abort', onExecutionAbort);
      controllers.delete(controller); if (!controllers.size) this.running.delete(key);
    }
  }
  private async invoke(publication: PluginPublication, toolId: string, args: Record<string, unknown>, ctx: PluginExecutionContext, signal: AbortSignal): Promise<PluginToolResult> {
    if (signal.aborted) throw signal.reason;
    const tool = publication.manifest.tools.find((entry) => entry.id === toolId); if (!tool) fail('plugin_tool_not_found', 404);
    assertJson(args); assertNoCredentials(args); if (!isRecord(args) || Buffer.byteLength(JSON.stringify(args)) > 32768) fail('plugin_invalid_arguments');
    const input = merge(substitute(tool.defaults ?? {}, publication.config) as Record<string, unknown>, args); validateValue(tool.inputSchema, input);
    const start = Date.now(); const startedAt = new Date(start).toISOString(); let data: unknown;
    if (tool.source.type === 'platform') {
      if (!ctx.canExecutePlatform(tool.source.operationId)) fail('plugin_operation_denied', 403);
      data = await ctx.executePlatform(tool.source.operationId, input, signal);
    } else {
      if (!ctx.executeMcp || !ctx.canExecuteMcp?.(tool.source.connectorId, tool.source.toolName)) fail('plugin_mcp_tool_denied', 403);
      data = await ctx.executeMcp(tool.source.connectorId, tool.source.toolName, input, signal);
    }
    if (signal.aborted) throw signal.reason;
    if (isRecord(data) && data.ok === false) fail('plugin_adapter_failed', Number.isInteger(data.status) && Number(data.status) >= 400 && Number(data.status) <= 599 ? Number(data.status) : 502, '数据源返回失败；未生成成功执行凭据。');
    if (data === undefined) data = null;
    assertJson(data); if (Buffer.byteLength(JSON.stringify(data)) > MAX_RESULT_BYTES) fail('plugin_result_too_large', 413);
    const completed = Date.now(); const receipt: PluginReceipt = { id: randomUUID(), startedAt, completedAt: new Date(completed).toISOString(), durationMs: completed - start, source: clone(tool.source) };
    return { pluginId: publication.manifest.id, version: publication.manifest.version, toolId, data: clone(data), receipt };
  }
  async callTool(owner: string, id: string, toolId: string, args: Record<string, unknown>, ctx: PluginExecutionContext): Promise<PluginToolResult> {
    return this.execute(owner, id, ctx, (publication, signal) => this.invoke(publication, toolId, args, ctx, signal));
  }
  async query(owner: string, id: string, dataSourceId: string, args: Record<string, unknown>, ctx: PluginExecutionContext): Promise<PluginQueryResult> {
    return this.execute(owner, id, ctx, async (publication, signal) => {
      const source = publication.manifest.dataSources.find((entry) => entry.id === dataSourceId); if (!source) fail('plugin_data_source_not_found', 404);
      assertJson(args); if (!isRecord(args)) fail('plugin_invalid_arguments');
      const result = await this.invoke(publication, source.toolId, merge(substitute(source.args ?? {}, publication.config) as Record<string, unknown>, args), ctx, signal);
      const data = select(result.data, source.resultPath);
      if (data === undefined && source.resultPath) fail('plugin_result_path_missing', 502, `数据源结果不存在配置的字段：${source.resultPath}`);
      return { ...result, dataSourceId, data: data ?? null };
    });
  }
  async runWorkflow(owner: string, id: string, workflowId: string, args: Record<string, unknown>, ctx: PluginExecutionContext): Promise<PluginWorkflowResult> {
    return this.execute(owner, id, ctx, async (publication, signal) => {
      const workflow = publication.manifest.workflows.find((entry) => entry.id === workflowId); if (!workflow) fail('plugin_workflow_not_found', 404);
      assertJson(args); if (!isRecord(args)) fail('plugin_invalid_arguments'); const started = Date.now(); const steps: PluginWorkflowResult['steps'] = [];
      let resultBytes = 0;
      for (const step of workflow.steps) {
        const result = await this.invoke(publication, step.toolId, merge(substitute(step.args ?? {}, publication.config) as Record<string, unknown>, args), ctx, signal);
        resultBytes += Buffer.byteLength(JSON.stringify(result)); if (resultBytes > MAX_RESULT_BYTES) fail('plugin_result_too_large', 413);
        steps.push({ ...result, ...(step.label ? { label: step.label } : {}) });
      }
      return { pluginId: id, version: publication.manifest.version, workflowId, steps,
        receipt: { id: randomUUID(), startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(), durationMs: Date.now() - started,
          source: { type: 'workflow', toolIds: workflow.steps.map((step) => step.toolId) } } };
    });
  }
  dispose(): void { this.disposed = true; for (const controllers of this.running.values()) for (const controller of controllers) controller.abort(new PluginError('plugin_runtime_disposed', 503)); this.running.clear(); }
}

export { PluginError } from './plugin-types.js';
