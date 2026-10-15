import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../ops/rdstudio-otel/preflight.sh', import.meta.url));
const digest = data => createHash('sha256').update(data).digest('hex');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'd-obs-otel-preflight-'));
  const bin = path.join(root, 'bin'); await mkdir(bin);
  for (const [name, body] of Object.entries({
    stat: 'printf "600\\n"', systemctl: 'exit 0', logger: 'exit 0',
    curl: 'cat "$PREFLIGHT_METRICS_FIXTURE"', sha256sum: 'printf "fixture-sha256  %s\\n" "$1"',
  })) await writeFile(path.join(bin, name), '#!/bin/sh\n' + body + '\n', { mode: 0o700 });
  const config = path.join(root, 'config.yaml'); const evidence = path.join(root, 'evidence.json');
  const capability = path.join(root, 'capability.json'); const token = path.join(root, 'token');
  const state = path.join(root, 'state'); const metrics = path.join(root, 'metrics');
  await writeFile(config, 'fixture: true\n');
  await writeFile(evidence, JSON.stringify({ status: 'passed', validUntil: new Date(Date.now() + 7 * 86400000).toISOString() }));
  await writeFile(capability, JSON.stringify({
    pipelineConfigFile: config, pipelineConfigSha256: digest(await readFile(config)),
    verificationEvidenceFile: evidence, verificationEvidenceSha256: digest(await readFile(evidence)),
  }));
  await writeFile(token, 'a'.repeat(64), { mode: 0o600 });
  const envFile = path.join(root, 'collector.env');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(envFile, Object.entries({
    STUDIO_OTEL_SCOPE_ISOLATION_CAPABILITY_FILE: capability,
    STUDIO_OTEL_SCOPE_ISOLATION_EVIDENCE_FILE: evidence,
    STUDIO_OTEL_CONFIG_FILE: config,
    STUDIO_OTEL_PREFLIGHT_STATE_FILE: state,
    STUDIO_TRACE_LOCAL_OTLP_ENDPOINT: 'http://127.0.0.1:18093',
    STUDIO_TRACE_LOCAL_OTLP_TOKEN_FILE: token,
  }).map(([key, value]) => key + '=' + quote(value)).join('\n') + '\n');
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, STUDIO_OTEL_ENV_FILE: envFile, PREFLIGHT_METRICS_FIXTURE: metrics };
  for (const name of ['CAPABILITY_FILE', 'EVIDENCE_FILE', 'CONFIG_FILE']) delete env[name];
  return { root, state, capability,
    setCounter: value => writeFile(metrics, 'otelcol_exporter_sent_spans{exporter="otlp_http/local_transition"} 10\n' +
      'otelcol_exporter_send_failed_spans{exporter="otlp_http/local_transition"} ' + value + '\n'),
    run: () => spawnSync('bash', [script], { env, encoding: 'utf8' }),
  };
}

test('preflight resolves runtime paths from its environment file before checking readability', async () => {
  const f = await fixture();
  try {
    await f.setCounter(0); const result = f.run();
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /preflight\] ok/);
    await rm(f.capability);
    const missing = f.run(); assert.equal(missing.status, 1); assert.match(missing.stderr, /missing capability file:/);
    assert.doesNotMatch(missing.stderr, /unbound variable/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('exporter failure increments fail once, recover when stable, and reset their baseline on restart', async () => {
  const f = await fixture();
  try {
    await f.setCounter(0); assert.equal(f.run().status, 0);
    await f.setCounter(2); const increased = f.run();
    assert.equal(increased.status, 1); assert.match(increased.stderr, /counter increased: 0->2/);
    assert.equal(await readFile(f.state, 'utf8'), 'failed=2\n');
    assert.equal(f.run().status, 0);
    await f.setCounter(0); assert.equal(f.run().status, 0);
    await f.setCounter(1); assert.equal(f.run().status, 1);
    assert.equal(f.run().status, 0);
    await f.setCounter('invalid'); const invalid = f.run();
    assert.equal(invalid.status, 1); assert.match(invalid.stderr, /invalid exporter failure counter/);
    assert.equal(await readFile(f.state, 'utf8'), 'failed=1\n');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
