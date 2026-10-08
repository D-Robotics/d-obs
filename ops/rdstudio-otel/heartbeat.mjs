#!/opt/node-v22.16.0-linux-x64/bin/node
// 每小时向 rdstudio-otel-collector 中央入口注入 1 条合成 ERROR span，
// 让 d-obs 的 otlp-trace-freshness 告警语义保持为「管道断了」而非「没流量」。
import { readFileSync } from 'node:fs';
import { randomBytes as rb } from 'node:crypto';

const token = readFileSync('/etc/rdstudio-otel/credentials/central-relay-token', 'utf8').trim();
const runId = `heartbeat-${new Date().toISOString().slice(0, 13)}`;
const now = Date.now();
const body = {
  resourceSpans: [{
    resource: { attributes: [
      { key: 'service.name', value: { stringValue: 'rdk-studio-agent' } },
      { key: 'rdk.telemetry.scope.ref', value: { stringValue: 'scope-v1:11111111111111111111111111111111' } },
      { key: 'moss.run.id', value: { stringValue: runId } },
    ] },
    scopeSpans: [{
      scope: { name: 'd-obs-trace-heartbeat' },
      spans: [{
        traceId: rb(16).toString('hex'),
        spanId: rb(8).toString('hex'),
        parentSpanId: '',
        name: 'moss.llm.request',
        kind: 3,
        startTimeUnixNano: `${now}000000`,
        endTimeUnixNano: `${now + 1000}000000`,
        attributes: [{ key: 'gen_ai.request.model', value: { stringValue: 'trace-heartbeat' } }],
        status: { code: 2, message: '' },
      }],
    }],
  }],
};

const response = await fetch('http://127.0.0.1:14318/v1/traces', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const text = await response.text();
console.log(`heartbeat ${runId} -> HTTP ${response.status} ${text.slice(0, 80)}`);
if (response.status !== 200) process.exit(1);
