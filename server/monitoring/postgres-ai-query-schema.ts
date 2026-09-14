import { readFileSync } from 'node:fs';
import {
  getPostgresDashboardPool,
  type PostgresDashboardPool,
} from './postgres-dashboard-store.js';

type PostgresAiSchemaCheck = {
  ready: boolean;
  relation: string | null;
  readRoleReady: boolean;
};

let schemaReady: Promise<PostgresAiSchemaCheck> | null = null;
const SCHEMA_PROVISION_RETRY_DELAYS_MS = [0, 250, 1_000] as const;

function centralDbConfigured(): boolean {
  return Boolean(String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim());
}

function readPostgresAiViewsSql(): string {
  return readFileSync(new URL('./postgres-ai-query-views.sql', import.meta.url), 'utf8');
}

export function isTransientPostgresAiSchemaError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : (error ?? '')).toLowerCase();
  return /tuple concurrently updated|deadlock detected|could not serialize access|lock timeout/.test(
    message,
  );
}

async function provisionAndCheck(pool: PostgresDashboardPool): Promise<PostgresAiSchemaCheck> {
  let lastError: unknown;
  for (const delayMs of SCHEMA_PROVISION_RETRY_DELAYS_MS) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      await pool.query(readPostgresAiViewsSql());
      const check = await checkPostgresAiQuerySchema(pool);
      if (!check.ready) throw new Error('ops_ai_schema_self_check_failed');
      return check;
    } catch (error) {
      lastError = error;
      if (!isTransientPostgresAiSchemaError(error)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('ops_ai_schema_provision_failed');
}

export async function checkPostgresAiQuerySchema(
  pool: PostgresDashboardPool,
): Promise<PostgresAiSchemaCheck> {
  const result = await pool.query(
    `select to_regclass('ops_ai.conversation_turns')::text as relation,
            to_regclass('ops_ai.agent_run_records')::text as agent_relation,
            pg_has_role(current_user, 'pg_read_all_data', 'member') as read_role_ready`,
  );
  const row = result.rows[0] ?? {};
  const relation = String(row.relation ?? '').trim() || null;
  const readRoleReady = row.read_role_ready === true || row.read_role_ready === 't';
  return {
    ready: Boolean(relation && String(row.agent_relation ?? '').trim() && readRoleReady),
    relation,
    readRoleReady,
  };
}

/**
 * Idempotently provisions the AI-only schema and verifies the two anchor views.
 * The SQL file is copied next to the compiled server by copy-moss-server-assets.mjs,
 * so production and local-dev use the same DDL source.
 */
export async function ensurePostgresAiQuerySchema(): Promise<PostgresAiSchemaCheck> {
  if (!centralDbConfigured()) return { ready: false, relation: null, readRoleReady: false };
  if (!schemaReady) {
    schemaReady = (async () => {
      const pool = await getPostgresDashboardPool();
      return provisionAndCheck(pool);
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}