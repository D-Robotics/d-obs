import { createStudioTraceContentEntry, type StudioTraceContent } from '../../shared/studio-trace-content.js';
import type { StudioDeploymentEnvironment } from '../../shared/studio-observability.js';
import { runDisplayRef, scopedDisplayRef } from './run-locator.js';

type ContextDb = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};
type Scope = { accountScopeId: string; environment: StudioDeploymentEnvironment };
type Body = StudioTraceContent & { availability: 'available' };
export interface RunConversationTurn {
  turnRef: string;
  runRef: string | null;
  recordedAt: string;
  content: Body | { availability: 'expired' | 'not_captured' };
}
export interface RunConversationContext {
  binding: 'bound' | 'unbound' | 'conflict';
  basis: 'canonical_run_id_and_session_id';
  runRef: string;
  sessionRef: string | null;
  currentTurn: { availability: 'available'; turn: RunConversationTurn } |
    { availability: 'missing' | 'expired' | 'unavailable' | 'conflict' | 'unbound' };
  history: {
    availability: 'available' | 'missing' | 'unavailable' | 'unbound' | 'conflict';
    basis: 'archived_session_turns_before_run';
    turns: RunConversationTurn[];
    truncated: boolean;
  };
}

const HISTORY_LIMIT = 8;
const BODY_RETENTION_MS = 7 * 24 * 60 * 60_000;
// Legacy archives have no authoritative environment; do not guess it from time
// or client type when exposing dialogue bodies through a scoped Trace read.
const environmentSql = `c.environment`;
// The same account/environment/session boundaries apply to metadata and bodies.
// Run/trace/session deletions cannot reappear through the conversation archive.
const tombstoneSql = `not exists (
  select 1 from public.studio_telemetry_tombstones t
  where t.account_scope_id = $1 and t.environment = $2
    and (t.user_id is null or t.user_id = c.sso_user_id)
    and (t.session_id is null or t.session_id = c.session_id)
    and (t.run_id is null or t.run_id = c.run_id)
    -- Trace deletion removes the spans themselves. Use durable Run/session
    -- tombstone keys; unresolved trace-only tombstones fail closed for archives.
    and t.grant_id is null
)`;
const columns = `c.id, c.session_id, c.session_id = $4::text session_matches,
  c.run_id, c.recorded_at,
  case when c.recorded_at > $5::timestamptz then c.user_message else null end user_message,
  case when c.recorded_at > $5::timestamptz then c.assistant_message else null end assistant_message,
  c.recorded_at <= $5::timestamptz content_expired`;

function mapTurn(row: Record<string, unknown>, scope: Scope): RunConversationTurn | null {
  const id = String(row.id ?? '').trim();
  const time = row.recorded_at instanceof Date ? row.recorded_at.getTime() : Date.parse(String(row.recorded_at ?? ''));
  if (!id || !Number.isFinite(time)) return null;
  const runId = String(row.run_id ?? '').trim();
  const content: StudioTraceContent = {
    schema: 'rdk.studio.trace-content.v1', entries: [], redacted: false, truncated: false,
  };
  if (row.content_expired !== true) {
    for (const [kind, value] of [['user_input', row.user_message], ['model_output', row.assistant_message]] as const) {
      if (typeof value !== 'string' || !value) continue;
      const entry = createStudioTraceContentEntry(kind, value);
      if (!entry) continue;
      content.entries.push(...entry.entries);
      content.redacted ||= entry.redacted;
      content.truncated ||= entry.truncated;
    }
  }
  return {
    // Archive IDs never leave the scoped response in raw form.
    turnRef: 'turn-' + runDisplayRef(scope.accountScopeId, scope.environment, id).slice(4),
    runRef: runId ? runDisplayRef(scope.accountScopeId, scope.environment, runId) : null,
    recordedAt: new Date(time).toISOString(),
    content: row.content_expired === true ? { availability: 'expired' } : content.entries.length
      ? { ...content, availability: 'available' } : { availability: 'not_captured' },
  };
}

/** Called only after a scoped Run locator and its authoritative fact have been verified. */
export async function readRunConversationContext(input: {
  db: ContextDb; scope: Scope; runId: string; sessionId: string;
  startedAt: string | null; now: number; identifierConflict?: boolean;
}): Promise<RunConversationContext> {
  const { db, scope, runId, sessionId } = input;
  const binding = input.identifierConflict ? 'conflict' : sessionId ? 'bound' : 'unbound';
  const context: RunConversationContext = {
    binding, basis: 'canonical_run_id_and_session_id',
    runRef: runDisplayRef(scope.accountScopeId, scope.environment, runId),
    sessionRef: scopedDisplayRef('session', scope.accountScopeId, scope.environment, sessionId),
    currentTurn: { availability: binding === 'bound' ? 'missing' : binding },
    history: { availability: binding === 'bound' ? 'missing' : binding,
      basis: 'archived_session_turns_before_run', turns: [], truncated: false },
  };
  if (binding !== 'bound') return context;
  const cutoff = new Date(input.now - BODY_RETENTION_MS).toISOString();
  const params = [scope.accountScopeId, scope.environment, runId, sessionId, cutoff];
  const [current, history] = await Promise.allSettled([
    db.query(`select ${columns}
      from public.conversation_turns c
      where c.sso_user_id = $1 and ${environmentSql} = $2
        and c.run_id = $3 and ${tombstoneSql}
        and c.recorded_at <= $6::timestamptz
        and c.recorded_at > $5::timestamptz - interval '28 days'
      order by c.recorded_at desc, c.id desc limit 2`, [...params, new Date(input.now).toISOString()]),
    input.startedAt ? db.query(`select ${columns}
      from public.conversation_turns c
      where c.sso_user_id = $1 and ${environmentSql} = $2 and c.session_id = $4
        and c.recorded_at < $6::timestamptz
        and (c.run_id is null or c.run_id <> $3)
        and c.recorded_at > $5::timestamptz - interval '28 days'
        and ${tombstoneSql}
      order by c.recorded_at desc, c.id desc limit ${HISTORY_LIMIT + 1}`,
      [...params, input.startedAt]) : Promise.resolve({ rows: [] }),
  ]);
  if (current.status === 'rejected') context.currentTurn = { availability: 'unavailable' };
  else if (current.value.rows.length > 1 || current.value.rows.some(row => String(row.session_id ?? '') !== sessionId)) {
    context.binding = 'conflict';
    context.currentTurn = { availability: 'conflict' };
    context.history.availability = 'conflict';
    return context;
  } else if (current.value.rows[0]) {
    const turn = mapTurn(current.value.rows[0], scope);
    context.currentTurn = !turn ? { availability: 'unavailable' } : turn.content.availability === 'expired'
      ? { availability: 'expired' } : { availability: 'available', turn };
  }
  if (history.status === 'rejected') context.history.availability = 'unavailable';
  else {
    context.history.truncated = history.value.rows.length > HISTORY_LIMIT;
    context.history.turns = history.value.rows.slice(0, HISTORY_LIMIT).reverse()
      .map(row => mapTurn(row, scope)).filter((turn): turn is RunConversationTurn => turn !== null);
    context.history.availability = context.history.turns.length ? 'available' : 'missing';
  }
  return context;
}
