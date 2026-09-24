#!/usr/bin/env node
/**
 * Small, dependency-free OTLP ingest benchmark.
 *
 * This is intentionally a smoke test rather than a lab-grade load generator:
 * it gives every deployment a repeatable baseline and fails loudly when the
 * configured latency budget is exceeded. It never sends prompt/completion data.
 *
 * Examples:
 *   RDK_OBS_URL=http://127.0.0.1:47110 RDK_OBS_TOKEN=... node tools/otlp-load-smoke.mjs
 *   RDK_OTLP_REQUESTS=200 RDK_OTLP_CONCURRENCY=8 node tools/otlp-load-smoke.mjs
 */
const baseUrl = String(process.env.RDK_OBS_URL || 'http://127.0.0.1:47110').replace(/\/$/, '');
const token = String(process.env.RDK_OBS_TOKEN || process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN || '').trim();
const requests = Math.max(1, Math.min(100_000, Number(process.env.RDK_OTLP_REQUESTS || 100)));
const concurrency = Math.max(1, Math.min(256, Number(process.env.RDK_OTLP_CONCURRENCY || 4)));
const spansPerRequest = Math.max(1, Math.min(64, Number(process.env.RDK_OTLP_SPANS_PER_REQUEST || 8)));
const p95BudgetMs = Math.max(1, Number(process.env.RDK_OTLP_P95_BUDGET_MS || 1000));

if (!token) {
  console.error('[otlp-load-smoke] RDK_OBS_TOKEN or RDK_PUBLIC_OBSERVABILITY_API_TOKEN is required');
  process.exit(2);
}

function span(requestIndex, spanIndex) {
  // Reserve a leading non-zero nibble so the first synthetic IDs do not become
  // the all-zero IDs rejected by OTLP validators.
  const traceId = `1${requestIndex.toString(16).padStart(23, '0')}${spanIndex.toString(16).padStart(8, '0')}`;
  const spanId = `1${requestIndex.toString(16).padStart(11, '0')}${spanIndex.toString(16).padStart(4, '0')}`;
  const now = Date.now() * 1_000_000;
  return {
    traceId,
    spanId,
    name: spanIndex === 0 ? 'load-smoke.agent' : 'load-smoke.generation',
    startTimeUnixNano: String(now),
    endTimeUnixNano: String(now + 1_000_000),
    status: { code: 1 },
    attributes: [
      { key: 'moss.run.id', value: { stringValue: `load-smoke-${requestIndex}` } },
      { key: 'service.name', value: { stringValue: 'd-obs-load-smoke' } },
      { key: 'deployment.environment.name', value: { stringValue: 'benchmark' } },
      { key: 'gen_ai.request.model', value: { stringValue: 'load-smoke-model' } },
      { key: 'gen_ai.usage.input_tokens', value: { intValue: '1' } },
      { key: 'gen_ai.usage.output_tokens', value: { intValue: '1' } },
    ],
  };
}

function payload(index) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'd-obs-load-smoke' } }] },
      scopeSpans: [{ spans: Array.from({ length: spansPerRequest }, (_, spanIndex) => span(index, spanIndex)) }],
    }],
  };
}

const latencies = [];
let next = 0;
let failed = 0;
let accepted = 0;
async function worker() {
  while (true) {
    const index = next++;
    if (index >= requests) return;
    const started = performance.now();
    try {
      const response = await fetch(`${baseUrl}/v1/traces`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload(index)),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || Number(body?.partialSuccess?.rejectedSpans || 0) > 0) failed += 1;
      else accepted += spansPerRequest;
    } catch {
      failed += 1;
    } finally {
      latencies.push(performance.now() - started);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, worker));
latencies.sort((a, b) => a - b);
const percentile = (ratio) => latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * ratio) - 1)] || 0;
const p50 = percentile(0.5);
const p95 = percentile(0.95);
console.log(JSON.stringify({ baseUrl, requests, concurrency, spansPerRequest, accepted, failed, p50Ms: Math.round(p50), p95Ms: Math.round(p95), p95BudgetMs }, null, 2));
if (failed || p95 > p95BudgetMs) process.exitCode = 1;
