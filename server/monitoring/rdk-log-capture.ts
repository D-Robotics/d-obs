import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { SshLogCollectorError, type SshLogCollector, type SshLogDeviceProbe, type SshLogRecord, type SshLogSession, type SshLogSource } from './ssh-log-collector.js';

export interface RdkCaptureProfile {
  id: 'x5-isp' | 'runtime';
  version: string;
  label: string;
  description: string;
  maxSources: number;
}
export interface RdkDeviceProbe extends SshLogDeviceProbe {
  id: string;
  expiresAt: string;
  readableSourceIds: string[];
}
export interface RdkCapturePlanInput {
  targetId: string;
  profileId: string;
  question?: string;
  sourceIds?: string[];
}
export interface RdkCaptureStartInput extends RdkCapturePlanInput {
  lines?: number;
  durationSeconds?: number;
}
export interface RdkCapturePlan {
  targetId: string;
  profileId: string;
  profileVersion: string;
  question: string;
  deviceSnapshot: RdkDeviceProbe;
  sources: SshLogSource[];
  warnings: string[];
  ready: boolean;
}
export interface RdkCaptureMarker {
  id: string;
  label: string;
  receivedAt: string;
  positions: { sessionId: string; seq: number }[];
}
export interface RdkCaptureGroup extends RdkCapturePlan {
  id: string;
  startedAt: string;
  endedAt?: string;
  state: 'connecting' | 'running' | 'stopped' | 'completed' | 'failed';
  sessions: SshLogSession[];
  markers: RdkCaptureMarker[];
  error?: string;
}
export interface RdkCaptureBundle {
  contract: 'rdk.log-capture-bundle.v1';
  exportedAt: string;
  manifest: RdkCaptureGroup;
  clockNote: string;
  streams: { session: SshLogSession; records: SshLogRecord[] }[];
}
export interface RdkLogCaptureOptions {
  collector: Pick<SshLogCollector, 'listTargets' | 'probeTarget' | 'start' | 'read' | 'stop'>;
  stateDir: string;
  now?: () => number;
  retentionMs?: number;
  maxGroups?: number;
  maxProbes?: number;
  maxStateBytes?: number;
}

interface Owned<T> { version: 1; actorId: string; value: T }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATE_RESERVE = 65536;
const CLOCK_NOTE = 'receivedAt 是平台收到输出的时间；不同日志源的设备时钟和缓冲区可能不同，不保证跨源严格同步。';
const PROFILES: RdkCaptureProfile[] = [
  { id: 'x5-isp', version: '1.0.0', label: 'X5 摄像头 / ISP', description: '按真实权限选择媒体链路、内核和系统日志，保留完整原文供调查。', maxSources: 3 },
  { id: 'runtime', version: '1.0.0', label: 'RDK 运行日志', description: '采集可读系统、内核和已配置应用日志。', maxSources: 3 },
];

function fail(status: number, code: string, message: string): never { throw new SshLogCollectorError(status, code, message); }
function actor(value: string): void { if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) fail(401, 'invalid_actor', 'An authenticated capture owner is required'); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function clone<T>(value: T): T { return structuredClone(value); }
function bounded(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}
function question(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(400, 'invalid_question', 'question must contain at most 2000 characters');
  return value.replace(/\b(Bearer\s+)[^\s]+/gi, '$1[redacted]').replace(/\b(password|token|api[_-]?key|secret)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]').trim();
}

/** RDK profiles coordinate existing bounded SSH sessions; no device agent or arbitrary shell API. */
export class RdkLogCaptureService {
  private readonly collector: RdkLogCaptureOptions['collector'];
  private readonly stateDir: string;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxGroups: number;
  private readonly maxProbes: number;
  private readonly maxStateBytes: number;
  private readonly groups = new Map<string, Owned<RdkCaptureGroup>>();
  private readonly probes = new Map<string, Owned<RdkDeviceProbe>>();
  private readonly pendingProbes = new Map<string, Promise<RdkDeviceProbe>>();
  private readonly activeStarts = new Set<string>();
  private readonly stoppingGroups = new Set<string>();
  private readonly monitors = new Map<string, NodeJS.Timeout>();
  private disposed = false;

  constructor(options: RdkLogCaptureOptions) {
    this.collector = options.collector;
    this.stateDir = options.stateDir;
    this.now = options.now ?? Date.now;
    this.retentionMs = bounded(options.retentionMs, 24 * 60 * 60 * 1000, 'retentionMs');
    this.maxGroups = bounded(options.maxGroups, 200, 'maxGroups');
    this.maxProbes = bounded(options.maxProbes, 100, 'maxProbes');
    this.maxStateBytes = bounded(options.maxStateBytes, 16 * 1024 * 1024, 'maxStateBytes');
    if (!isAbsolute(this.stateDir)) throw new Error('RDK capture stateDir must be absolute');
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.stateDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid RDK capture state directory');
    chmodSync(this.stateDir, 0o700);
    this.restore();
    this.prune();
    for (const entry of this.groups.values()) if (entry.value.state === 'running' || entry.value.state === 'connecting') this.monitor(entry);
  }

  listProfiles(): RdkCaptureProfile[] { return clone(PROFILES); }
  listTargets() { return this.collector.listTargets(); }

  async probe(targetId: string, actorId: string): Promise<RdkDeviceProbe> {
    actor(actorId);
    if (this.disposed) fail(503, 'capture_closed', 'Capture service is shutting down');
    if (typeof targetId !== 'string' || !this.collector.listTargets().some((target) => target.id === targetId)) fail(404, 'unknown_target', 'SSH log target was not found');
    this.prune();
    const key = JSON.stringify([actorId, targetId]);
    const existing = this.pendingProbes.get(key);
    if (existing) return clone(await existing);
    if (this.probes.size + this.pendingProbes.size >= this.maxProbes) fail(429, 'probe_limit', 'Device probe retention limit reached');
    this.reserve();
    const pending = (async () => {
      const raw = await this.collector.probeTarget(targetId);
      const value: RdkDeviceProbe = { ...raw, id: randomUUID(), expiresAt: new Date(this.now() + this.retentionMs).toISOString(),
        readableSourceIds: raw.status === 'ready' ? raw.capabilities.filter((entry) => entry.status === 'readable').map((entry) => entry.source.id) : [] };
      const owned: Owned<RdkDeviceProbe> = { version: 1, actorId, value };
      this.persist('probe', owned);
      this.probes.set(value.id, owned);
      return value;
    })();
    this.pendingProbes.set(key, pending);
    try { return clone(await pending); } finally { this.pendingProbes.delete(key); }
  }

  async plan(input: RdkCapturePlanInput, actorId: string): Promise<RdkCapturePlan> {
    actor(actorId);
    if (!object(input) || Object.keys(input).some((key) => !['targetId', 'profileId', 'question', 'sourceIds'].includes(key))) fail(400, 'invalid_request', 'Only configured sources and profiles may be selected');
    const profile = PROFILES.find((entry) => entry.id === input.profileId);
    if (!profile) fail(400, 'unknown_profile', 'RDK log profile was not found');
    const issue = question(input.question);
    if (input.sourceIds !== undefined && (!Array.isArray(input.sourceIds) || input.sourceIds.length < 1 || input.sourceIds.length > 3 || new Set(input.sourceIds).size !== input.sourceIds.length || input.sourceIds.some((id) => typeof id !== 'string'))) fail(400, 'invalid_sources', 'Select one to three unique configured sources');
    this.prune();
    const recent = [...this.probes.values()].filter((entry) => entry.actorId === actorId && entry.value.targetId === input.targetId && this.now() - Date.parse(entry.value.probedAt) < 60000)
      .sort((a, b) => b.value.probedAt.localeCompare(a.value.probedAt))[0];
    const snapshot = recent ? clone(recent.value) : await this.probe(input.targetId, actorId);
    const readable = snapshot.status === 'ready' ? snapshot.capabilities.filter((entry) => entry.status === 'readable').map((entry) => entry.source) : [];
    let sources: SshLogSource[];
    if (input.sourceIds) {
      sources = input.sourceIds.map((id) => { const source = readable.find((entry) => entry.id === id); if (!source) fail(400, 'source_unreadable', 'A selected source was not readable in the device probe'); return source; });
    } else {
      const priority = profile.id === 'x5-isp' ? ['logcat', 'kernel', 'dmesg', 'unit', 'file', 'journal'] : ['journal', 'kernel', 'dmesg', 'unit', 'file', 'logcat'];
      const ordered = [...readable].sort((a, b) => priority.indexOf(a.type) - priority.indexOf(b.type));
      sources = [];
      for (const source of ordered) {
        if (source.type === 'dmesg' && sources.some((entry) => entry.type === 'kernel')) continue;
        if (source.type === 'kernel' && sources.some((entry) => entry.type === 'dmesg')) continue;
        sources.push(source);
        if (sources.length === profile.maxSources) break;
      }
    }
    const warnings = [CLOCK_NOTE];
    if (snapshot.status !== 'ready') warnings.push(`设备探测失败：${snapshot.error ?? 'probe_failed'}。`);
    if (profile.id === 'x5-isp' && !/\bx5\b/i.test(snapshot.model ?? '')) warnings.push('设备型号尚未确认为 X5；采集只采用本次探测可读的来源。');
    if (profile.id === 'x5-isp' && !sources.some((source) => source.type === 'logcat')) warnings.push('logcat 不可读或未选择；当前采集可能缺少用户态媒体 / ISP 链路日志。');
    if (sources.some((source) => source.type === 'logcat' || source.type === 'dmesg')) warnings.push('实时 logcat / dmesg 从设备现有环形缓冲区开始；历史行数参数不限制这两个实时源。');
    if (sources.some((source) => source.type === 'journal' || source.type === 'kernel' || source.type === 'unit')) warnings.push('journal 可读表示当前 SSH 账号至少能读取一条记录，不代表可访问全部系统日志；无记录来源不会自动推荐。');
    if (!sources.length) warnings.push('没有可读日志源，请检查设备镜像、命令和当前 SSH 账号权限。');
    return { targetId: input.targetId, profileId: profile.id, profileVersion: profile.version, question: issue, deviceSnapshot: snapshot, sources: clone(sources), warnings, ready: snapshot.status === 'ready' && sources.length > 0 };
  }

  async start(input: RdkCaptureStartInput, actorId: string): Promise<RdkCaptureGroup> {
    actor(actorId);
    if (this.disposed) fail(503, 'capture_closed', 'Capture service is shutting down');
    if (!object(input) || Object.keys(input).some((key) => !['targetId', 'profileId', 'question', 'sourceIds', 'lines', 'durationSeconds'].includes(key))) fail(400, 'invalid_request', 'Only configured sources and profiles may be selected');
    const lines = input.lines ?? 200;
    const durationSeconds = input.durationSeconds ?? 300;
    if (!Number.isInteger(lines) || lines < 0 || lines > 10000 || !Number.isInteger(durationSeconds) || durationSeconds < 5 || durationSeconds > 1800) fail(400, 'invalid_request', 'Invalid capture duration or history size');
    const plan = await this.plan({ targetId: input.targetId, profileId: input.profileId, question: input.question, sourceIds: input.sourceIds }, actorId);
    if (this.disposed) fail(503, 'capture_closed', 'Capture service is shutting down');
    if (!plan.ready) fail(409, 'no_readable_sources', 'The device probe found no readable sources');
    this.prune();
    if (this.groups.size >= this.maxGroups) fail(429, 'capture_limit', 'Capture retention limit reached');
    this.reserve();
    const value: RdkCaptureGroup = { ...plan, id: randomUUID(), startedAt: this.isoNow(), state: 'connecting', sessions: [], markers: [] };
    const entry: Owned<RdkCaptureGroup> = { version: 1, actorId, value };
    this.persist('group', entry);
    this.groups.set(value.id, entry);
    this.activeStarts.add(value.id);
    try {
      for (const source of value.sources) {
        const session = await this.collector.start({ targetId: input.targetId, sourceId: source.id, lines, durationSeconds, follow: true }, actorId);
        value.sessions.push(session);
        if (session.state === 'failed') fail(503, 'source_start_failed', 'A selected SSH source failed to start');
        this.persist('group', entry);
      }
      const result = this.read(value.id, actorId);
      if (result.state === 'running' || result.state === 'connecting') this.monitor(entry);
      return result;
    } catch (error) {
      await Promise.all(value.sessions.map((session) => this.collector.stop(session.id, actorId).catch(() => undefined)));
      value.state = 'failed'; value.error = error instanceof SshLogCollectorError ? error.code : 'capture_start_failed'; value.endedAt = this.isoNow();
      this.persist('group', entry);
      return clone(value);
    } finally { this.activeStarts.delete(value.id); }
  }

  list(actorId: string): RdkCaptureGroup[] {
    actor(actorId); this.prune();
    return [...this.groups.values()].filter((entry) => entry.actorId === actorId).sort((a, b) => b.value.startedAt.localeCompare(a.value.startedAt)).map((entry) => this.read(entry.value.id, actorId));
  }

  read(id: string, actorId: string): RdkCaptureGroup {
    const entry = this.owned(id, actorId);
    this.refresh(entry);
    return clone(entry.value);
  }

  async stop(id: string, actorId: string): Promise<RdkCaptureGroup> {
    const entry = this.owned(id, actorId);
    if (this.activeStarts.has(id)) fail(409, 'capture_starting', 'Capture is still starting');
    this.stoppingGroups.add(id);
    try {
      const results = await Promise.allSettled(entry.value.sessions.map((session) => this.collector.stop(session.id, actorId)));
      if (results.some((result) => result.status === 'rejected')) entry.value.error = 'source_stop_failed';
      this.refresh(entry);
      if (entry.value.state !== 'failed') entry.value.state = 'stopped';
      entry.value.endedAt ??= this.isoNow();
      this.persist('group', entry);
      return clone(entry.value);
    } finally { this.stoppingGroups.delete(id); }
  }

  mark(id: string, input: { label: string }, actorId: string): RdkCaptureGroup {
    const entry = this.owned(id, actorId);
    if (!object(input) || Object.keys(input).some((key) => key !== 'label') || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 200 || /[\x00-\x1f\x7f]/.test(input.label)) fail(400, 'invalid_marker', 'Marker label must contain 1–200 characters');
    if (entry.value.markers.length >= 64) fail(429, 'marker_limit', 'Capture marker limit reached');
    this.refresh(entry);
    entry.value.markers.push({ id: randomUUID(), label: question(input.label), receivedAt: this.isoNow(), positions: entry.value.sessions.map((session) => ({ sessionId: session.id, seq: session.recordCount })) });
    this.persist('group', entry);
    return clone(entry.value);
  }

  bundle(id: string, actorId: string): RdkCaptureBundle {
    const manifest = this.read(id, actorId);
    const streams = manifest.sessions.map((session) => {
      const records: SshLogRecord[] = [];
      let after = 0;
      do { const page = this.collector.read(session.id, actorId, after, 2000); records.push(...page.records); after = page.cursor; if (!page.hasMore) break; } while (true);
      return { session, records };
    });
    return { contract: 'rdk.log-capture-bundle.v1', exportedAt: this.isoNow(), manifest, clockNote: CLOCK_NOTE, streams };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.monitors.values()) clearInterval(timer);
    this.monitors.clear();
    await Promise.allSettled([...this.groups.values()].filter((entry) => entry.value.state === 'running' || entry.value.state === 'connecting')
      .map((entry) => this.stop(entry.value.id, entry.actorId)));
  }

  private owned(id: string, actorId: string): Owned<RdkCaptureGroup> {
    actor(actorId); this.prune();
    const entry = typeof id === 'string' ? this.groups.get(id) : undefined;
    if (!entry || entry.actorId !== actorId) fail(404, 'unknown_capture', 'RDK capture was not found');
    return entry;
  }
  private refresh(entry: Owned<RdkCaptureGroup>): void {
    const value = entry.value;
    value.sessions = value.sessions.map((session) => {
      try { return this.collector.read(session.id, entry.actorId, 0, 1).session; }
      catch { return { ...session, state: 'failed', stopReason: 'source_unavailable', error: 'Saved source logs are unavailable' }; }
    });
    const active = value.sessions.filter((session) => session.state === 'connecting' || session.state === 'running');
    const failed = value.sessions.some((session) => session.state === 'failed');
    if (failed && active.length && !this.stoppingGroups.has(value.id)) {
      // A later SSH failure must end sibling streams instead of leaving a partial capture running.
      this.stoppingGroups.add(value.id);
      void Promise.allSettled(active.map((session) => this.collector.stop(session.id, entry.actorId))).then(() => {
        this.stoppingGroups.delete(value.id);
        try { this.refresh(entry); } catch { value.error = 'capture_storage_unavailable'; value.state = 'failed'; }
      });
    }
    if (active.length) value.state = value.sessions.some((session) => session.state === 'running') ? 'running' : 'connecting';
    else if (value.error || failed) value.state = 'failed';
    else if (value.sessions.length) value.state = value.sessions.some((session) => session.state === 'stopped') ? 'stopped' : 'completed';
    if (!active.length && !this.activeStarts.has(value.id)) value.endedAt ??= this.isoNow();
    if (!active.length) { const timer = this.monitors.get(value.id); if (timer) clearInterval(timer); this.monitors.delete(value.id); }
    this.persist('group', entry);
  }
  private monitor(entry: Owned<RdkCaptureGroup>): void {
    if (this.disposed || this.monitors.has(entry.value.id)) return;
    const timer = setInterval(() => {
      try { this.refresh(entry); }
      catch {
        entry.value.error = 'capture_storage_unavailable';
        void Promise.allSettled(entry.value.sessions.map((session) => this.collector.stop(session.id, entry.actorId)));
        clearInterval(timer); this.monitors.delete(entry.value.id);
      }
    }, 1000);
    timer.unref();
    this.monitors.set(entry.value.id, timer);
  }
  private reserve(): void {
    let bytes = 0;
    for (const name of readdirSync(this.stateDir)) { try { bytes += lstatSync(join(this.stateDir, name)).size; } catch { /* A removed file is already free. */ } }
    if (bytes + STATE_RESERVE * (this.pendingProbes.size + 1) > this.maxStateBytes) fail(507, 'capture_storage_limit', 'Capture metadata storage limit reached');
  }
  private persist(kind: 'group' | 'probe', entry: Owned<RdkCaptureGroup | RdkDeviceProbe>): void {
    const data = JSON.stringify(entry);
    const size = Buffer.byteLength(data);
    if (size > STATE_RESERVE) fail(507, 'capture_metadata_limit', 'Capture metadata limit reached');
    const path = this.path(kind, entry.value.id);
    let total = size;
    for (const name of readdirSync(this.stateDir)) {
      const file = join(this.stateDir, name);
      if (file === path || file === `${path}.tmp`) continue;
      try { total += lstatSync(file).size; } catch { /* A removed file consumes no storage. */ }
    }
    if (total > this.maxStateBytes) fail(507, 'capture_storage_limit', 'Capture metadata storage limit reached');
    try { writeFileSync(`${path}.tmp`, data, { mode: 0o600 }); renameSync(`${path}.tmp`, path); chmodSync(path, 0o600); }
    catch { fail(507, 'capture_storage_unavailable', 'Cannot save capture metadata'); }
  }
  private restore(): void {
    for (const name of readdirSync(this.stateDir)) {
      const match = /^(group|probe)-([0-9a-f-]{36})\.json$/.exec(name);
      if (!match || !UUID.test(match[2]!)) continue;
      const kind = match[1] as 'group' | 'probe';
      const map = kind === 'group' ? this.groups : this.probes;
      if (map.size >= (kind === 'group' ? this.maxGroups : this.maxProbes)) continue;
      try {
        const stat = lstatSync(join(this.stateDir, name));
        if (!stat.isFile() || stat.size > STATE_RESERVE) continue;
        const raw: unknown = JSON.parse(readFileSync(join(this.stateDir, name), 'utf8'));
        if (!object(raw) || raw.version !== 1 || typeof raw.actorId !== 'string' || !object(raw.value) || raw.value.id !== match[2]) continue;
        actor(raw.actorId);
        const value = raw.value;
        if (kind === 'group') {
          if (typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt)) || !Array.isArray(value.sessions) || !Array.isArray(value.markers) || !Array.isArray(value.sources) || !Array.isArray(value.warnings) || !object(value.deviceSnapshot)) continue;
          this.groups.set(value.id as string, raw as unknown as Owned<RdkCaptureGroup>);
        } else {
          if (typeof value.probedAt !== 'string' || !Number.isFinite(Date.parse(value.probedAt)) || !Array.isArray(value.capabilities) || !Array.isArray(value.readableSourceIds)) continue;
          this.probes.set(value.id as string, raw as unknown as Owned<RdkDeviceProbe>);
        }
      } catch { /* Malformed local state never becomes an authorized capture. */ }
    }
  }
  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [id, entry] of this.groups) {
      const value = entry.value;
      if (this.activeStarts.has(id) || this.stoppingGroups.has(id) || Date.parse(value.endedAt ?? value.startedAt) > cutoff) continue;
      const active = value.sessions.some((session) => { try { const state = this.collector.read(session.id, entry.actorId, 0, 1).session.state; return state === 'running' || state === 'connecting'; } catch { return false; } });
      if (!active && this.remove('group', id)) this.groups.delete(id);
    }
    for (const [id, entry] of this.probes) if (Date.parse(entry.value.probedAt) <= cutoff && this.remove('probe', id)) this.probes.delete(id);
    for (const name of readdirSync(this.stateDir)) {
      if (!/^(group|probe)-[0-9a-f-]{36}\.json(?:\.tmp)?$/.test(name)) continue;
      if ([...this.groups.keys()].some((id) => name === `group-${id}.json`) || [...this.probes.keys()].some((id) => name === `probe-${id}.json`)) continue;
      const path = join(this.stateDir, name);
      try { if (lstatSync(path).mtimeMs <= cutoff) unlinkSync(path); } catch { /* Files remain counted by reserve until successfully removed. */ }
    }
  }
  private remove(kind: 'group' | 'probe', id: string): boolean {
    try { unlinkSync(this.path(kind, id)); return true; } catch { return false; }
  }
  private path(kind: 'group' | 'probe', id: string): string { return join(this.stateDir, `${kind}-${id}.json`); }
  private isoNow(): string { return new Date(this.now()).toISOString(); }
}
