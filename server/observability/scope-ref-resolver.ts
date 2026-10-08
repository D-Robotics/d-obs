import { readFile } from 'node:fs/promises';
import { getPostgresDashboardPool } from '../monitoring/postgres-dashboard-store.js';
import { deriveStudioCollectorScopeRef } from './collector-relay-forwarder.js';
import { resolveStudioTraceStoreEnvironment } from './studio-trace-store.js';

/**
 * Reverse the app-side `rdk.telemetry.scope.ref` partition reference back to
 * the account scope id, so collector-relayed spans are attributed to the same
 * account scope the direct ingestion path uses. The reference itself is an
 * HMAC the app derives from the account scope; resolution recomputes that HMAC
 * for known accounts with the same key file, so only authenticated producers
 * holding the key can ever mint a resolvable reference.
 */

const HASH_KEY_FILE_ENV = 'RDK_OBS_SCOPE_REF_HASH_KEY_FILE';
const SCOPE_REF_PATTERN = /^scope-v1:[0-9a-f]{32}$/;
const ACCOUNTS_REFRESH_INTERVAL_MS = 10 * 60_000;
const HASH_KEY_REFRESH_INTERVAL_MS = 60_000;
const DEGRADED_LOG_INTERVAL_MS = 10 * 60_000;
const MAX_ACCOUNTS = 50_000;
const MAX_HASH_KEY_BYTES = 4_096;

export interface ScopeRefResolverDependencies {
  env?: NodeJS.ProcessEnv;
  readTextFile?: (file: string) => Promise<string>;
  listAccountScopeIds?: () => Promise<string[]>;
  now?: () => number;
}

export interface ScopeRefResolver {
  resolve(scopeRef: string): Promise<string | null>;
  reset(): void;
}

function cleanAccountScopeId(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .trim()
    .slice(0, 256);
}

async function defaultListAccountScopeIds(): Promise<string[]> {
  const pool = (await getPostgresDashboardPool()) as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  };
  const result = await pool.query(
    `select distinct trim(sso_user_id) as account
       from public.agent_run_records
      where created_at > now() - interval '90 days'
        and nullif(trim(sso_user_id), '') is not null
      limit $1::int`,
    [MAX_ACCOUNTS],
  );
  return result.rows
    .map((row) => cleanAccountScopeId(row.account))
    .filter(Boolean)
    .slice(0, MAX_ACCOUNTS);
}

export function createScopeRefResolver(
  dependencies: ScopeRefResolverDependencies = {},
): ScopeRefResolver {
  const env = dependencies.env ?? process.env;
  const readTextFile = dependencies.readTextFile ?? ((file: string) => readFile(file, 'utf8'));
  const listAccountScopeIds =
    dependencies.listAccountScopeIds ?? defaultListAccountScopeIds;
  const now = dependencies.now ?? Date.now;

  let hashKey = '';
  let hashKeyLoadedAt = -Infinity;
  let accountsByRef = new Map<string, string>();
  let accountsLoadedAt = -Infinity;
  let refreshInFlight: Promise<void> | null = null;
  let lastDegradedLogAt = -Infinity;

  async function refresh(): Promise<void> {
    const keyFile = String(env[HASH_KEY_FILE_ENV] ?? '').trim();
    if (!keyFile) {
      accountsByRef = new Map();
      hashKey = '';
      accountsLoadedAt = now();
      hashKeyLoadedAt = accountsLoadedAt;
      return;
    }
    const timestamp = now();
    if (timestamp - hashKeyLoadedAt >= HASH_KEY_REFRESH_INTERVAL_MS) {
      const rawKey = (await readTextFile(keyFile)).trim();
      if (Buffer.byteLength(rawKey, 'utf8') < 32 || Buffer.byteLength(rawKey, 'utf8') > MAX_HASH_KEY_BYTES) {
        throw new Error('scope ref hash key file has an invalid key length');
      }
      hashKey = rawKey;
      hashKeyLoadedAt = timestamp;
    }
    if (timestamp - accountsLoadedAt >= ACCOUNTS_REFRESH_INTERVAL_MS) {
      const environment = resolveStudioTraceStoreEnvironment();
      const accounts = await listAccountScopeIds();
      const next = new Map<string, string>();
      for (const account of accounts) {
        const ref = deriveStudioCollectorScopeRef({
          accountScopeId: account,
          environment,
          key: hashKey,
        });
        next.set(`${environment}\u0000${ref}`, account);
      }
      accountsByRef = next;
      accountsLoadedAt = timestamp;
    }
  }

  function scheduleRefresh(): Promise<void> {
    if (!refreshInFlight) {
      refreshInFlight = refresh().catch((error: unknown) => {
        const timestamp = now();
        if (timestamp - lastDegradedLogAt >= DEGRADED_LOG_INTERVAL_MS) {
          lastDegradedLogAt = timestamp;
          console.warn(
            '[scope-ref-resolver] resolution degraded to credential-owner attribution:',
            error instanceof Error ? error.message : error,
          );
        }
      }).finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  return {
    async resolve(scopeRef: string): Promise<string | null> {
      const reference = String(scopeRef ?? '').trim().toLowerCase();
      if (!env[HASH_KEY_FILE_ENV] || !SCOPE_REF_PATTERN.test(reference)) return null;
      const timestamp = now();
      if (
        timestamp - accountsLoadedAt >= ACCOUNTS_REFRESH_INTERVAL_MS ||
        timestamp - hashKeyLoadedAt >= HASH_KEY_REFRESH_INTERVAL_MS
      ) {
        await scheduleRefresh();
      }
      const environment = resolveStudioTraceStoreEnvironment();
      return accountsByRef.get(`${environment}\u0000${reference}`) ?? null;
    },
    reset(): void {
      hashKey = '';
      hashKeyLoadedAt = -Infinity;
      accountsByRef = new Map();
      accountsLoadedAt = -Infinity;
      refreshInFlight = null;
      lastDegradedLogAt = -Infinity;
    },
  };
}

const defaultResolver = createScopeRefResolver();

export function resolveStudioScopeRefToAccountScopeId(scopeRef: string): Promise<string | null> {
  return defaultResolver.resolve(scopeRef);
}
