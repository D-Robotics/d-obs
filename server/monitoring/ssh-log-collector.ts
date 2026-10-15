import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync, appendFileSync, chmodSync, constants, existsSync, lstatSync, mkdirSync,
  readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export interface SshLogSource {
  id: string;
  label: string;
  type: 'kernel' | 'journal' | 'unit' | 'file' | 'logcat' | 'dmesg';
  unit?: string;
  path?: string;
}

export interface SshLogTarget {
  id: string;
  label: string;
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  sources: SshLogSource[];
}

/** Connection credentials and host addresses never leave the server configuration. */
export interface PublicSshLogTarget {
  id: string;
  label: string;
  sources: SshLogSource[];
}

export interface SshLogSession {
  id: string;
  targetId: string;
  targetLabel: string;
  sourceId: string;
  sourceLabel: string;
  state: 'connecting' | 'running' | 'stopped' | 'completed' | 'failed';
  startedAt: string;
  endedAt?: string;
  recordCount: number;
  byteCount: number;
  stopReason?: string;
  error?: string;
}

export interface SshLogRecord {
  seq: number;
  receivedAt: string;
  stream: 'stdout' | 'stderr';
  /** Exact decoded output, including any newlines; concatenate records for export. */
  text: string;
}

export interface SshLogStartInput {
  targetId: string;
  sourceId: string;
  lines?: number;
  durationSeconds?: number;
  follow?: boolean;
}

export interface SshLogSourceCapability {
  source: SshLogSource;
  status: 'readable' | 'missing_command' | 'unreadable' | 'unavailable';
}

export interface SshLogDeviceProbe {
  targetId: string;
  targetLabel: string;
  probedAt: string;
  status: 'ready' | 'failed';
  model?: string;
  os?: string;
  kernel?: string;
  deviceTime?: string;
  capabilities: SshLogSourceCapability[];
  error?: string;
}

export class SshLogCollectorError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'SshLogCollectorError';
  }
}

export type SshLogSpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface SshLogCollectorOptions {
  targets: SshLogTarget[];
  stateDir: string;
  spawnProcess?: SshLogSpawnProcess;
  maxSessionBytes?: number;
  maxTotalBytes?: number;
  retentionMs?: number;
  maxConcurrent?: number;
  maxSessions?: number;
  maxDurationSeconds?: number;
  now?: () => number;
}

interface StoredSession {
  version: 1;
  actorId: string;
  session: SshLogSession;
}

interface SessionEntry extends StoredSession {
  records: SshLogRecord[];
  logFileBytes: number;
  child?: ChildProcess;
  childAlive: boolean;
  timer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  stdout: StringDecoder;
  stderr: StringDecoder;
  stderrPending: string;
  identityFile?: string;
  readyMarker: string;
  readyPending: string;
  stopRequest?: { state: SshLogSession['state']; reason: string; error?: string };
  exitPromise?: Promise<void>;
  resolveExit?: () => void;
  finished: boolean;
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const META_RESERVE = 8192;
const DEFAULT_SOURCES: SshLogSource[] = [
  { id: 'kernel', label: '内核 / 驱动日志', type: 'kernel' },
  { id: 'journal', label: '系统服务日志', type: 'journal' },
];
const RDK_SOURCES: SshLogSource[] = [
  { id: 'rdk-logcat', label: 'RDK logcat / 媒体链路', type: 'logcat' },
  { id: 'rdk-dmesg', label: '内核 dmesg', type: 'dmesg' },
];

function configError(message: string): never {
  throw new SshLogCollectorError(500, 'invalid_config', message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configString(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || !value || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) {
    return configError(`Invalid SSH log target ${field}`);
  }
  return value;
}

/** Parse a server-owned allowlist. Browser requests may only select these IDs. */
export function parseSshLogTargets(raw: string): SshLogTarget[] {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return configError('SSH log targets must be a JSON array'); }
  if (!Array.isArray(parsed) || parsed.length > 64) return configError('SSH log targets must contain at most 64 entries');
  const ids = new Set<string>();
  return parsed.map((value): SshLogTarget => {
    if (!isObject(value)) return configError('Invalid SSH log target');
    const id = configString(value.id, 'id', 64);
    if (!ID.test(id) || ids.has(id)) return configError('SSH log target IDs must be unique safe identifiers');
    ids.add(id);
    const label = configString(value.label ?? id, 'label', 120);
    const host = configString(value.host, 'host', 253);
    if (!isIP(host) && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host)) return configError('Invalid SSH log target host');
    const user = value.user === undefined ? undefined : configString(value.user, 'user', 64);
    if (user !== undefined && !/^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/.test(user)) return configError('Invalid SSH log target user');
    const port = value.port;
    if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) return configError('Invalid SSH log target port');
    const identityFile = value.identityFile === undefined ? undefined : configString(value.identityFile, 'identityFile', 2048);
    if (identityFile !== undefined && !isAbsolute(identityFile)) return configError('SSH identityFile must be an absolute server path');
    const sourceValues = value.sources ?? DEFAULT_SOURCES;
    if (!Array.isArray(sourceValues) || sourceValues.length < 1 || sourceValues.length > 32) return configError('SSH log targets must have 1–32 sources');
    const sourceIds = new Set<string>();
    const sources = sourceValues.map((source): SshLogSource => {
      if (!isObject(source)) return configError('Invalid SSH log source');
      const sourceId = configString(source.id, 'source id', 64);
      if (!ID.test(sourceId) || sourceIds.has(sourceId)) return configError('SSH log source IDs must be unique safe identifiers');
      sourceIds.add(sourceId);
      const sourceLabel = configString(source.label ?? sourceId, 'source label', 120);
      if (!['kernel', 'journal', 'unit', 'file', 'logcat', 'dmesg'].includes(String(source.type))) return configError('Invalid SSH log source type');
      const type = source.type as SshLogSource['type'];
      if (type === 'unit') {
        const unit = configString(source.unit, 'source unit', 256);
        if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.:@-]*$/.test(unit)) return configError('Invalid SSH log source unit');
        return { id: sourceId, label: sourceLabel, type, unit };
      }
      if (type === 'file') {
        const path = configString(source.path, 'source path', 1024);
        if (!path.startsWith('/')) return configError('SSH log file sources require an absolute remote path');
        return { id: sourceId, label: sourceLabel, type, path };
      }
      return { id: sourceId, label: sourceLabel, type };
    });
    return { id, label, host, user, port: port as number | undefined, identityFile, sources };
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function remoteCommand(source: SshLogSource, lines: number, follow: boolean): string {
  if (source.type === 'file') return `tail -n ${lines}${follow ? ' -F' : ''} -- ${shellQuote(source.path!)}`;
  // X5 SDK documents -t as a snapshot flag; live logcat/dmesg use the device ring buffer.
  if (source.type === 'logcat') return `logcat${follow ? '' : ` -d${lines ? ` -t ${lines}` : ''}`} -v threadtime '*:V'`;
  if (source.type === 'dmesg') return `dmesg${follow ? ' --follow' : ''}`;
  const command = `journalctl --no-pager --output=short-iso-precise --lines=${lines}${follow ? ' --follow' : ''}`;
  if (source.type === 'kernel') return `${command} --dmesg`;
  if (source.type === 'unit') return `${command} --unit ${shellQuote(source.unit!)}`;
  return command;
}

function sshArguments(target: SshLogTarget, command: string): string[] {
  const args = ['-T', '-n', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'PermitLocalCommand=no', '-o', 'LogLevel=ERROR'];
  if (target.port !== undefined) args.push('-p', String(target.port));
  if (target.user) args.push('-l', target.user);
  if (target.identityFile) args.push('-o', 'IdentitiesOnly=yes', '-i', target.identityFile);
  return [...args, '--', target.host, command];
}

/** A fixed, read-only script: no browser-supplied command is interpolated here. */
function probeCommand(sources: SshLogSource[]): string {
  const script = [
    "field() { printf '%s\\t' \"$1\"; printf '%s' \"$2\" | tr '\\000\\r\\n\\t' '    '; printf '\\n'; }",
    // Exit zero alone is insufficient: journalctl may emit only a permission hint on stderr.
    "journal_read() { sample=$(timeout 3s env LC_ALL=C journalctl --no-pager --output=json --lines=1 \"$@\" 2>/dev/null); rc=$?; if [ \"$rc\" -ne 0 ]; then printf unreadable; else case \"$sample\" in \\{*) printf readable ;; *) printf unavailable ;; esac; fi; }",
    "field model \"$(cat /proc/device-tree/model 2>/dev/null)\"",
    "field os \"$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | head -n 1)\"",
    'field kernel "$(uname -r 2>/dev/null)"',
    'field deviceTime "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"',
  ];
  sources.forEach((source, index) => {
    const command = source.type === 'logcat' ? 'logcat' : source.type === 'dmesg' ? 'dmesg' : source.type === 'file' ? 'tail' : 'journalctl';
    if (source.type === 'kernel' || source.type === 'journal' || source.type === 'unit') {
      const scope = source.type === 'kernel' ? ' --dmesg' : source.type === 'unit' ? ` --unit ${shellQuote(source.unit!)}` : '';
      let check = `field source${index} \"$(journal_read${scope})\"`;
      if (source.type === 'unit') {
        check = `if ! command -v systemctl >/dev/null 2>&1; then field source${index} unavailable; else load=$(timeout 3s env LC_ALL=C systemctl show --property=LoadState --value -- ${shellQuote(source.unit!)} 2>/dev/null); case \"$load\" in loaded|masked) ${check} ;; *) field source${index} unavailable ;; esac; fi`;
      }
      script.push(`if ! command -v journalctl >/dev/null 2>&1; then field source${index} missing_command; else ${check}; fi`);
      return;
    }
    const read = source.type === 'logcat' ? "logcat -d -t 1 -v threadtime '*:V'" : remoteCommand(source, 1, false);
    const readable = source.type === 'file' ? `[ -r ${shellQuote(source.path!)} ] && timeout 3s ${read}` : `timeout 3s ${read}`;
    script.push(`if ! command -v ${command} >/dev/null 2>&1; then field source${index} missing_command; elif ${readable} >/dev/null 2>&1; then field source${index} readable; else field source${index} unreadable; fi`);
  });
  script.push('field complete yes');
  return `exec timeout --signal=TERM --kill-after=2s 20s sh -c ${shellQuote(script.join('\n'))}`;
}

function positiveOption(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${name} must be a positive integer`);
  return result;
}

function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

/** Bounded SSH processes with private, durable local logs; no device-side installation. */
export class SshLogCollector {
  private readonly targets: SshLogTarget[];
  private readonly stateDir: string;
  private readonly spawnProcess: SshLogSpawnProcess;
  private readonly now: () => number;
  private readonly maxSessionBytes: number;
  private readonly maxTotalBytes: number;
  private readonly retentionMs: number;
  private readonly maxConcurrent: number;
  private readonly maxSessions: number;
  private readonly maxDurationSeconds: number;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly orphanFiles = new Map<string, { bytes: number; modifiedAt: number; managed: boolean }>();
  private readonly probes = new Map<ChildProcess, { stop: () => void; done: Promise<SshLogDeviceProbe> }>();
  private disposed = false;

  constructor(options: SshLogCollectorOptions) {
    this.targets = parseSshLogTargets(JSON.stringify(options.targets)).map((target) => ({ ...target,
      sources: [...target.sources, ...RDK_SOURCES.filter((source) => !target.sources.some((existing) => existing.id === source.id))],
    }));
    this.stateDir = options.stateDir;
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.now = options.now ?? Date.now;
    this.maxSessionBytes = positiveOption(options.maxSessionBytes, 10 * 1024 * 1024, 'maxSessionBytes');
    this.maxTotalBytes = positiveOption(options.maxTotalBytes, 50 * 1024 * 1024, 'maxTotalBytes');
    this.retentionMs = positiveOption(options.retentionMs, 24 * 60 * 60 * 1000, 'retentionMs');
    this.maxConcurrent = positiveOption(options.maxConcurrent, 4, 'maxConcurrent');
    this.maxSessions = positiveOption(options.maxSessions, 200, 'maxSessions');
    this.maxDurationSeconds = positiveOption(options.maxDurationSeconds, 1800, 'maxDurationSeconds');
    if (!isAbsolute(this.stateDir)) throw new Error('SSH log stateDir must be an absolute path');
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.stateDir).isDirectory() || lstatSync(this.stateDir).isSymbolicLink()) throw new Error('Invalid SSH log state directory');
    chmodSync(this.stateDir, 0o700);
    this.restore();
    this.trackOrphans();
    this.prune();
  }

  listTargets(): PublicSshLogTarget[] {
    return this.targets.map(({ id, label, sources }) => ({ id, label, sources: sources.map((source) => ({ ...source })) }));
  }

  async probeTarget(targetId: string): Promise<SshLogDeviceProbe> {
    if (this.disposed) throw new SshLogCollectorError(503, 'collector_closed', 'SSH log collector is shutting down');
    const target = this.targets.find(({ id }) => id === targetId);
    if (!target) throw new SshLogCollectorError(404, 'unknown_target', 'SSH log target was not found');
    if ([...this.sessions.values()].filter((entry) => !entry.finished || entry.childAlive).length + this.probes.size >= this.maxConcurrent) {
      throw new SshLogCollectorError(429, 'concurrency_limit', 'All SSH connection slots are in use');
    }
    const base: SshLogDeviceProbe = { targetId, targetLabel: target.label, probedAt: this.isoNow(), status: 'failed',
      capabilities: target.sources.map((source) => ({ source: { ...source }, status: 'unavailable' })) };
    if (target.identityFile) {
      try { accessSync(target.identityFile, constants.R_OK); } catch { return { ...base, error: 'identity_unavailable' }; }
    }
    let child: ChildProcess;
    try { child = this.spawnProcess('ssh', sshArguments(target, probeCommand(target.sources)), { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { return { ...base, error: 'ssh_error' }; }
    let resolve: (probe: SshLogDeviceProbe) => void;
    const done = new Promise<SshLogDeviceProbe>((complete) => { resolve = complete; });
    let finished = false;
    let output = '';
    const decoder = new StringDecoder('utf8');
    let reason: string | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (code: number | null, closed = false) => {
      if (closed) this.probes.delete(child);
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      output += utf8Prefix(decoder.end(), Math.max(0, 65536 - Buffer.byteLength(output)));
      const fields = new Map(output.split('\n').map((line) => { const split = line.indexOf('\t'); return [line.slice(0, split), line.slice(split + 1)] as [string, string]; }));
      if (reason || code !== 0 || fields.get('complete') !== 'yes') { resolve({ ...base, error: reason ?? 'probe_failed' }); return; }
      const clean = (key: string) => (fields.get(key)?.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 256) || undefined);
      resolve({ ...base, status: 'ready', model: clean('model'), os: clean('os')?.replace(/^"|"$/g, ''), kernel: clean('kernel'), deviceTime: clean('deviceTime'),
        capabilities: target.sources.map((source, index) => ({ source: { ...source }, status:
          ['readable', 'missing_command', 'unreadable'].includes(fields.get(`source${index}`) ?? '')
            ? fields.get(`source${index}`) as SshLogSourceCapability['status'] : 'unavailable' })) });
    };
    const stop = () => {
      if (finished || killTimer) return;
      try { child.kill('SIGTERM'); } catch { /* Escalation remains bounded. */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* Complete even if a broken transport never closes. */ }
        killTimer = setTimeout(() => finish(null), 1000);
        killTimer.unref();
      }, 2000);
      killTimer.unref();
    };
    const timer = setTimeout(() => { reason = 'probe_timeout'; stop(); }, 25000);
    timer.unref();
    this.probes.set(child, { done, stop: () => { reason = 'collector_shutdown'; stop(); } });
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (finished || reason === 'probe_output_limit') return;
      const text = decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      const available = Math.max(0, 65536 - Buffer.byteLength(output));
      output += utf8Prefix(text, available);
      if (Buffer.byteLength(text) > available) { reason = 'probe_output_limit'; stop(); }
    });
    child.stderr?.on('data', () => { /* Private SSH diagnostics may include host paths; only a safe error code is exposed. */ });
    child.stdout?.once('error', () => { reason = 'probe_stream_error'; stop(); });
    child.stderr?.once('error', () => { reason = 'probe_stream_error'; stop(); });
    child.once('error', () => { reason = 'ssh_error'; stop(); });
    child.once('close', (code: number | null) => finish(code, true));
    return done;
  }

  async start(input: SshLogStartInput, actorId: string): Promise<SshLogSession> {
    this.requireActor(actorId);
    if (this.disposed) throw new SshLogCollectorError(503, 'collector_closed', 'SSH log collector is shutting down');
    if (!isObject(input) || typeof input.targetId !== 'string' || typeof input.sourceId !== 'string') {
      throw new SshLogCollectorError(400, 'invalid_request', 'targetId and sourceId are required');
    }
    if (Object.keys(input).some((key) => !['targetId', 'sourceId', 'lines', 'durationSeconds', 'follow'].includes(key))) {
      throw new SshLogCollectorError(400, 'invalid_request', 'Only configured target and source IDs may be selected');
    }
    const target = this.targets.find(({ id }) => id === input.targetId);
    if (!target) throw new SshLogCollectorError(404, 'unknown_target', 'SSH log target was not found');
    const source = target.sources.find(({ id }) => id === input.sourceId);
    if (!source) throw new SshLogCollectorError(404, 'unknown_source', 'SSH log source was not found');
    const lines = input.lines ?? 200;
    const duration = input.durationSeconds ?? Math.min(300, this.maxDurationSeconds);
    if (!Number.isInteger(lines) || lines < 0 || lines > 10000) throw new SshLogCollectorError(400, 'invalid_request', 'lines must be an integer from 0 to 10000');
    if (!Number.isInteger(duration) || duration < 1 || duration > this.maxDurationSeconds) {
      throw new SshLogCollectorError(400, 'invalid_request', `durationSeconds must be an integer from 1 to ${this.maxDurationSeconds}`);
    }
    if (input.follow !== undefined && typeof input.follow !== 'boolean') throw new SshLogCollectorError(400, 'invalid_request', 'follow must be a boolean');
    this.prune();
    // No await before reservation: concurrent requests cannot overbook a process slot.
    if ([...this.sessions.values()].filter((entry) => !entry.finished || entry.childAlive).length + this.probes.size >= this.maxConcurrent) {
      throw new SshLogCollectorError(429, 'concurrency_limit', 'All SSH log collection slots are in use');
    }
    if (this.sessions.size >= this.maxSessions) throw new SshLogCollectorError(429, 'session_limit', 'SSH log session retention limit reached');
    if (this.diskBytes() + META_RESERVE > this.maxTotalBytes) throw new SshLogCollectorError(507, 'disk_limit', 'SSH log storage limit reached');
    if (target.identityFile) {
      try { accessSync(target.identityFile, constants.R_OK); } catch {
        throw new SshLogCollectorError(503, 'identity_unavailable', 'The configured SSH identity file is unavailable');
      }
    }
    const session: SshLogSession = {
      id: randomUUID(), targetId: target.id, targetLabel: target.label,
      sourceId: source.id, sourceLabel: source.label, state: 'connecting',
      startedAt: this.isoNow(), recordCount: 0, byteCount: 0,
    };
    const entry = this.newEntry(actorId, session);
    entry.identityFile = target.identityFile;
    this.sessions.set(session.id, entry);
    try {
      writeFileSync(this.logPath(session.id), '', { flag: 'wx', mode: 0o600 });
      this.persist(entry);
    } catch {
      this.sessions.delete(session.id);
      this.removeFiles(session.id);
      throw new SshLogCollectorError(507, 'storage_unavailable', 'Cannot save SSH collection logs');
    }
    const args = sshArguments(target, `printf '%s\\n' ${shellQuote(entry.readyMarker)} >&2; exec timeout --signal=TERM --kill-after=2s ${duration + 2}s ${remoteCommand(source, lines, input.follow ?? true)}`);
    try {
      const child = this.spawnProcess('ssh', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      entry.child = child;
      entry.childAlive = true;
      entry.timer = setTimeout(() => this.requestStop(entry, 'stopped', 'duration_limit'), duration * 1000);
      entry.timer.unref();
      child.stdout?.on('data', (chunk: Buffer | string) => this.receive(entry, 'stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer | string) => this.receive(entry, 'stderr', chunk));
      child.stdout?.once('error', () => this.finish(entry, 'failed', 'stream_error', 'SSH stdout could not be read', true));
      child.stderr?.once('error', () => this.finish(entry, 'failed', 'stream_error', 'SSH stderr could not be read', true));
      child.once('error', () => this.finish(entry, 'failed', 'ssh_error', 'Unable to start the SSH process', true));
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
        entry.childAlive = false;
        if (entry.finished) {
          if (entry.killTimer) clearTimeout(entry.killTimer);
          entry.resolveExit?.();
          return;
        }
        if (entry.stopRequest) this.finish(entry, entry.stopRequest.state, entry.stopRequest.reason, entry.stopRequest.error);
        else if (code === 0) this.finish(entry, 'completed', 'process_exit');
        else this.finish(entry, 'failed', 'ssh_exit', `SSH process exited ${signal ? `with signal ${signal}` : `with code ${code ?? 'unknown'}`}; see stderr for details`);
        if (entry.killTimer) clearTimeout(entry.killTimer);
        entry.resolveExit?.();
      });
    } catch {
      this.finish(entry, 'failed', 'ssh_error', 'Unable to start the SSH process', true);
    }
    return { ...entry.session };
  }

  list(actorId: string): SshLogSession[] {
    this.requireActor(actorId);
    this.prune();
    return [...this.sessions.values()].filter((entry) => entry.actorId === actorId)
      .sort((a, b) => b.session.startedAt.localeCompare(a.session.startedAt))
      .map((entry) => ({ ...entry.session }));
  }

  read(id: string, actorId: string, after = 0, limit = 500): { session: SshLogSession; records: SshLogRecord[]; cursor: number; hasMore: boolean } {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000) {
      throw new SshLogCollectorError(400, 'invalid_cursor', 'after must be a nonnegative integer and limit must be from 1 to 2000');
    }
    const entry = this.owned(id, actorId);
    if (after > entry.session.recordCount) throw new SshLogCollectorError(400, 'invalid_cursor', 'after exceeds this session’s last record');
    const records = entry.records.slice(after, after + limit).map((record) => ({ ...record }));
    const cursor = records.at(-1)?.seq ?? after;
    return { session: { ...entry.session }, records, cursor, hasMore: cursor < entry.session.recordCount };
  }

  async stop(id: string, actorId: string): Promise<SshLogSession> {
    const entry = this.owned(id, actorId);
    this.requestStop(entry, 'stopped', 'user');
    await entry.exitPromise;
    return { ...entry.session };
  }

  async exportText(id: string, actorId: string): Promise<string> {
    return this.owned(id, actorId).records.map((record) => record.text).join('');
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const probes = [...this.probes.values()];
    for (const probe of probes) probe.stop();
    for (const entry of this.sessions.values()) this.requestStop(entry, 'stopped', 'collector_shutdown');
    await Promise.all([...probes.map((probe) => probe.done), ...[...this.sessions.values()].map((entry) => entry.exitPromise)]);
  }

  private requireActor(actorId: string): void {
    if (typeof actorId !== 'string' || !actorId || actorId.length > 256 || /[\x00-\x1f\x7f]/.test(actorId)) {
      throw new SshLogCollectorError(401, 'invalid_actor', 'An authenticated collection owner is required');
    }
  }

  private owned(id: string, actorId: string): SessionEntry {
    this.requireActor(actorId);
    this.prune();
    const entry = typeof id === 'string' ? this.sessions.get(id) : undefined;
    if (!entry || entry.actorId !== actorId) throw new SshLogCollectorError(404, 'unknown_session', 'SSH log session was not found');
    return entry;
  }

  private newEntry(actorId: string, session: SshLogSession): SessionEntry {
    return { version: 1, actorId, session, records: [], logFileBytes: 0, childAlive: false,
      stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8'), stderrPending: '',
      readyMarker: `\x1ed-obs-ready:${session.id}\x1f`, readyPending: '', finished: false };
  }

  private receive(entry: SessionEntry, stream: 'stdout' | 'stderr', chunk: Buffer | string): void {
    if (entry.finished) return;
    const decoded = entry[stream].write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    if (stream === 'stdout' && decoded) this.markReady(entry);
    const text = stream === 'stderr' ? this.redactIdentity(entry, this.filterReady(entry, decoded)) : decoded;
    if (text && !entry.finished) this.append(entry, stream, text);
  }

  private markReady(entry: SessionEntry): void {
    if (entry.session.state !== 'connecting') return;
    entry.session.state = 'running';
    this.safePersist(entry);
  }

  private filterReady(entry: SessionEntry, text: string): string {
    const combined = entry.readyPending + text;
    const marker = entry.readyMarker + '\n';
    const index = combined.indexOf(marker);
    if (index !== -1) {
      entry.readyPending = '';
      this.markReady(entry);
      return combined.slice(0, index) + combined.slice(index + marker.length);
    }
    let pendingLength = Math.min(marker.length - 1, combined.length);
    while (pendingLength > 0 && !combined.endsWith(marker.slice(0, pendingLength))) pendingLength--;
    entry.readyPending = combined.slice(combined.length - pendingLength);
    return combined.slice(0, combined.length - pendingLength);
  }

  private redactIdentity(entry: SessionEntry, text: string, final = false): string {
    if (!entry.identityFile) return text;
    const combined = (entry.stderrPending + text).replaceAll(entry.identityFile, '[identity file]');
    if (final) {
      const pending = entry.stderrPending;
      entry.stderrPending = '';
      return (pending ? '[identity file]' : '') + text.replaceAll(entry.identityFile, '[identity file]');
    }
    let pendingLength = Math.min(entry.identityFile.length - 1, combined.length);
    while (pendingLength > 0 && !combined.endsWith(entry.identityFile.slice(0, pendingLength))) pendingLength--;
    entry.stderrPending = combined.slice(combined.length - pendingLength);
    return combined.slice(0, combined.length - pendingLength);
  }

  private append(entry: SessionEntry, stream: 'stdout' | 'stderr', output: string): void {
    const remaining = this.maxSessionBytes - entry.session.byteCount;
    const text = utf8Prefix(output, remaining);
    if (text) {
      const record: SshLogRecord = { seq: entry.records.length + 1, receivedAt: this.isoNow(), stream, text };
      const serialized = JSON.stringify(record) + '\n';
      const bytes = Buffer.byteLength(serialized);
      if (this.diskBytes() + bytes > this.maxTotalBytes) {
        this.outputFailure(entry, 'disk_limit');
        return;
      }
      try { appendFileSync(this.logPath(entry.session.id), serialized, { mode: 0o600 }); } catch {
        this.outputFailure(entry, 'storage_error', 'Cannot save SSH collection logs');
        return;
      }
      entry.logFileBytes += bytes;
      entry.records.push(record);
      entry.session.recordCount = entry.records.length;
      entry.session.byteCount += Buffer.byteLength(text);
      this.safePersist(entry);
    }
    if (text !== output || entry.session.byteCount >= this.maxSessionBytes) this.outputFailure(entry, 'byte_limit');
  }

  private outputFailure(entry: SessionEntry, reason: string, error?: string): void {
    if (!entry.finished) { this.finish(entry, error ? 'failed' : 'stopped', reason, error, true); return; }
    entry.session.state = error ? 'failed' : 'stopped';
    entry.session.stopReason = reason;
    if (error) entry.session.error = error;
  }

  private finish(entry: SessionEntry, state: SshLogSession['state'], reason: string, error?: string, kill = false): void {
    if (entry.finished) return;
    // Mark first so buffered flushes cannot recursively finish or accept more events.
    entry.finished = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.session.state = state;
    entry.session.stopReason = reason;
    if (error) entry.session.error = error.slice(0, 300);
    entry.session.endedAt = this.isoNow();
    const stdout = entry.stdout.end();
    const stderr = this.redactIdentity(entry, entry.stderr.end(), true);
    if (stdout) this.append(entry, 'stdout', stdout);
    if (stderr) this.append(entry, 'stderr', stderr);
    this.safePersist(entry);
    if (kill) this.terminateChild(entry);
  }

  private requestStop(entry: SessionEntry, state: SshLogSession['state'], reason: string, error?: string): void {
    if (!entry.finished && !entry.stopRequest) entry.stopRequest = { state, reason, error };
    if (entry.childAlive) this.terminateChild(entry);
    else if (!entry.finished) this.finish(entry, state, reason, error);
  }

  private terminateChild(entry: SessionEntry): void {
    if (entry.exitPromise) return;
    entry.exitPromise = new Promise<void>((resolve) => { entry.resolveExit = resolve; });
    if (!entry.childAlive || !entry.child) { entry.resolveExit?.(); return; }
    entry.killTimer = setTimeout(() => {
      try { entry.child?.kill('SIGKILL'); } catch { /* Close fallback below still completes shutdown. */ }
      if (!entry.childAlive) return;
      entry.killTimer = setTimeout(() => {
        if (!entry.finished) {
          const stop = entry.stopRequest;
          this.finish(entry, stop?.state ?? 'failed', stop?.reason ?? 'ssh_error', stop?.error ?? 'SSH process did not close after termination');
        }
        entry.resolveExit?.();
      }, 1000);
      entry.killTimer.unref();
    }, 2000);
    entry.killTimer.unref();
    try { entry.child.kill('SIGTERM'); } catch { /* Escalate to SIGKILL if SIGTERM cannot be delivered. */ }
  }

  private safePersist(entry: SessionEntry): void {
    try { this.persist(entry); } catch {
      if (!entry.finished) this.finish(entry, 'failed', 'storage_error', 'Cannot save SSH collection metadata', true);
      else { entry.session.state = 'failed'; entry.session.stopReason = 'storage_error'; entry.session.error = 'Cannot save SSH collection metadata'; }
    }
  }

  private persist(entry: StoredSession): void {
    const data: StoredSession = { version: 1, actorId: entry.actorId, session: entry.session };
    const encoded = JSON.stringify(data);
    if (Buffer.byteLength(encoded) > META_RESERVE) throw new Error('SSH collection metadata exceeds reserved storage');
    const path = this.metaPath(entry.session.id);
    writeFileSync(`${path}.tmp`, encoded, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    chmodSync(path, 0o600);
  }

  private diskBytes(): number {
    return [...this.sessions.values()].reduce((bytes, entry) => bytes + entry.logFileBytes + META_RESERVE, 0)
      + [...this.orphanFiles.values()].reduce((bytes, file) => bytes + file.bytes, 0);
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [id, entry] of this.sessions) {
      if (!entry.finished || entry.childAlive || Date.parse(entry.session.endedAt ?? entry.session.startedAt) > cutoff) continue;
      if (entry.killTimer) clearTimeout(entry.killTimer);
      this.removeFiles(id);
      this.sessions.delete(id);
    }
    for (const [path, file] of this.orphanFiles) {
      if (!file.managed || file.modifiedAt > cutoff) continue;
      try { unlinkSync(path); this.orphanFiles.delete(path); } catch { /* Keep counting files until removal succeeds. */ }
    }
  }

  private restore(): void {
    for (const filename of readdirSync(this.stateDir)) {
      if (!filename.endsWith('.meta.json')) continue;
      const id = filename.slice(0, -'.meta.json'.length);
      if (!UUID.test(id)) continue;
      if (this.sessions.size >= this.maxSessions) continue;
      let entry: SessionEntry;
      try {
        const meta = lstatSync(this.metaPath(id));
        if (!meta.isFile() || meta.size > META_RESERVE) continue;
        const parsed: unknown = JSON.parse(readFileSync(this.metaPath(id), 'utf8'));
        if (!isObject(parsed) || parsed.version !== 1 || typeof parsed.actorId !== 'string' || !isObject(parsed.session)) continue;
        this.requireActor(parsed.actorId);
        const session = parsed.session;
        if (session.id !== id || !['connecting', 'running', 'stopped', 'completed', 'failed'].includes(String(session.state))
          || typeof session.startedAt !== 'string' || !Number.isFinite(Date.parse(session.startedAt))
          || typeof session.targetId !== 'string' || typeof session.targetLabel !== 'string'
          || typeof session.sourceId !== 'string' || typeof session.sourceLabel !== 'string') continue;
        entry = this.newEntry(parsed.actorId, session as unknown as SshLogSession);
        entry.finished = true;
        const log = lstatSync(this.logPath(id));
        if (!log.isFile()) continue;
        entry.logFileBytes = log.size;
        if (this.diskBytes() + log.size + META_RESERVE > this.maxTotalBytes) {
          entry.session.state = 'failed'; entry.session.stopReason = 'recovery_error'; entry.session.error = 'Saved log exceeds the configured storage limit';
          entry.session.endedAt ??= this.isoNow(); entry.session.recordCount = 0; entry.session.byteCount = 0;
          this.sessions.set(id, entry);
          this.safePersist(entry);
          continue;
        }
        const content = readFileSync(this.logPath(id), 'utf8');
        let corrupt = false;
        let byteCount = 0;
        for (const line of content.split('\n')) {
          if (!line) continue;
          let record: unknown;
          try { record = JSON.parse(line); } catch { corrupt = true; break; }
          if (!isObject(record) || record.seq !== entry.records.length + 1 || typeof record.text !== 'string'
            || typeof record.receivedAt !== 'string' || !Number.isFinite(Date.parse(record.receivedAt))
            || (record.stream !== 'stdout' && record.stream !== 'stderr')) { corrupt = true; break; }
          if (byteCount + Buffer.byteLength(record.text) > this.maxSessionBytes) { corrupt = true; break; }
          entry.records.push(record as unknown as SshLogRecord);
          byteCount += Buffer.byteLength(record.text);
        }
        entry.session.recordCount = entry.records.length;
        entry.session.byteCount = byteCount;
        if (corrupt) {
          entry.session.state = 'failed'; entry.session.stopReason = 'recovery_error'; entry.session.error = 'Saved log has an incomplete or invalid record; recovered preceding records';
          entry.session.endedAt ??= this.isoNow();
        } else if (session.state === 'connecting' || session.state === 'running') {
          entry.session.state = 'failed'; entry.session.stopReason = 'server_restart'; entry.session.error = 'Collection was interrupted by a server restart'; entry.session.endedAt = this.isoNow();
        }
        this.sessions.set(id, entry);
        this.safePersist(entry);
      } catch {
        // Invalid foreign/partial state is never treated as a valid user session.
        continue;
      }
    }
  }

  private removeFiles(id: string): void {
    for (const path of [this.metaPath(id), `${this.metaPath(id)}.tmp`, this.logPath(id)]) {
      try { if (existsSync(path)) unlinkSync(path); this.orphanFiles.delete(path); } catch {
        try { const file = lstatSync(path); this.orphanFiles.set(path, { bytes: file.size, modifiedAt: file.mtimeMs, managed: true }); } catch { /* A concurrently removed file consumes no space. */ }
      }
    }
  }

  private trackOrphans(): void {
    const known = new Set<string>();
    for (const id of this.sessions.keys()) { known.add(this.metaPath(id)); known.add(this.logPath(id)); }
    for (const filename of readdirSync(this.stateDir)) {
      const path = join(this.stateDir, filename);
      if (known.has(path)) continue;
      const file = lstatSync(path);
      if (!file.isFile() && !file.isSymbolicLink()) continue;
      const managed = /^[0-9a-f-]{36}\.(?:meta\.json(?:\.tmp)?|jsonl)$/.test(filename);
      this.orphanFiles.set(path, { bytes: file.size, modifiedAt: file.mtimeMs, managed });
    }
  }

  private metaPath(id: string): string { return join(this.stateDir, `${id}.meta.json`); }
  private logPath(id: string): string { return join(this.stateDir, `${id}.jsonl`); }
  private isoNow(): string { return new Date(this.now()).toISOString(); }
}
