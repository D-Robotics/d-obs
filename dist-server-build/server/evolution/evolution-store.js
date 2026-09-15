import { sanitizeOpsSummary } from '../monitoring/ops-event-store.js';
import { EVOLUTION_CADENCE, EVOLUTION_MODE, EVOLUTION_WORKER_VERSION, } from './evolution-policy.js';
function text(value, maxLength = 500) {
    return sanitizeOpsSummary(value, maxLength);
}
function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
function iso(value) {
    if (value instanceof Date)
        return value.toISOString();
    const raw = String(value ?? '');
    return raw && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
}
function textArray(value, limit = 20) {
    if (!Array.isArray(value))
        return [];
    return value.slice(0, limit).map((item) => text(item, 240)).filter(Boolean);
}
export async function ensureEvolutionSchema(p) {
    await p.query(`
    create table if not exists public.studio_evolution_runs (
      id uuid primary key default gen_random_uuid(),
      trigger text not null default 'schedule',
      status text not null,
      stage text not null,
      started_at timestamptz not null default now(),
      finished_at timestamptz null,
      base_revision text null,
      failure_tag text null,
      evidence_count integer not null default 0,
      source_count integer not null default 0,
      changed_files text[] not null default '{}',
      verification_passed boolean null,
      gate_report jsonb not null default '{}'::jsonb,
      safe_summary text null,
      artifact_path text null,
      created_at timestamptz not null default now()
    );
    create index if not exists studio_evolution_runs_started_idx
      on public.studio_evolution_runs (started_at desc);
    create index if not exists studio_evolution_runs_failure_idx
      on public.studio_evolution_runs (failure_tag, started_at desc);

    create table if not exists public.studio_evolution_worker_status (
      singleton boolean primary key default true check (singleton),
      enabled boolean not null default true,
      cadence text not null,
      mode text not null default 'candidate_only',
      worker_version text not null,
      current_stage text not null default 'idle',
      last_status text not null default 'never',
      last_summary text null,
      last_run_at timestamptz null,
      next_run_at timestamptz null,
      updated_at timestamptz not null default now()
    );
  `);
}
export async function loadEvolutionSignals(p, windowDays = 7) {
    const result = await p.query(`select tag.failure_tag,
            count(*)::int evidence_count,
            count(distinct concat(source, ':', source_id))::int source_count,
            max(priority)::int priority,
            max(recorded_at) latest_at
       from public.agent_evolution_candidates candidate
       cross join lateral unnest(candidate.failure_tags) tag(failure_tag)
      where candidate.recorded_at >= now() - make_interval(days => $1::int)
        and nullif(btrim(tag.failure_tag), '') is not null
      group by tag.failure_tag
      order by max(priority) desc, count(*) desc`, [Math.max(1, Math.min(30, Math.floor(windowDays)))]);
    return result.rows.map((row) => ({
        failureTag: text(row.failure_tag, 80),
        evidenceCount: number(row.evidence_count),
        sourceCount: number(row.source_count),
        priority: number(row.priority),
        latestAt: iso(row.latest_at),
    }));
}
export async function recentlyAttemptedEvolutionTags(p, readyCandidateDays = 7, rejectedCandidateHours = 20) {
    const result = await p.query(`select distinct failure_tag
       from public.studio_evolution_runs
      where failure_tag is not null
        and (
          (
            status = 'candidate_ready'
            and started_at >= now() - make_interval(days => $1::int)
          )
          or (
            status = 'rejected'
            and started_at >= now() - make_interval(hours => $2::int)
          )
        )`, [
        Math.max(1, Math.min(30, Math.floor(readyCandidateDays))),
        Math.max(1, Math.min(72, Math.floor(rejectedCandidateHours))),
    ]);
    return new Set(result.rows.map((row) => text(row.failure_tag, 80)).filter(Boolean));
}
export async function updateEvolutionWorkerStatus(p, input) {
    await p.query(`insert into public.studio_evolution_worker_status
       (singleton, enabled, cadence, mode, worker_version, current_stage,
        last_status, last_summary, last_run_at, next_run_at, updated_at)
     values (true, $1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     on conflict (singleton) do update set
       enabled = excluded.enabled,
       cadence = excluded.cadence,
       mode = excluded.mode,
       worker_version = excluded.worker_version,
       current_stage = excluded.current_stage,
       last_status = coalesce($6, studio_evolution_worker_status.last_status),
       last_summary = coalesce($7, studio_evolution_worker_status.last_summary),
       last_run_at = coalesce($8, studio_evolution_worker_status.last_run_at),
       next_run_at = coalesce($9, studio_evolution_worker_status.next_run_at),
       updated_at = now()`, [
        input.enabled ?? true,
        EVOLUTION_CADENCE,
        EVOLUTION_MODE,
        EVOLUTION_WORKER_VERSION,
        text(input.currentStage, 80) || 'idle',
        input.lastStatus ?? null,
        input.lastSummary ? text(input.lastSummary, 500) : null,
        input.lastRunAt ?? null,
        input.nextRunAt ?? null,
    ]);
}
export async function getEvolutionOverview(p) {
    try {
        const [statusResult, summaryResult, runsResult, evidenceResult] = await Promise.all([
            p.query(`select enabled, cadence, mode, worker_version, current_stage, last_status,
                last_summary, last_run_at, next_run_at
           from public.studio_evolution_worker_status
          where singleton = true`),
            p.query(`select count(*) filter (where status = 'candidate_ready')::int ready_candidates,
                count(*) filter (where verification_passed is not null)::int gated_runs,
                count(*) filter (where verification_passed = true)::int passed_runs
           from public.studio_evolution_runs
          where started_at >= now() - interval '30 days'`),
            p.query(`select id, trigger, status, stage, started_at, finished_at, failure_tag,
                evidence_count, source_count, changed_files, verification_passed, safe_summary
           from public.studio_evolution_runs
          order by started_at desc
          limit 30`),
            p
                .query(`select count(*)::int evidence_count
             from public.agent_evolution_candidates
            where recorded_at >= now() - interval '7 days'`)
                .catch((error) => {
                if (error.code === '42P01')
                    return { rows: [{}] };
                throw error;
            }),
        ]);
        const status = statusResult.rows[0] ?? {};
        const summary = summaryResult.rows[0] ?? {};
        const evidence = (evidenceResult.rows[0] ?? {});
        const gatedRuns = number(summary.gated_runs);
        return {
            enabled: status.enabled !== false,
            cadence: text(status.cadence, 120) || EVOLUTION_CADENCE,
            mode: EVOLUTION_MODE,
            workerVersion: text(status.worker_version, 32) || EVOLUTION_WORKER_VERSION,
            lastRunAt: iso(status.last_run_at),
            nextRunAt: iso(status.next_run_at),
            currentStage: text(status.current_stage, 80) || 'idle',
            lastStatus: (text(status.last_status, 40) || 'never'),
            lastSummary: text(status.last_summary, 500) || '等待首次每日进化',
            evidenceCount: number(evidence.evidence_count),
            readyCandidates: number(summary.ready_candidates),
            gatePassRate: gatedRuns > 0 ? number(summary.passed_runs) / gatedRuns : null,
            runs: runsResult.rows.map((row) => ({
                id: text(row.id, 80),
                trigger: text(row.trigger, 24),
                status: text(row.status, 40),
                stage: text(row.stage, 80),
                startedAt: iso(row.started_at),
                finishedAt: iso(row.finished_at),
                failureTag: row.failure_tag ? text(row.failure_tag, 80) : null,
                evidenceCount: number(row.evidence_count),
                sourceCount: number(row.source_count),
                changedFiles: textArray(row.changed_files),
                verificationPassed: typeof row.verification_passed === 'boolean' ? row.verification_passed : null,
                summary: text(row.safe_summary, 500),
            })),
        };
    }
    catch (error) {
        if (error.code !== '42P01')
            throw error;
        return {
            enabled: false,
            cadence: EVOLUTION_CADENCE,
            mode: EVOLUTION_MODE,
            workerVersion: EVOLUTION_WORKER_VERSION,
            lastRunAt: null,
            nextRunAt: null,
            currentStage: 'not_installed',
            lastStatus: 'never',
            lastSummary: '自我进化数据表尚未安装',
            evidenceCount: 0,
            readyCandidates: 0,
            gatePassRate: null,
            runs: [],
        };
    }
}
