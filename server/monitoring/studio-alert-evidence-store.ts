import { sanitizeOpsSummary } from './ops-event-store.js';
import type { AlertEvidence, AlertEvidenceGroup, AlertEvidenceSample } from './studio-alert-evidence-types.js';

type Pool = { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
export interface AlertEvidenceSnapshot {
  alertKey: string;
  occurredAt: string;
  evidence: AlertEvidence;
}

const schemaReady = new WeakMap<Pool, Promise<void>>();
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export function alertEvidenceTimestamp(value: unknown): string | null {
  if (value instanceof Date && !Number.isFinite(value.getTime())) return null;
  const raw = value instanceof Date ? value.toISOString() : String(value ?? '');
  const match = ISO_TIMESTAMP.exec(raw);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
      hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return null;
  const offset = (offsetHour * 60 + offsetMinute) * (match[9] === '-' ? -1 : 1);
  const local = new Date(timestamp + offset * 60_000);
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'));
  if (local.getUTCFullYear() !== year || local.getUTCMonth() + 1 !== month ||
      local.getUTCDate() !== day || local.getUTCHours() !== hour ||
      local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second ||
      local.getUTCMilliseconds() !== millisecond) return null;
  return new Date(timestamp).toISOString();
}

function safeText(value: unknown, max: number): string | null {
  return typeof value === 'string' ? sanitizeOpsSummary(value, max) || null : null;
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(parsed))) : 0;
}

/** Rebuild the allowed wire shape even when reading older or malformed JSONB. */
function boundedEvidence(value: unknown): AlertEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const windowStart = alertEvidenceTimestamp(raw.windowStart);
  const windowEnd = alertEvidenceTimestamp(raw.windowEnd);
  if (!windowStart || !windowEnd || windowStart > windowEnd || !['business', 'infrastructure'].includes(String(raw.applicability))) return null;
  const groups: AlertEvidenceGroup[] = (Array.isArray(raw.groups) ? raw.groups : []).slice(0, 8).flatMap((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const group = item as Record<string, unknown>;
    return [{
      accountId: safeText(group.accountId, 160),
      appVersion: safeText(group.appVersion, 64),
      clientType: safeText(group.clientType, 32),
      module: safeText(group.module, 160) ?? 'unknown',
      failureCount: count(group.failureCount),
      runCount: count(group.runCount),
    }];
  });
  const samples: AlertEvidenceSample[] = (Array.isArray(raw.samples) ? raw.samples : []).slice(0, 20).flatMap((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const sample = item as Record<string, unknown>;
    const occurredAt = alertEvidenceTimestamp(sample.occurredAt);
    const eventId = safeText(sample.eventId, 160);
    if (!occurredAt || !eventId) return [];
    return [{
      eventId,
      occurredAt,
      accountId: safeText(sample.accountId, 160),
      appVersion: safeText(sample.appVersion, 64),
      clientType: safeText(sample.clientType, 32),
      module: safeText(sample.module, 160) ?? 'unknown',
      toolName: safeText(sample.toolName, 160),
      failureCategory: safeText(sample.failureCategory, 80),
      failureDetail: safeText(sample.failureDetail, 500),
    }];
  });
  return {
    ...(raw.source === 'evaluation' || raw.source === 'historical-reconstruction' ? { source: raw.source } : {}),
    ...(alertEvidenceTimestamp(raw.capturedAt) ? { capturedAt: alertEvidenceTimestamp(raw.capturedAt)! } : {}),
    windowStart,
    windowEnd,
    eventCount: count(raw.eventCount),
    runCount: count(raw.runCount),
    totalGroups: Math.max(groups.length, count(raw.totalGroups)),
    groups,
    samples,
    applicability: raw.applicability as AlertEvidence['applicability'],
  };
}

export async function ensureAlertEvidenceSchema(p: Pool): Promise<void> {
  let ready = schemaReady.get(p);
  if (!ready) {
    ready = p.query(`create table if not exists public.studio_alert_evidence_snapshots (
      tenant_id text not null default 'platform',
      alert_key text not null,
      occurred_at timestamptz not null,
      evidence jsonb not null,
      primary key (tenant_id, alert_key, occurred_at)
    );
    create index if not exists studio_alert_evidence_snapshots_retention_idx
      on public.studio_alert_evidence_snapshots (occurred_at)`)
      .then(() => undefined)
      .catch((error) => { schemaReady.delete(p); throw error; });
    schemaReady.set(p, ready);
  }
  await ready;
}

/** Called only for notification transitions, never for every healthy worker tick. */
export async function recordAlertEvidenceSnapshot(p: Pool, input: {
  key: string;
  at: string;
  evidence: AlertEvidence;
  tenantId?: string;
}): Promise<void> {
  const at = alertEvidenceTimestamp(input.at);
  if (!at) throw new Error('invalid_alert_evidence_time');
  const evidence = boundedEvidence(input.evidence);
  if (!evidence) throw new Error('invalid_alert_evidence');
  await ensureAlertEvidenceSchema(p);
  await p.query(`insert into public.studio_alert_evidence_snapshots (tenant_id, alert_key, occurred_at, evidence)
    values ($1, $2, $3::timestamptz, $4::jsonb)
    on conflict (tenant_id, alert_key, occurred_at) do nothing`,
  [input.tenantId ?? 'platform', input.key, at, JSON.stringify(evidence)]);
  // Keep longer than the source operational events (30 days), with bounded storage.
  await p.query(`delete from public.studio_alert_evidence_snapshots where occurred_at < now() - interval '35 days'`);
}

export async function readAlertEvidenceSnapshot(p: Pool, key: string, at?: string, tenantId = 'platform'): Promise<AlertEvidenceSnapshot | null> {
  const timestamp = at === undefined ? null : alertEvidenceTimestamp(at);
  if (at !== undefined && !timestamp) throw new Error('invalid_alert_evidence_time');
  await ensureAlertEvidenceSchema(p);
  const result = await p.query(`select alert_key, occurred_at, evidence
    from public.studio_alert_evidence_snapshots
    where tenant_id = $1 and alert_key = $2${timestamp ? ' and occurred_at = $3::timestamptz' : ''}
    order by occurred_at desc limit 1`, timestamp ? [tenantId, key, timestamp] : [tenantId, key]);
  const row = result.rows[0];
  if (!row) return null;
  const evidence = boundedEvidence(row.evidence);
  const occurredAt = alertEvidenceTimestamp(row.occurred_at);
  return evidence && occurredAt ? { alertKey: key, occurredAt, evidence } : null;
}
