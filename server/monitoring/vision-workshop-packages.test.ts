import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerVisionPluginPackageRoutes } from './vision-workshop-packages.js';
import { VISION_WORKSHOP_API } from './vision-workshop-operations.js';

test('published plugin downloads enforce identity, fixed kinds, exact bytes and integrity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vision-published-packages-'));
  const bytes = Buffer.from('controlled fixture zip bytes');
  const item = { kind: 'platform', name: '相机工作坊', version: '1.1.1', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), requirements: ['trusted local host'] };
  const manifest = { schema: 'rdk.vision-plugin-packages.v1', packages: [item] };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest)); await writeFile(join(dir, 'platform.zip'), bytes);
  const app = express(); const router = express.Router();
  registerVisionPluginPackageRoutes(router, { packageDir: dir, access: (req, res, next) => { if (!req.header('x-fixture-owner')) res.status(401).json({ ok: false }); else next(); }, owner: req => req.header('x-fixture-owner') ?? 'ops-admin' });
  app.use('/dobs', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port + '/dobs' + VISION_WORKSHOP_API + '/plugin-packages';
  const headers = { 'x-fixture-owner': 'alice' };
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); });
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(base + '/platform/download', { headers: { 'x-fixture-owner': 'ops-admin' } })).status, 403);
  const metadata = await (await fetch(base, { headers })).json() as { packages: unknown[] }; assert.deepEqual(metadata.packages, [{ ...item, downloadPath: VISION_WORKSHOP_API + '/plugin-packages/platform/download' }]);
  const response = await fetch(base + '/platform/download', { headers }); assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip'); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal((await fetch(base + '/__proto__/download', { headers })).status, 404);
  assert.equal((await fetch(base + '/studio/download', { headers })).status, 404);
  await writeFile(join(dir, 'platform.zip'), Buffer.from('changed'));
  assert.equal((await fetch(base, { headers })).status, 503);
  assert.equal((await fetch(base + '/platform/download', { headers })).status, 404);
  await rm(join(dir, 'platform.zip')); await symlink(join(dir, 'manifest.json'), join(dir, 'platform.zip'));
  assert.equal((await fetch(base + '/platform/download', { headers })).status, 404);
});

test('plugin package list degrades per entry when a declared package file is missing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vision-partial-packages-'));
  const studioBytes = Buffer.from('studio fixture zip');
  const studio = { kind: 'studio', name: 'RDK Camera AI · Studio', version: '1.3.0', bytes: studioBytes.length, sha256: createHash('sha256').update(studioBytes).digest('hex'), requirements: ['RDK Studio'] };
  const platform = { kind: 'platform', name: '相机工作坊平台包', version: '1.2.1', bytes: 11, sha256: 'a'.repeat(64), requirements: ['d-obs'] };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ schema: 'rdk.vision-plugin-packages.v1', packages: [platform, studio] }));
  await writeFile(join(dir, 'studio.zip'), studioBytes);
  const app = express(); const router = express.Router();
  registerVisionPluginPackageRoutes(router, { packageDir: dir, access: (_req, _res, next) => next(), owner: () => 'alice' });
  app.use('/dobs', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port + '/dobs' + VISION_WORKSHOP_API + '/plugin-packages';
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); });
  const metadata = await (await fetch(base)).json() as { packages: Array<{ kind: string }> };
  assert.deepEqual(metadata.packages.map(entry => entry.kind), ['studio']);
  assert.equal((await fetch(base + '/studio/download')).status, 200);
  assert.equal((await fetch(base + '/platform/download')).status, 404);
});

test('classroom lesson and ZIP use the existing identity gate and verify each payload', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vision-classroom-download-'));
  const lesson = Buffer.from('<!doctype html><meta charset="utf-8"><p>视觉课件</p>');
  const plugin = Buffer.from('fixture workshop ZIP');
  const digest = (bytes: Buffer) => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  await writeFile(join(dir, 'classroom.html'), lesson);
  await writeFile(join(dir, 'classroom.zip'), plugin);
  await writeFile(join(dir, 'classroom-manifest.json'), JSON.stringify({
    schema: 'rdk.vision-workshop-classroom.v1',
    lesson: digest(lesson), plugin: digest(plugin),
  }));
  const app = express();
  const router = express.Router();
  registerVisionPluginPackageRoutes(router, {
    packageDir: dir,
    access: (req, res, next) => {
      if (!req.header('x-fixture-owner')) { res.sendStatus(401); return; }
      next();
    },
    owner: req => req.header('x-fixture-owner') ?? 'ops-admin',
  });
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const url = 'http://127.0.0.1:' + address.port + VISION_WORKSHOP_API + '/classroom';
  const headers = { 'x-fixture-owner': 'alice' };
  for (const suffix of ['', '/plugin']) {
    assert.equal((await fetch(url + suffix)).status, 401);
    assert.equal((await fetch(url + suffix, { headers: { 'x-fixture-owner': 'ops-admin' } })).status, 403);
  }
  const page = await fetch(url, { headers });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
  assert.equal(page.headers.get('cache-control'), 'private, no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.headers.get('content-security-policy') ?? '', /sandbox allow-scripts/);
  assert.doesNotMatch(page.headers.get('content-security-policy') ?? '', /allow-same-origin/);
  assert.deepEqual(Buffer.from(await page.arrayBuffer()), lesson);

  const download = await fetch(url + '/plugin', { headers });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment;.*RDK-Camera-AI-Workshop\.zip/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), plugin);

  await writeFile(join(dir, 'classroom.html'), Buffer.alloc(lesson.length));
  assert.equal((await fetch(url, { headers })).status, 503);
  assert.equal((await fetch(url + '/plugin', { headers })).status, 200);
  await rm(join(dir, 'classroom.zip'));
  await symlink(join(dir, 'classroom-manifest.json'), join(dir, 'classroom.zip'));
  assert.equal((await fetch(url + '/plugin', { headers })).status, 503);
});
