import type {
  PublicObservabilityFeedbackRecord,
  PublicObservabilityScoreRecord,
} from './public-observability-store.js';
import { resolveStudioTraceStoreEnvironment } from '../observability/studio-trace-store.js';

type PgResult = { rows: Array<Record<string, unknown>> };
type PgPool = { query: (text: string, params?: unknown[]) => Promise<PgResult> };

function databaseUrl(): string {
  return String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
}

let poolReady: Promise<PgPool> | null = null;
let schemaReady: Promise<void> | null = null;

async function pool(): Promise<PgPool> {
  const connectionString = databaseUrl();
  if (!connectionString) throw new Error('public observability database is not configured');
  if (!poolReady) {
    poolReady = import('pg' as string).then((module) => {
      const Pool = (module.default as { Pool: new (config: { connectionString: string; max: number }) => PgPool }).Pool;
      return new Pool({ connectionString, max: 2 });
    }).catch((error) => {
      poolReady = null;
      throw error;
    });
  }
  return poolReady;
}

async function ensureSchema(p: PgPool): Promise<void> {
  await p.query(`
    create table if not exists public.studio_public_observability_scores (
      score_id text primary key,
      account_scope_id text not null,
      environment text not null,
      run_id text not null,
      name text not null,
      value double precision not null,
      data_type text not null,
      source text not null,
      comment text,
      created_at timestamptz not null default now()
    );
    create index if not exists studio_public_observability_scores_run_idx
      on public.studio_public_observability_scores (account_scope_id, environment, run_id, created_at desc);
    create table if not exists public.studio_public_observability_feedback (
      feedback_id text primary key,
      account_scope_id text not null,
      environment text not null,
      run_id text not null,
      kind text not null check (kind in ('up', 'down')),
      message_id text,
      comment text,
      user_message text,
      assistant_message text,
      timeline text,
      created_at timestamptz not null default now()
    );
    create index if not exists studio_public_observability_feedback_run_idx
      on public.studio_public_observability_feedback (account_scope_id, environment, run_id, created_at desc);
  `);
}

async function database(): Promise<PgPool> {
  const p = await pool();
  if (!schemaReady) {
    schemaReady = ensureSchema(p).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
  return p;
}

function environment(): string {
  return resolveStudioTraceStoreEnvironment();
}

export async function persistPublicObservabilityScore(score: PublicObservabilityScoreRecord): Promise<void> {
  if (!databaseUrl()) return;
  const p = await database();
  await p.query(
    `insert into public.studio_public_observability_scores
       (score_id, account_scope_id, environment, run_id, name, value, data_type, source, comment, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10 / 1000.0))
     on conflict (score_id) do nothing`,
    [score.scoreId, score.owner, environment(), score.runId, score.name, score.value, score.dataType, score.source, score.comment ?? null, score.createdAt],
  );
}

export async function persistPublicObservabilityFeedback(feedback: PublicObservabilityFeedbackRecord): Promise<void> {
  if (!databaseUrl()) return;
  const p = await database();
  await p.query(
    `insert into public.studio_public_observability_feedback
       (feedback_id, account_scope_id, environment, run_id, kind, message_id, comment,
        user_message, assistant_message, timeline, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11 / 1000.0))
     on conflict (feedback_id) do nothing`,
    [feedback.feedbackId, feedback.owner, environment(), feedback.runId, feedback.kind, feedback.messageId ?? null, feedback.comment ?? null, feedback.userMessage ?? null, feedback.assistantMessage ?? null, feedback.timeline ?? null, feedback.createdAt],
  );
}

function rowTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export async function loadPublicObservabilityQuality(input: {
  owner: string;
  runId: string;
}): Promise<{ scores: PublicObservabilityScoreRecord[]; feedback: PublicObservabilityFeedbackRecord[] }> {
  if (!databaseUrl()) return { scores: [], feedback: [] };
  const p = await database();
  const env = environment();
  const [scores, feedback] = await Promise.all([
    p.query(
      `select score_id, account_scope_id, run_id, name, value, data_type, source, comment, created_at
       from public.studio_public_observability_scores
       where account_scope_id = $1 and environment = $2 and run_id = $3
       order by created_at asc`,
      [input.owner, env, input.runId],
    ),
    p.query(
      `select feedback_id, account_scope_id, run_id, kind, message_id, comment,
              user_message, assistant_message, timeline, created_at
       from public.studio_public_observability_feedback
       where account_scope_id = $1 and environment = $2 and run_id = $3
       order by created_at asc`,
      [input.owner, env, input.runId],
    ),
  ]);
  return {
    scores: scores.rows.map((row) => ({
      scoreId: String(row.score_id ?? ''),
      runId: String(row.run_id ?? input.runId),
      owner: String(row.account_scope_id ?? input.owner),
      name: String(row.name ?? 'score'),
      value: Number(row.value ?? 0),
      dataType: String(row.data_type ?? 'numeric'),
      source: String(row.source ?? 'manual'),
      ...(row.comment ? { comment: String(row.comment) } : {}),
      createdAt: rowTime(row.created_at),
    })),
    feedback: feedback.rows.map((row) => ({
      feedbackId: String(row.feedback_id ?? ''),
      runId: String(row.run_id ?? input.runId),
      owner: String(row.account_scope_id ?? input.owner),
      kind: row.kind === 'down' ? 'down' : 'up',
      ...(row.message_id ? { messageId: String(row.message_id) } : {}),
      ...(row.comment ? { comment: String(row.comment) } : {}),
      ...(row.user_message ? { userMessage: String(row.user_message) } : {}),
      ...(row.assistant_message ? { assistantMessage: String(row.assistant_message) } : {}),
      ...(row.timeline ? { timeline: String(row.timeline) } : {}),
      createdAt: rowTime(row.created_at),
    })),
  };
}
