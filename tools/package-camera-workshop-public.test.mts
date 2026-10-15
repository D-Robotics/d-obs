import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildPublicSubmissions, validatePublicListing, verifyBasePackage, type PublicListing } from './package-camera-workshop-public.mjs';
import { buildHostPackages } from './package-camera-workshop-hosts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listing = JSON.parse(await readFile(path.join(root, 'plugins/rdk-camera-workshop/distribution/public-listing.json'), 'utf8')) as PublicListing;
let base = process.env.CAMERA_VERIFIED_HOST_PACKAGES ? path.resolve(process.env.CAMERA_VERIFIED_HOST_PACKAGES) : '';
let generatedBase: string | undefined;
before(async () => {
  if (base) return;
  generatedBase = await mkdtemp(path.join(tmpdir(), 'camera-public-base-'));
  base = path.join(generatedBase, 'delivery');
  await buildHostPackages(base);
});
after(async () => { if (generatedBase) await rm(generatedBase, { recursive: true, force: true }); });

test('public metadata rejects missing publisher contact and invalid expert display fields', () => {
  validatePublicListing(listing);
  assert.throws(() => validatePublicListing({ ...listing, author: { name: listing.author.name, email: '' } }), /publisher/);
  assert.throws(() => validatePublicListing({ ...listing, tags: listing.tags.slice(1) }), /tags/);
  assert.throws(() => validatePublicListing({ ...listing, displayDescription: { ...listing.displayDescription, zh: '太短' } }), /40–50/);
});
test('submission contains a complete expert, exact inventory and truthful publication state', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'camera-public-test-'));
  try {
    const artifacts = await buildPublicSubmissions(path.join(temporary, 'submission'), base, listing);
    assert.equal(artifacts.length, 2);
    for (const artifact of artifacts) {
      assert.equal(artifact.publication, 'not_submitted');
      const directory = path.join(temporary, 'submission/rdk-camera-workshop-' + artifact.host + '-' + listing.version);
      const metadata = artifact.host === 'qoder' ? '.qoder-plugin' : '.codebuddy-plugin';
      const manifest = JSON.parse(await readFile(path.join(directory, metadata, 'plugin.json'), 'utf8'));
      assert.deepEqual(manifest.author, listing.author); assert.equal(manifest.version, listing.version);
      const inventory = JSON.parse(await readFile(path.join(directory, 'SOURCE-MANIFEST.json'), 'utf8'));
      for (const entry of inventory.files) {
        const data = await readFile(path.join(directory, entry.path));
        assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256);
      }
      const distribution = JSON.parse(await readFile(path.join(directory, 'DISTRIBUTION.json'), 'utf8'));
      assert.equal(distribution.publication, 'not_submitted'); assert.equal(distribution.hardware, 'unverified');
      const zip = path.join(temporary, 'submission', artifact.filename);
      assert.equal(spawnSync('unzip', ['-t', zip]).status, 0);
      assert.equal(createHash('sha256').update(await readFile(zip)).digest('hex'), artifact.sha256);
      if (artifact.host === 'workbuddy') {
        assert.equal(manifest.expertType, 'agent'); assert.equal(manifest.plugin, manifest.name);
        assert.deepEqual(manifest.defaultInitPrompt, manifest.quickPrompts[0]);
        assert.equal(manifest.tags.length, 3); assert.equal(manifest.quickPrompts.length, 3);
        assert.equal([...manifest.displayDescription.zh].length, 46);
        for (const file of manifest.agents) assert.ok((await readFile(path.join(directory, file), 'utf8')).includes('name: ' + manifest.agentName));
        const png = await readFile(path.join(directory, manifest.avatar));
        assert.ok(png.length < 500 * 1024); assert.equal(png.readUInt32BE(16), 512); assert.equal(png.readUInt32BE(20), 512);
      }
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
test('public builder detects a modified base instead of absorbing concurrent source content', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'camera-public-integrity-'));
  try {
    const target = path.join(temporary, 'base'); await mkdir(target); await cp(base, target, { recursive: true });
    const verified = await verifyBasePackage(target, 'qoder');
    await writeFile(path.join(verified.directory, 'README.md'), 'unexpected edit');
    await assert.rejects(verifyBasePackage(target, 'qoder'), /payload checksum mismatch/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
