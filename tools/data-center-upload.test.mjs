import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataCenterUploadError, MAX_DATA_ASSET_BYTES, dataCenterUploadMain, parseDataCenterUploadArgs, uploadDataCenterAsset, validateDataCenterOrigin } from './data-center-upload.mjs';

const TASK = '87f0d2c8-e1fc-4ba5-8d47-9c7bdb8eb031';
const ASSET = 'a763ef4e-53cf-4887-88b2-7b522be82a1d';
const TOKEN = 'T'.repeat(43);
const ENV = { RDK_DATA_COLLECTION_TOKEN: TOKEN };
const BYTES = Buffer.from('fixture only: real binary bytes\x00\x01\xff');
const sha = value => createHash('sha256').update(value).digest('hex');
const receipt = (bytes = BYTES) => ({ ok: true, contract: 'rdk.data-center.v1', asset: { id: ASSET, sha256: sha(bytes), sizeBytes: bytes.length, owner: 'PRIVATE_ACCOUNT' } });

async function fileFixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'data-upload-test-'));
  const filePath = join(dir, 'capture.bin'); await writeFile(filePath, BYTES);
  try { return await run({ dir, filePath }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
async function httpFixture(handler, run) {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks); requests.push({ path: request.url, headers: request.headers, bytes });
      await handler(request, response, bytes);
    } catch { if (!response.destroyed) response.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { return await run(`http://127.0.0.1:${server.address().port}/dobs`, requests); }
  finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
function json(response, status, body) { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)); }
function isError(code, status, unknown = false) {
  return error => error instanceof DataCenterUploadError && error.code === code && error.httpStatus === status && error.outcomeUnknown === unknown;
}

test('real HTTP upload sends true bytes/hash, scoped token and encoded metadata under the deployment prefix', async () => {
  await fileFixture(async ({ filePath }) => httpFixture((request, response, bytes) => {
    assert.equal(request.url, `/dobs/api/data-center/ingest/${TASK}`);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['x-collection-token'], TOKEN);
    assert.equal(request.headers['content-type'], 'application/octet-stream');
    assert.deepEqual(bytes, BYTES);
    assert.deepEqual(JSON.parse(decodeURIComponent(request.headers['x-data-asset'])), { filename: 'capture.bin', mimeType: 'application/octet-stream', sha256: sha(BYTES), title: '逆光场景' });
    json(response, 201, receipt(bytes));
  }, async origin => {
    const result = await uploadDataCenterAsset({ origin, taskId: TASK, filePath, title: '逆光场景' }, { env: ENV });
    assert.deepEqual(result, { id: ASSET, hash: sha(BYTES), bytes: BYTES.length, httpStatus: 201 });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ACCOUNT|TTTT|capture.bin|scene/);
  }));
});

test('origin validation rejects remote HTTP, credentials and normalized/encoded traversal before network access', () => {
  for (const origin of ['http://example.com/dobs', 'http://127.0.0.1.evil.test', 'ftp://127.0.0.1', 'https://user:secret@example.com/dobs', 'https://example.com/dobs?token=secret', 'https://example.com/dobs#fragment', 'https://example.com/a/../dobs', 'https://example.com/%2e%2e/dobs', 'https://example.com/%252e%252e/dobs', 'https://example.com/dobs%2fother', 'https://example.com/dobs%0aother', 'https://example.com\\dobs', 'https://example.com/dobs//other']) assert.throws(() => validateDataCenterOrigin(origin), DataCenterUploadError);
  assert.equal(validateDataCenterOrigin('https://example.com/dobs/'), 'https://example.com/dobs');
  assert.equal(validateDataCenterOrigin('http://127.0.0.1:1234/'), 'http://127.0.0.1:1234');
  assert.equal(validateDataCenterOrigin('http://[::1]:1234'), 'http://[::1]:1234');
});

test('arguments accept only declared options and reject tokens, duplicate options and malformed tasks', async () => {
  assert.deepEqual(parseDataCenterUploadArgs(['--help']), { help: true });
  assert.deepEqual(parseDataCenterUploadArgs(['--origin', 'https://example.com', '--task', TASK, '--file', 'file.bin']), { origin: 'https://example.com', taskId: TASK, filePath: 'file.bin' });
  for (const args of [['--token', TOKEN], ['--origin'], ['--file', 'a', '--file', 'b'], ['--origin', 'https://example.com', '--task', TASK]]) assert.throws(() => parseDataCenterUploadArgs(args), DataCenterUploadError);
  await assert.rejects(uploadDataCenterAsset({ origin: 'https://example.com', taskId: '../escape', filePath: 'unused' }, { env: ENV }), isError('invalid_task_id'));
  for (const token of [undefined, 'short', 'T'.repeat(43) + '\n', ' '.repeat(43), '../'.repeat(15)]) await assert.rejects(uploadDataCenterAsset({ origin: 'https://example.com', taskId: TASK, filePath: 'unused' }, { env: { RDK_DATA_COLLECTION_TOKEN: token } }), isError('collection_token_required'));
});

test('directory, symlink, empty and traversal file paths never issue a request', async () => {
  await fileFixture(async ({ dir, filePath }) => {
    const link = join(dir, 'link.bin'); await symlink(filePath, link);
    const empty = join(dir, 'empty'); await writeFile(empty, '');
    let calls = 0;
    const dependencies = { env: ENV, fetchImpl: () => { calls++; throw new Error('must not send'); } };
    for (const [path, code] of [[dir, 'regular_file_required'], [link, 'regular_file_required'], [empty, 'empty_file'], [`${dir}/../capture.bin`, 'invalid_file']]) await assert.rejects(uploadDataCenterAsset({ origin: 'https://example.com', taskId: TASK, filePath: path }, dependencies), isError(code));
    assert.equal(calls, 0);
  });
});

test('64 MiB is accepted, while 64 MiB plus one is rejected before upload', async () => {
  await fileFixture(async ({ filePath }) => {
    let handle = await open(filePath, 'w'); await handle.truncate(MAX_DATA_ASSET_BYTES); await handle.close();
    let calls = 0;
    const fetchImpl = async (_url, options) => {
      calls++; assert.equal(options.body.length, MAX_DATA_ASSET_BYTES);
      return new Response(JSON.stringify(receipt(options.body)), { status: 201, headers: { 'content-type': 'application/json' } });
    };
    const result = await uploadDataCenterAsset({ origin: 'https://example.com', taskId: TASK, filePath }, { env: ENV, fetchImpl });
    assert.equal(result.bytes, MAX_DATA_ASSET_BYTES); assert.equal(calls, 1);
    handle = await open(filePath, 'w'); await handle.truncate(MAX_DATA_ASSET_BYTES + 1); await handle.close();
    await assert.rejects(uploadDataCenterAsset({ origin: 'https://example.com', taskId: TASK, filePath }, { env: ENV, fetchImpl }), isError('file_too_large'));
    assert.equal(calls, 1);
  });
});

test('HTTP rejections preserve status, suppress arbitrary response data and never retry', async () => {
  await fileFixture(async ({ filePath }) => {
    for (const [status, code, unknown] of [[401, 'collection_unauthorized', false], [403, 'collection_unauthorized', false], [409, 'upload_conflict', false], [413, 'upload_too_large', false], [422, 'upload_checksum_rejected', false], [429, 'upload_rejected', false], [500, 'server_error', true], [503, 'server_error', true]]) {
      await httpFixture((_req, res) => json(res, status, { token: TOKEN, account: 'PRIVATE_ACCOUNT' }), async (origin, requests) => {
        await assert.rejects(uploadDataCenterAsset({ origin, taskId: TASK, filePath }, { env: ENV }), isError(code, status, unknown));
        assert.equal(requests.length, 1);
      });
    }
  });
});

test('successful transport still rejects mismatched checksums, size, contract or invalid receipts', async () => {
  await fileFixture(async ({ filePath }) => {
    for (const [body, code] of [[{ ...receipt(), asset: { ...receipt().asset, sha256: '0'.repeat(64) } }, 'receipt_checksum_mismatch'], [{ ...receipt(), asset: { ...receipt().asset, sizeBytes: 999 } }, 'receipt_checksum_mismatch'], [{ ...receipt(), contract: 'wrong' }, 'invalid_receipt'], [{ ...receipt(), asset: { ...receipt().asset, id: '../secret' } }, 'invalid_receipt']]) {
      await httpFixture((_req, res) => json(res, 201, body), async origin => assert.rejects(uploadDataCenterAsset({ origin, taskId: TASK, filePath }, { env: ENV }), isError(code, 201, true)));
    }
    await httpFixture((_req, res) => res.writeHead(201, { 'content-type': 'text/html' }).end('PRIVATE_ACCOUNT'), async origin => assert.rejects(uploadDataCenterAsset({ origin, taskId: TASK, filePath }, { env: ENV }), isError('invalid_response', 201, true)));
    await httpFixture((_req, res) => res.writeHead(201, { 'content-type': 'application/json' }).end('{'), async origin => assert.rejects(uploadDataCenterAsset({ origin, taskId: TASK, filePath }, { env: ENV }), isError('invalid_response', 201, true)));
  });
});

test('redirects are rejected without forwarding the task credential', async () => {
  await fileFixture(async ({ filePath }) => httpFixture((_req, res) => res.writeHead(307, { location: '/credential-sink' }).end(), async (origin, requests) => {
    await assert.rejects(uploadDataCenterAsset({ origin, taskId: TASK, filePath }, { env: ENV }), isError('upload_transport_error', undefined, true));
    assert.equal(requests.length, 1);
  }));
});

test('bounded response and timeout become unknown outcomes and do not trigger duplicate submission', async () => {
  await fileFixture(async ({ filePath }) => {
    await httpFixture((_req, res) => res.writeHead(201, { 'content-type': 'application/json' }).end('x'.repeat(65 * 1024)), async origin => assert.rejects(uploadDataCenterAsset({ origin, taskId: TASK, filePath }, { env: ENV }), isError('response_too_large', 201, true)));
    await httpFixture(() => {}, async (origin, requests) => {
      await assert.rejects(uploadDataCenterAsset({ origin, taskId: TASK, filePath }, { env: ENV, timeoutMs: 30 }), isError('upload_timeout', undefined, true));
      assert.equal(requests.length, 1);
    });
  });
});

test('CLI output contains only the receipt summary; uncertainty explicitly asks to query before retry', async () => {
  await fileFixture(async ({ filePath }) => {
    let stdout = ''; let stderr = '';
    const sink = { stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } }, env: ENV };
    const args = ['--origin', 'https://example.com/dobs', '--task', TASK, '--file', filePath];
    assert.equal(await dataCenterUploadMain(args, { ...sink, fetchImpl: async () => new Response(JSON.stringify(receipt()), { status: 201, headers: { 'content-type': 'application/json' } }) }), 0);
    assert.deepEqual(JSON.parse(stdout), { id: ASSET, hash: sha(BYTES), bytes: BYTES.length, httpStatus: 201 });
    assert.equal(stderr, ''); stdout = '';
    assert.equal(await dataCenterUploadMain(args, { ...sink, fetchImpl: async () => { throw new Error(`PRIVATE_ACCOUNT ${TOKEN}`); } }), 1);
    assert.equal(stdout, ''); assert.match(stderr, /"outcome":"unknown"/); assert.match(stderr, /Query the collection task/);
    assert.doesNotMatch(stderr, /PRIVATE_ACCOUNT|TTTT|example.com|capture.bin/);
  });
});

test('CLI interoperates with the real collection handler using a private fixture state and no production writes', async () => {
  const { register } = await import('tsx/esm/api');
  const loader = register({ namespace: 'data-center-upload-handler-fixture' });
  try {
    const { DataCenterService } = await loader.import('../server/monitoring/data-center-service.js', import.meta.url);
    const { registerDataCenterRoutes } = await loader.import('../server/monitoring/data-center-routes.js', import.meta.url);
    const { default: express } = await import('express');
    await fileFixture(async ({ dir, filePath }) => {
      const service = new DataCenterService({ dataDir: join(dir, 'private-state') });
      const owner = 'sso:collection-fixture-owner';
      const task = await service.createTask(owner, { title: 'Fixture capture', source: 'edge', project: 'fixture-project', targetId: 'fixture-board', kind: 'raw', expectedCount: 1 });
      let credential = await service.rotateCollectionToken(owner, task.id);
      const app = express(); app.use(express.json({ limit: '1mb' }));
      const router = express.Router(); registerDataCenterRoutes(router, { getService: () => service }); app.use('/dobs', router);
      const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
      const origin = `http://127.0.0.1:${server.address().port}/dobs`;
      const input = { origin, taskId: task.id, filePath };
      try {
        const dependencies = { env: { RDK_DATA_COLLECTION_TOKEN: credential.token } };
        const first = await uploadDataCenterAsset(input, dependencies);
        const repeat = await uploadDataCenterAsset(input, dependencies);
        assert.equal(first.httpStatus, 201); assert.equal(first.id, repeat.id);
        assert.deepEqual((await service.readAsset(owner, first.id)).data, BYTES);
        assert.equal((await service.listTasks(owner))[0].assetIds.length, 1);
        assert.deepEqual(await service.listAssets('sso:other-fixture-owner'), []);
        await assert.rejects(uploadDataCenterAsset({ ...input, taskId: TASK }, dependencies), isError('collection_unauthorized', 403));
        credential = await service.rotateCollectionToken(owner, task.id);
        await assert.rejects(uploadDataCenterAsset(input, dependencies), isError('collection_unauthorized', 403));
        assert.equal((await uploadDataCenterAsset(input, { env: { RDK_DATA_COLLECTION_TOKEN: credential.token } })).id, first.id);
        await service.updateTaskStatus(owner, task.id, { status: 'completed' });
        await assert.rejects(uploadDataCenterAsset(input, { env: { RDK_DATA_COLLECTION_TOKEN: credential.token } }), isError('collection_unauthorized', 403));
      } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    });
  } finally { await loader.unregister(); }
});
