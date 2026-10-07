#!/usr/bin/env node
/**
 * d-obs deployment preflight. It never prints secret values and never mutates
 * the environment or filesystem (apart from the optional state-dir probe).
 */
import { access, constants, mkdir, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const production = String(process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
const json = process.argv.includes('--json');
const checks = [];

function add(name, ok, detail, severity = ok ? 'ok' : 'error') {
  checks.push({ name, ok, severity, detail });
}

function enabled(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes';
}

function hasSecret(name, minimum = 16) {
  const value = String(process.env[name] ?? '').trim();
  return value.length >= minimum;
}

async function checkStateDirectory() {
  const target = String(process.env.RDK_ALERT_STATE_PATH ?? '/var/lib/rdstudio-alert-worker/state.json').trim();
  const directory = path.dirname(target);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const probe = path.join(directory, `.d-obs-doctor-${process.pid}-${Date.now()}.tmp`);
    const handle = await open(probe, 'wx', 0o600);
    await handle.close();
    await rm(probe, { force: true });
    add('alert-state-path', true, directory);
  } catch (error) {
    add('alert-state-path', false, `${directory}: ${error instanceof Error ? error.message : 'not writable'}`, production ? 'error' : 'warning');
  }
}

const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
add('node', major >= 22, `Node.js ${process.versions.node}; requires >=22`);
add('platform', true, `${process.platform}/${process.arch} (${os.release()})`);

const dbUrl = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
add('postgres-url', Boolean(dbUrl), dbUrl ? 'configured' : 'RDK_CHAT_CREDITS_DB_URL is missing', production ? 'error' : 'warning');
add('admin-token', hasSecret('RDK_CREDITS_ADMIN_TOKEN'), hasSecret('RDK_CREDITS_ADMIN_TOKEN') ? 'configured with sufficient length' : 'configure RDK_CREDITS_ADMIN_TOKEN', production ? 'error' : 'warning');

const publicToken = hasSecret('RDK_PUBLIC_OBSERVABILITY_API_TOKEN');
const dynamicTokens = enabled(process.env.RDK_ALLOW_DYNAMIC_OBSERVABILITY_TOKENS);
add('otlp-auth', publicToken || (!production && dynamicTokens), publicToken ? 'fixed token configured' : dynamicTokens ? 'development dynamic token mode' : 'configure RDK_PUBLIC_OBSERVABILITY_API_TOKEN', production ? 'error' : 'warning');

const metricsToken = hasSecret('RDK_OBSERVABILITY_METRICS_TOKEN');
add('metrics-auth', metricsToken || (!production && !enabled(process.env.RDK_OBSERVABILITY_REQUIRE_METRICS_TOKEN)), metricsToken ? 'metrics token configured' : 'configure RDK_OBSERVABILITY_METRICS_TOKEN', production ? 'error' : 'warning');

// Public observability metadata is a bounded process cache today. Trace and
// quality payloads are projected to their durable stores; snapshot export/import
// provides a safe handoff during restarts until a shared repository is enabled.
const persistenceMode = String(process.env.RDK_PUBLIC_OBSERVABILITY_PERSISTENCE_MODE ?? 'process-memory-cache').trim();
add(
  'public-observability-persistence',
  persistenceMode === 'process-memory-cache',
  persistenceMode === 'process-memory-cache'
    ? 'process-memory-cache; bounded with snapshot export/import; durable trace and quality projections'
    : `unsupported persistence mode: ${persistenceMode}`,
  production ? 'error' : 'warning',
);

const grpcPort = String(process.env.RDK_OTLP_GRPC_PORT ?? '').trim();
if (grpcPort) {
  const host = String(process.env.RDK_OTLP_GRPC_HOST ?? '127.0.0.1').trim();
  const loopback = host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
  const tls = Boolean(String(process.env.RDK_OTLP_GRPC_TLS_CERT_FILE ?? '').trim()) && Boolean(String(process.env.RDK_OTLP_GRPC_TLS_KEY_FILE ?? '').trim());
  add('grpc-transport', loopback || tls, loopback ? `loopback ${host}:${grpcPort}` : tls ? 'TLS certificate and key configured' : 'non-loopback gRPC requires TLS certificate and key', production ? 'error' : 'warning');
} else {
  add('grpc-transport', true, 'disabled');
}

await checkStateDirectory();

const failures = checks.filter((check) => !check.ok && check.severity === 'error');
if (json) {
  process.stdout.write(`${JSON.stringify({ ok: failures.length === 0, production, checks }, null, 2)}\n`);
} else {
  for (const check of checks) process.stdout.write(`${check.ok ? '✓' : check.severity === 'warning' ? '!' : '✗'} ${check.name}: ${check.detail}\n`);
  process.stdout.write(failures.length ? `\n${failures.length} blocking check(s) failed.\n` : '\nPreflight passed.\n');
}
process.exitCode = failures.length ? 1 : 0;
