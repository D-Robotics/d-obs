/** Per-run authority. Entity transactions never replace another replica's owner index. */
import type { PublicObservabilitySnapshotRun } from './public-observability-repository.js';
import type { PublicObservabilityObjectProfile } from '../../shared/public-observability-client.js';
import type { TelemetryDeletionTombstone } from '../observability/governance-deletion.js';
import { resolveStudioTraceStoreEnvironment } from '../observability/studio-trace-store.js';
import { ensureUnifiedStudioTraceSchema } from '../observability/studio-trace-schema.js';
import { ensurePublicObservabilityQualitySchema } from './public-observability-quality-store.js';

export type IndexDb = { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }> };
type Client = IndexDb & { release(): void };
type Pool = IndexDb & { connect(): Promise<Client>; end(): Promise<void>; on(event: 'error', listener: (error: Error) => void): void };
export type IndexProfile = PublicObservabilityObjectProfile & { owner: string; updatedBy: string };

export const PUBLIC_OBSERVABILITY_INDEX_SCHEMA_SQL = `
create table if not exists public.studio_public_observability_runs (
  environment text not null, run_id text not null, owner text not null, account_scope_id text not null,
  payload jsonb not null, updated_at_ms bigint not null, expires_at_ms bigint not null,
  primary key (environment, run_id)
);
alter table public.studio_public_observability_runs add column if not exists account_scope_id text;
update public.studio_public_observability_runs set account_scope_id=owner where account_scope_id is null;
alter table public.studio_public_observability_runs alter column account_scope_id set not null;
alter table public.studio_public_observability_runs add column if not exists expires_at_ms bigint;
update public.studio_public_observability_runs set expires_at_ms =
  least((payload->'run'->>'createdAt')::bigint, coalesce((payload->'run'->>'firstSpanAt')::bigint, (payload->'run'->>'createdAt')::bigint)) + 3024000000
  where expires_at_ms is null;
alter table public.studio_public_observability_runs alter column expires_at_ms set not null;
create index if not exists studio_public_observability_runs_expiry_idx
  on public.studio_public_observability_runs(environment, expires_at_ms);
create index if not exists studio_public_observability_runs_owner_idx
  on public.studio_public_observability_runs(environment, owner, updated_at_ms desc);
create table if not exists public.studio_public_observability_idempotency (
  environment text not null, owner text not null, key_id text not null, idempotency_key text not null,
  run_id text not null, primary key(environment, owner, key_id, idempotency_key),
  foreign key(environment, run_id) references public.studio_public_observability_runs(environment, run_id) on delete cascade
);
create table if not exists public.studio_public_observability_profiles (
  environment text not null, owner text not null, team text not null, object_type text not null, object_id text not null,
  payload jsonb not null, primary key(environment, owner, team, object_type, object_id)
);
`;

export const publicObservabilityAccountBarrierKey = (environment: string, account: string): string => `dobs:public-account:${environment}:${account}`;

const tombstoneMatchesRun = `t.account_scope_id in (r.account_scope_id,r.owner) and t.environment=r.environment
  and (t.user_id is null or t.user_id=t.account_scope_id)
  and (t.run_id is null or t.run_id=r.run_id)
  and (t.trace_id is null or t.trace_id=r.payload->'run'->>'traceId' or exists(select 1 from jsonb_array_elements(r.payload->'spans') fragment where fragment->>'traceId'=t.trace_id))
  and (t.session_id is null or t.session_id=r.payload->'run'->>'sessionRef' or exists(select 1 from jsonb_array_elements(r.payload->'spans') fragment where fragment->'attributes'->>'sessionRef'=t.session_id)) and t.grant_id is null`;

export class PublicObservabilityPgIndex {
  private poolReady: Promise<Pool> | null = null;
  private schemaReady: Promise<void> | null = null;
  private lastCleanupAt = 0;
  private available = false;
  isHealthy(): boolean { return this.available; }
  constructor(private readonly connectionString: string) {}
  private async pool(): Promise<Pool> {
    if (!this.poolReady) this.poolReady = import('pg' as string).then(module => {
      const p = new module.default.Pool({ connectionString: this.connectionString, max: 4, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 3_000, statement_timeout: 3_000, lock_timeout: 3_000 }) as Pool;
      p.on('error', () => { this.available = false; console.warn('[public-observability-index] idle PostgreSQL connection failed'); });
      return p;
    });
    return this.poolReady;
  }
  private async database(): Promise<Pool> {
    const p = await this.pool();
    if (!this.schemaReady) this.schemaReady = (async () => {
      const client = await p.connect();
      try {
        const markerSql = `select description as version from pg_catalog.pg_description d
          join pg_catalog.pg_class c on c.oid=d.objoid
          join pg_catalog.pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relname='studio_public_observability_runs'
            and d.classoid='pg_catalog.pg_class'::regclass and d.objsubid=0`;
        const existing = await client.query(markerSql);
        if (existing.rows[0]?.version === 'dobs-public-index-v2') return;
        await client.query('begin');
        await client.query("select pg_advisory_xact_lock(hashtextextended('dobs:public-index-schema:v1',0))");
        const locked = await client.query(markerSql);
        if (locked.rows[0]?.version === 'dobs-public-index-v2') { await client.query('commit'); return; }
        await ensureUnifiedStudioTraceSchema(client);
        await client.query(`create table if not exists public.studio_telemetry_tombstones (
          tombstone_id uuid primary key default gen_random_uuid(), request_id text not null,
          account_scope_id text not null, environment text not null check(environment in ('production','staging','development','test')),
          user_id text, run_id text, trace_id text, session_id text, grant_id text, created_at timestamptz not null default now(),
          constraint studio_telemetry_tombstones_scope_request_key unique(account_scope_id,environment,request_id),
          constraint studio_telemetry_tombstones_scope_identity_key unique(tombstone_id,account_scope_id,environment)
        )`);
        await ensurePublicObservabilityQualitySchema(client);
        await client.query(PUBLIC_OBSERVABILITY_INDEX_SCHEMA_SQL);
        await client.query("comment on table public.studio_public_observability_runs is 'dobs-public-index-v2'");
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; }
      finally { client.release(); }
    })().catch(error => { this.schemaReady = null; throw error; });
    await this.schemaReady;
    return p;
  }
  async close(): Promise<void> { if (this.poolReady) await (await this.poolReady).end(); }
  /** Physical pruning complements read guards; FK cascade removes idempotency aliases. */
  async cleanupExpired(now = Date.now()): Promise<void> {
    const db = await this.database();
    const environment = resolveStudioTraceStoreEnvironment();
    await db.query(`delete from public.studio_public_observability_runs r where (r.environment,r.run_id) in (
      select expired.environment,expired.run_id from public.studio_public_observability_runs expired
      where expired.environment=$1 and expired.expires_at_ms <= $2 order by expired.expires_at_ms limit 1000)`,[environment,now]);
    await db.query(`delete from public.studio_public_observability_runs r where r.environment=$1
      and exists(select 1 from public.studio_telemetry_tombstones t where ${tombstoneMatchesRun})`,[environment]);
    await db.query(`delete from public.studio_public_observability_profiles p where p.environment=$1 and exists(
      select 1 from public.studio_telemetry_tombstones t where t.account_scope_id=p.owner and t.environment=p.environment
        and (t.user_id is null or t.user_id=p.owner) and t.run_id is null and t.trace_id is null and t.session_id is null and t.grant_id is null)`,[environment]);
    this.lastCleanupAt = now;
  }
  private async maybeCleanup(): Promise<void> {
    if (Date.now()-this.lastCleanupAt >= 30*60_000) await this.cleanupExpired();
  }


  async mutateRun<T>(input: { owner: string; keyId: string; runId: string; idempotencyKey?: string; accountScopeId?: string }, mutate: (existing: PublicObservabilitySnapshotRun | null, runId: string, db: IndexDb, replayed: boolean) => Promise<{ result: T; snapshot: PublicObservabilitySnapshotRun }>): Promise<{ result: T; snapshot: PublicObservabilitySnapshotRun }> {
    const p = await this.database();
    await this.maybeCleanup();
    const db = await p.connect();
    const environment = resolveStudioTraceStoreEnvironment();
    try {
      await db.query('begin');
      let runId = input.runId;
      let replayed = false;
      if (input.idempotencyKey) {
        await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`dobs:public-idem:${environment}:${input.owner}:${input.keyId}:${input.idempotencyKey}`]);
        const idem = await db.query('select run_id from public.studio_public_observability_idempotency where environment=$1 and owner=$2 and key_id=$3 and idempotency_key=$4', [environment, input.owner, input.keyId, input.idempotencyKey]);
        if (idem.rows[0]) { runId = String(idem.rows[0].run_id); replayed = true; }
      }
      await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`dobs:public-run:${environment}:${runId}`]);
      const rows = await db.query('select owner,account_scope_id,payload from public.studio_public_observability_runs where environment=$1 and run_id=$2 for update', [environment,runId]);
      if (rows.rows[0] && rows.rows[0].owner !== input.owner) throw new Error('observability_run_owner_conflict');
      const previousScope = String(rows.rows[0]?.account_scope_id ?? input.owner);
      const accountScopeId = input.accountScopeId || previousScope;
      if (previousScope !== input.owner && accountScopeId !== previousScope) throw new Error('observability_run_account_conflict');
      // Tombstone insertion holds the exclusive counterpart until its commit.
      // Sharing the account barrier lets unrelated runs write concurrently.
      for (const scope of [...new Set([input.owner, accountScopeId])].sort()) {
        await db.query('select pg_advisory_xact_lock_shared(hashtextextended($1,0))',[publicObservabilityAccountBarrierKey(environment,scope)]);
      }
      const existing = rows.rows[0]?.payload as PublicObservabilitySnapshotRun | undefined;
      const outcome = await mutate(existing ?? null, runId, db, replayed);
      const run = outcome.snapshot.run;
      outcome.snapshot.feedback = outcome.snapshot.feedback.map(({ userMessage: _user, assistantMessage: _assistant, timeline: _timeline, comment: _comment, ...feedback }) => feedback);
      outcome.snapshot.scores = outcome.snapshot.scores.map(({ comment: _comment, ...score }) => score);
      const deleted = await db.query(`select 1 from public.studio_telemetry_tombstones t where t.account_scope_id=any($1::text[]) and t.environment=$2 and (t.user_id is null or t.user_id=t.account_scope_id) and (t.run_id is null or t.run_id=$3) and (t.trace_id is null or t.trace_id=any($4::text[])) and (t.session_id is null or t.session_id=any($5::text[])) and t.grant_id is null limit 1`, [[accountScopeId,input.owner],environment,runId,[...new Set([run.traceId,...outcome.snapshot.spans.map(span=>span.traceId)])],[...new Set([run.sessionRef,...outcome.snapshot.spans.map(span=>span.attributes.sessionRef)].filter((value):value is string=>typeof value==='string' && !!value))]]);
      if (deleted.rows.length) throw new Error('observability_run_deleted');
      await db.query(`insert into public.studio_public_observability_runs(environment,run_id,owner,payload,updated_at_ms,expires_at_ms,account_scope_id) values($1,$2,$3,$4::jsonb,$5,$6,$7) on conflict(environment,run_id) do update set payload=excluded.payload,updated_at_ms=excluded.updated_at_ms,expires_at_ms=excluded.expires_at_ms,account_scope_id=excluded.account_scope_id where studio_public_observability_runs.owner=excluded.owner`, [environment,runId,input.owner,JSON.stringify(outcome.snapshot),run.updatedAt,Math.min(run.createdAt,run.firstSpanAt ?? run.createdAt)+35*24*60*60_000,accountScopeId]);
      if (input.idempotencyKey) await db.query('insert into public.studio_public_observability_idempotency(environment,owner,key_id,idempotency_key,run_id) values($1,$2,$3,$4,$5) on conflict do nothing',[environment,input.owner,input.keyId,input.idempotencyKey,runId]);
      await db.query('commit');
      this.available = true;
      return outcome;
    } catch(error) { this.available = false; await db.query('rollback'); throw error; }
    finally { db.release(); }
  }

  /** PK lookup for ingest/detail paths; never hydrate the entire owner's history. */
  async loadRun(owner: string, runId: string): Promise<PublicObservabilitySnapshotRun | null> {
    const db = await this.database();
    await this.maybeCleanup();
    const environment = resolveStudioTraceStoreEnvironment();
    const rows = await db.query(`select r.payload from public.studio_public_observability_runs r
      where r.environment=$1 and r.run_id=$2 and r.owner=$3 and r.expires_at_ms>$4
        and not exists(select 1 from public.studio_telemetry_tombstones t where ${tombstoneMatchesRun}) limit 1`,[environment,runId,owner,Date.now()]);
    this.available = true;
    return (rows.rows[0]?.payload as PublicObservabilitySnapshotRun) ?? null;
  }

  async loadOwner(owner: string, _retentionMs: number): Promise<{ runs: PublicObservabilitySnapshotRun[]; profiles: IndexProfile[] }> {
    const db = await this.database();
    await this.maybeCleanup();
    const environment = resolveStudioTraceStoreEnvironment();
    const runs = await db.query(`select r.payload from public.studio_public_observability_runs r where r.environment=$1 and ($2='*' or r.owner=$2) and r.expires_at_ms > $3 and not exists(select 1 from public.studio_telemetry_tombstones t where ${tombstoneMatchesRun}) order by r.updated_at_ms desc limit 2000`,[environment,owner,Date.now()]);
    const profiles = await db.query(`select p.payload from public.studio_public_observability_profiles p where p.environment=$1 and ($2='*' or p.owner=$2) and not exists(select 1 from public.studio_telemetry_tombstones t where t.account_scope_id=p.owner and t.environment=p.environment and (t.user_id is null or t.user_id=p.owner) and t.run_id is null and t.trace_id is null and t.session_id is null and t.grant_id is null) limit 5000`,[environment,owner]);
    this.available = true;
    return { runs:runs.rows.map(row=>row.payload as PublicObservabilitySnapshotRun), profiles:profiles.rows.map(row=>row.payload as IndexProfile) };
  }

  async mutateProfile(input: { owner:string; team:string; objectType:string; objectId:string }, mutate:(existing:IndexProfile|null)=>IndexProfile): Promise<IndexProfile> {
    await this.maybeCleanup();
    const db = await (await this.database()).connect();
    const environment = resolveStudioTraceStoreEnvironment();
    const args=[environment,input.owner,input.team,input.objectType,input.objectId];
    try {
      await db.query('begin');
      await db.query('select pg_advisory_xact_lock_shared(hashtextextended($1,0))',[publicObservabilityAccountBarrierKey(environment,input.owner)]);
      await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`dobs:public-profile:${JSON.stringify(args)}`]);
      const deleted = await db.query('select 1 from public.studio_telemetry_tombstones where environment=$1 and account_scope_id=$2 and (user_id is null or user_id=$2) and run_id is null and trace_id is null and session_id is null and grant_id is null limit 1',args.slice(0,2));
      if(deleted.rows.length) throw new Error('observability_object_deleted');
      const rows = await db.query('select payload from public.studio_public_observability_profiles where environment=$1 and owner=$2 and team=$3 and object_type=$4 and object_id=$5 for update',args);
      const profile=mutate((rows.rows[0]?.payload as IndexProfile) ?? null);
      await db.query('insert into public.studio_public_observability_profiles(environment,owner,team,object_type,object_id,payload) values($1,$2,$3,$4,$5,$6::jsonb) on conflict(environment,owner,team,object_type,object_id) do update set payload=excluded.payload',[...args,JSON.stringify(profile)]);
      // Bound permanent object metadata per owner without evicting another tenant.
      await db.query(`delete from public.studio_public_observability_profiles where (environment,owner,team,object_type,object_id) in (
        select environment,owner,team,object_type,object_id from public.studio_public_observability_profiles where environment=$1 and owner=$2
        order by (payload->>'updatedAt')::bigint desc,team,object_type,object_id offset 5000)`,args.slice(0,2));
      await db.query('commit');
      this.available = true;
      return profile;
    } catch(error) { this.available = false; await db.query('rollback'); throw error; }
    finally { db.release(); }
  }
}

let cachedIndex: { url:string; index:PublicObservabilityPgIndex } | null = null;
export function configuredPublicObservabilityIndex(): PublicObservabilityPgIndex | null {
  const url=String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if(!url) return null;
  if(cachedIndex?.url !== url) cachedIndex={url,index:new PublicObservabilityPgIndex(url)};
  return cachedIndex.index;
}

export async function purgePublicObservabilityIndex(db:IndexDb,t:Readonly<TelemetryDeletionTombstone>):Promise<void> {
  // Older installations may not have enabled this additive index yet.
  const exists=await db.query("select to_regclass('public.studio_public_observability_runs') as name");
  if(!exists.rows[0]?.name || t.grantId || (t.userId && t.userId !== t.accountScopeId)) return;
  await db.query(`delete from public.studio_public_observability_runs r where r.environment=$1 and (r.account_scope_id=$2 or r.owner=$2) and ($3::text is null or r.run_id=$3) and ($4::text is null or r.payload->'run'->>'traceId'=$4 or exists(select 1 from jsonb_array_elements(r.payload->'spans') fragment where fragment->>'traceId'=$4)) and ($5::text is null or r.payload->'run'->>'sessionRef'=$5 or exists(select 1 from jsonb_array_elements(r.payload->'spans') fragment where fragment->'attributes'->>'sessionRef'=$5))`,[t.environment,t.accountScopeId,t.runId??null,t.traceId??null,t.sessionId??null]);
  if(!t.runId && !t.traceId && !t.sessionId) await db.query('delete from public.studio_public_observability_profiles where environment=$1 and owner=$2',[t.environment,t.accountScopeId]);
}
