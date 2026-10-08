import assert from 'node:assert/strict';
import test from 'node:test';

import { persistStudioTraceSpans } from './studio-trace-store.js';

process.env.RDK_CHAT_CREDITS_DB_URL ||= 'postgresql://studio-trace-store-test:local@127.0.0.1/unused';

const SPAN = {
  schema: 'rdk.studio.trace-span.v1' as const,
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  runId: 'c6554a38-3889-4212-bbb3-0ca2c6467f82',
  source: 'server' as const,
  name: 'moss.session',
  startTime: 1_700_000_000_000,
  endTime: 1_700_000_001_000,
  status: 'ok' as const,
  attributes: {},
};

async function captureInsert(params: { ownerUserId: string; accountScopeId?: string }) {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const ok = await persistStudioTraceSpans({
    spans: [SPAN],
    runId: SPAN.runId,
    ...params,
    pool: {
      async query(text: string, params: unknown[] = []) {
        queries.push({ text, params });
        return { rows: [], rowCount: 1 };
      },
    },
  });
  const insert = queries.find((item) => item.text.includes('insert into public.studio_trace_spans'));
  assert.ok(insert);
  assert.equal(ok, true);
  return insert;
}

test('persists under the resolved account scope while keeping the credential owner', async () => {
  const insert = await captureInsert({
    ownerUserId: 'public_collectorowner',
    accountScopeId: 'lx199710',
  });
  assert.equal(insert.params[0], 'lx199710');
  assert.equal(insert.params[2], 'public_collectorowner');
});

test('falls back to the credential owner as the account scope by default', async () => {
  const insert = await captureInsert({ ownerUserId: 'public_collectorowner' });
  assert.equal(insert.params[0], 'public_collectorowner');
  assert.equal(insert.params[2], 'public_collectorowner');
});
