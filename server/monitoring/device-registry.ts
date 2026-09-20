/**
 * 边缘设备注册与心跳（机器人/板级设备面）。
 *
 * 设备是一等公民：每台设备有独立 256-bit token（库内只存 sha256，明文只在
 * 签发/轮换响应出现一次）、租户归属、labels 与最近心跳。心跳批量携带样本
 * （CPU/内存/温度/BPU 等任意有限数值键），边缘侧弱网时可在本地缓冲补传。
 *
 * 表结构与 tools/observability-signals-schema.sql 同源；store 首次写入时执行
 * 相同的幂等 DDL。样本保留与 logs/metrics 同参数
 * （RDK_OBSERVABILITY_SIGNAL_RETENTION_DAYS，默认 14 天）。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const METRIC_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_.]{0,63}$/;
const MAX_METRICS_PER_SAMPLE = 32;
const MAX_SAMPLES_PER_HEARTBEAT = 240;
/** 样本时间戳允许的最大回填窗口与未来偏移（补传/时钟漂移容忍）。 */
const MAX_BACKFILL_MS = 7 * 24 * 60 * 60_000;
const MAX_FUTURE_MS = 5 * 60_000;

export type DeviceRecord = {
  deviceId: string;
  displayName: string;
  tenantId: string;
  model: string;
  firmware: string;
  labels: Record<string, unknown>;
  status: 'active' | 'disabled';
  createdAt: string;
  lastSeenAt: string | null;
  online: boolean;
};

type Pool = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

let poolReady: Promise<Pool> | null = null;
async function pool(): Promise<Pool> {
  const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!connectionString) throw new Error('central database is not configured');
  if (!poolReady) {
    poolReady = (async () => {
      const pgMod = (await import('pg' as string)) as {
        default: { Pool: new (cfg: { connectionString: string; max?: number }) => Pool };
      };
      return new pgMod.default.Pool({ connectionString, max: 2 });
    })().catch((error) => {
      poolReady = null;
      throw error;
    });
  }
  return poolReady;
}

const ENSURE_SCHEMA_SQL = `
create table if not exists public.studio_devices (
  device_id text primary key,
  display_name text not null default '',
  token_hash text not null unique,
  tenant_id text not null default 'platform',
  model text not null default '',
  firmware text not null default '',
  labels jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  created_by text not null default '',
  last_seen_at timestamptz null,
  last_ip text null
);
create table if not exists public.studio_device_samples (
  device_id text not null,
  ts_ms bigint not null,
  metrics jsonb not null default '{}'::jsonb,
  primary key (device_id, ts_ms)
);
`;

let schemaReady: Promise<void> | null = null;
async function ensureSchema(p: Pool): Promise<void> {
  if (!schemaReady) {
    schemaReady = p.query(ENSURE_SCHEMA_SQL).then(() => undefined).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

function offlineMinutes(): number {
  const configured = Number(process.env.RDK_DEVICE_OFFLINE_MINUTES ?? '');
  if (!Number.isFinite(configured)) return 5;
  return Math.max(1, Math.min(120, Math.floor(configured)));
}

export function signalRetentionDays(): number {
  const configured = Number(process.env.RDK_OBSERVABILITY_SIGNAL_RETENTION_DAYS ?? '');
  if (!Number.isFinite(configured)) return 14;
  return Math.max(1, Math.min(365, Math.floor(configured)));
}

const CLEANUP_INTERVAL_MS = 30 * 60_000;
let lastCleanupAt = 0;

function maybeCleanupExpiredSamples(): void {
  if (Date.now() - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = Date.now();
  void pool()
    .then((p) => p.query(
      `delete from public.studio_device_samples
       where ts_ms < (extract(epoch from now()) * 1000 - $1::bigint * 86400000)`,
      [String(signalRetentionDays())],
    ))
    .catch(() => undefined);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\0/g, '').trim().slice(0, max) : '';
}

function parseLabels(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 16)) {
    const normalizedKey = cleanText(key, 64);
    if (!normalizedKey) continue;
    if (typeof entry === 'string') result[normalizedKey] = cleanText(entry, 120);
    else if (typeof entry === 'number' && Number.isFinite(entry)) result[normalizedKey] = entry;
    else if (typeof entry === 'boolean') result[normalizedKey] = entry;
  }
  return result;
}

function deviceOnline(lastSeenAt: Date | string | null): boolean {
  if (!lastSeenAt) return false;
  const timestamp = lastSeenAt instanceof Date ? lastSeenAt.getTime() : Date.parse(lastSeenAt);
  if (!Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp <= offlineMinutes() * 60_000;
}

function rowToDevice(row: Record<string, unknown>): DeviceRecord {
  const lastSeen = row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : row.last_seen_at ? String(row.last_seen_at) : null;
  return {
    deviceId: String(row.device_id ?? ''),
    displayName: String(row.display_name ?? ''),
    tenantId: String(row.tenant_id ?? 'platform'),
    model: String(row.model ?? ''),
    firmware: String(row.firmware ?? ''),
    labels: parseLabels(row.labels),
    status: row.status === 'disabled' ? 'disabled' : 'active',
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
    lastSeenAt: lastSeen,
    online: deviceOnline(lastSeen),
  };
}

export type RegisterDeviceInput = {
  deviceId: string;
  displayName?: string;
  tenantId?: string;
  model?: string;
  labels?: unknown;
  createdBy?: string;
};

export async function registerDevice(input: RegisterDeviceInput): Promise<{ device: DeviceRecord; token: string }> {
  const deviceId = cleanText(input.deviceId, 64);
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error('invalid_device_id');
  const token = randomBytes(32).toString('hex');
  const p = await pool();
  await ensureSchema(p);
  const result = await p.query(
    `insert into public.studio_devices (device_id, display_name, token_hash, tenant_id, model, labels, created_by)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)
     on conflict (device_id) do update set
       display_name = excluded.display_name,
       token_hash = excluded.token_hash,
       model = excluded.model,
       labels = excluded.labels,
       status = 'active'
     returning *`,
    [
      deviceId,
      cleanText(input.displayName, 120) || deviceId,
      hashToken(token),
      cleanText(input.tenantId, 40) || 'platform',
      cleanText(input.model, 80),
      JSON.stringify(parseLabels(input.labels)),
      cleanText(input.createdBy, 120) || 'admin',
    ],
  );
  return { device: rowToDevice(result.rows[0] ?? {}), token };
}

export async function rotateDeviceToken(deviceId: string): Promise<{ device: DeviceRecord; token: string }> {
  const id = cleanText(deviceId, 64);
  const token = randomBytes(32).toString('hex');
  const p = await pool();
  await ensureSchema(p);
  const result = await p.query(
    `update public.studio_devices set token_hash = $2 where device_id = $1 returning *`,
    [id, hashToken(token)],
  );
  if (!result.rows.length) throw new Error('device_not_found');
  return { device: rowToDevice(result.rows[0]), token };
}

export async function setDeviceStatus(deviceId: string, status: 'active' | 'disabled'): Promise<DeviceRecord> {
  const id = cleanText(deviceId, 64);
  const p = await pool();
  await ensureSchema(p);
  const result = await p.query(
    `update public.studio_devices set status = $2 where device_id = $1 returning *`,
    [id, status],
  );
  if (!result.rows.length) throw new Error('device_not_found');
  return rowToDevice(result.rows[0]);
}

export async function listDevices(tenantId?: string): Promise<DeviceRecord[]> {
  const p = await pool();
  await ensureSchema(p);
  const params: unknown[] = [];
  let where = '';
  if (tenantId) {
    params.push(cleanText(tenantId, 40));
    where = 'where tenant_id = $1';
  }
  const result = await p.query(
    `select * from public.studio_devices ${where} order by last_seen_at desc nulls last, device_id limit 500`,
    params,
  );
  return result.rows.map(rowToDevice);
}

// 设备 token 哈希查找带 60s 缓存：心跳每分钟一次，避免每次都打库。
const tokenCache = new Map<string, { deviceId: string; expiresAt: number }>();

function cachedDeviceIdForToken(tokenHash: string): string | null {
  const hit = tokenCache.get(tokenHash);
  if (hit && hit.expiresAt > Date.now()) return hit.deviceId;
  if (hit) tokenCache.delete(tokenHash);
  return null;
}

/** 心跳身份解析：64-hex token → device_id。无效/停用/未知一律 null（fail-closed）。 */
export async function resolveDeviceIdentity(token: unknown): Promise<string | null> {
  const presented = cleanText(token, 64);
  if (!/^[a-f0-9]{64}$/i.test(presented)) return null;
  const tokenHash = hashToken(presented);
  const cached = cachedDeviceIdForToken(tokenHash);
  if (cached) return cached;
  const p = await pool();
  await ensureSchema(p);
  const result = await p.query(
    `select device_id from public.studio_devices where token_hash = $1 and status = 'active' limit 1`,
    [tokenHash],
  );
  const deviceId = result.rows[0] ? String(result.rows[0].device_id) : null;
  if (deviceId) tokenCache.set(tokenHash, { deviceId, expiresAt: Date.now() + 60_000 });
  return deviceId;
}

export function invalidateDeviceTokenCache(): void {
  tokenCache.clear();
}

export type HeartbeatSample = { ts: number; metrics: Record<string, number> };
export type DeviceHeartbeat = {
  model: string;
  firmware: string;
  samples: HeartbeatSample[];
};

/** 心跳体解析：样本键/值全部受限；时间戳允许补传回填，拒绝远未来与超窗。 */
export function parseDeviceHeartbeat(value: unknown): DeviceHeartbeat | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const rawSamples = Array.isArray(input.samples) ? input.samples : [];
  const now = Date.now();
  const samples: HeartbeatSample[] = [];
  const seen = new Set<number>();
  for (const raw of rawSamples.slice(0, MAX_SAMPLES_PER_HEARTBEAT)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const ts = Math.trunc(Number(row.ts));
    if (!Number.isFinite(ts) || ts > now + MAX_FUTURE_MS || ts < now - MAX_BACKFILL_MS) continue;
    if (seen.has(ts)) continue;
    const rawMetrics = row.metrics && typeof row.metrics === 'object' && !Array.isArray(row.metrics)
      ? row.metrics as Record<string, unknown>
      : {};
    const metrics: Record<string, number> = {};
    for (const [key, entry] of Object.entries(rawMetrics)) {
      if (!METRIC_KEY_PATTERN.test(key) || Object.keys(metrics).length >= MAX_METRICS_PER_SAMPLE) continue;
      const numeric = Number(entry);
      if (!Number.isFinite(numeric)) continue;
      metrics[key] = Math.max(-1e12, Math.min(1e12, Math.round(numeric * 1e6) / 1e6));
    }
    if (!Object.keys(metrics).length) continue;
    seen.add(ts);
    samples.push({ ts, metrics });
  }
  return {
    model: cleanText(input.model, 80),
    firmware: cleanText(input.firmware, 80),
    samples,
  };
}

export async function recordDeviceHeartbeat(
  deviceId: string,
  heartbeat: DeviceHeartbeat,
  clientIp: string,
): Promise<{ accepted: number }> {
  const p = await pool();
  await ensureSchema(p);
  maybeCleanupExpiredSamples();
  const latest = heartbeat.samples.at(-1);
  await p.query(
    `update public.studio_devices
     set last_seen_at = now(),
         last_ip = $2,
         model = case when $3 <> '' then $3 else model end,
         firmware = case when $4 <> '' then $4 else firmware end
     where device_id = $1`,
    [cleanText(deviceId, 64), cleanText(clientIp, 64), heartbeat.model, heartbeat.firmware],
  );
  if (tokenCache.size > 4_096) tokenCache.clear();
  let accepted = 0;
  const CHUNK = 120;
  for (let offset = 0; offset < heartbeat.samples.length; offset += CHUNK) {
    const chunk = heartbeat.samples.slice(offset, offset + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((sample, index) => {
      const base = index * 3;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}::jsonb)`);
      params.push(deviceId, sample.ts, JSON.stringify(sample.metrics));
    });
    const result = await p.query(
      `insert into public.studio_device_samples (device_id, ts_ms, metrics)
       values ${values.join(',')}
       on conflict (device_id, ts_ms) do update set metrics = excluded.metrics`,
      params,
    );
    accepted += result.rows.length || chunk.length;
  }
  return { accepted };
}

export type DeviceSamplePoint = { ts: number; metrics: Record<string, number> };

export async function queryDeviceSamples(
  deviceId: string,
  options: { fromMs: number; toMs: number; maxPoints?: number },
): Promise<DeviceSamplePoint[]> {
  const p = await pool();
  await ensureSchema(p);
  const maxPoints = Math.max(20, Math.min(500, Math.floor(options.maxPoints ?? 240)));
  const bucketMs = Math.max(1, Math.ceil((options.toMs - options.fromMs) / maxPoints));
  // 键级均值聚合下推到 SQL：jsonb_each_text 展开 → 按（桶,键）avg → jsonb_object_agg
  // 还原。设备样本每行最多 32 个键，原始行先截断在 20000，组合键数有界。
  const result = await p.query(
    `with raw as (
       select (floor(ts_ms / $2::bigint) * $2::bigint)::bigint as b, metrics
         from public.studio_device_samples
        where device_id = $1 and ts_ms >= $3 and ts_ms <= $4
        order by ts_ms
        limit 20000
     ), pairs as (
       select raw.b, kv.key as metric_key, avg(kv.value::double precision) as metric_value
         from raw cross join lateral jsonb_each_text(raw.metrics) as kv(key, value)
        where kv.value ~ '^-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?$'
        group by raw.b, kv.key
     )
     select b as bucket_ts, jsonb_object_agg(metric_key, round(metric_value::numeric, 6)) as metrics
       from pairs
      group by b
      order by b`,
    [cleanText(deviceId, 64), bucketMs, Math.trunc(options.fromMs), Math.trunc(options.toMs)],
  );
  return result.rows.map((row) => {
    const metrics = parseLabels(row.metrics);
    const points: Record<string, number> = {};
    for (const [key, value] of Object.entries(metrics)) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) points[key] = numeric;
    }
    return { ts: Number(row.bucket_ts), metrics: points };
  });
}

/** 签发时的明文 token 常量时间自检（仅测试与自检用）。 */
export function deviceTokenMatches(presented: string, tokenHash: string): boolean {
  const a = Buffer.from(hashToken(presented));
  const b = Buffer.from(tokenHash);
  return a.length === b.length && timingSafeEqual(a, b);
}
