import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { packageStudioCameraWorkshop, verifyStudioArchive } from './package-camera-workshop-studio.mts';
import { VISION_X5_IMX415_KNOWLEDGE } from '../server/monitoring/vision-workshop-x5-imx415-knowledge.ts';

const digest = data => createHash('sha256').update(data).digest('hex');
async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'studio-camera-package-'));
  const source = path.join(temporary, 'studio'); const root = path.join(source, 'plugins/rdk-camera-workshop');
  const files = {
    'plugin.json': JSON.stringify({ name: 'rdk-camera-workshop', version: '1.2.1', skills: './skills/', mcpServers: './.mcp.json' }),
    '.mcp.json': JSON.stringify({ mcpServers: { 'rdk-camera-workshop': { transport: 'stdio', command: 'node', args: ['mcp/server.mjs'] } } }),
    'README.md': '[Skill](skills/rdk-camera-workshop/SKILL.md)\n',
    'mcp/server.mjs': '// fixture-native-companion: no hardware or network operations\n',
    'mcp/server.test.mjs': 'secret intentionally excluded from package: 10.1.2.3',
    'skills/rdk-camera-workshop/SKILL.md': '---\nname: rdk-camera-workshop\nversion: 1.2.1\n---\n[Compatibility](references/compatibility.md)\n[Knowledge](../../knowledge/x5-yahboom-imx415.json)\n',
    'skills/rdk-camera-workshop/references/compatibility.md': '# Fixture documentation, no hardware claim\n',
    'skills/rdk-camera-workshop/fixtures/private.json': '{"privateAddress":"10.1.2.3"}',
    'knowledge/x5-yahboom-imx415.json': JSON.stringify(VISION_X5_IMX415_KNOWLEDGE),
    'private.json': '{"privateAddress":"10.1.2.3"}',
  };
  for (const [name, text] of Object.entries(files)) { const target = path.join(root, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text); }
  return { temporary, source, root, output: path.join(temporary, 'candidate'), cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

test('Studio package freezes native companion, complete knowledge, portable references and every source checksum', async () => {
  const env = await fixture();
  try {
    const report = await packageStudioCameraWorkshop(env.source, env.output);
    assert.equal(report.version, '1.2.1'); assert.equal(report.deployment, 'not_deployed');
    const zip = await readFile(report.archivePath); assert.equal(digest(zip), report.archive.sha256);
    const sourceManifest = JSON.parse(await readFile(path.join(report.studioDirectory, 'SOURCE-MANIFEST.json'), 'utf8'));
    const names = sourceManifest.files.map(file => file.path);
    assert.equal(names.some(name => /private|fixture|\.test\./.test(name)), false);
    assert.ok(names.includes('rdk-camera-workshop/skills/rdk-camera-workshop/references/compatibility.md'));
    const entries = [];
    for (const file of sourceManifest.files) {
      const local = file.path.slice('rdk-camera-workshop/'.length); const data = await readFile(path.join(report.studioDirectory, local));
      assert.equal(data.length, file.bytes); assert.equal(digest(data), file.sha256); entries.push({ name: file.path, data });
    }
    const checksums = await readFile(path.join(report.studioDirectory, 'SOURCE-MANIFEST.json'));
    entries.push({ name: 'rdk-camera-workshop/SOURCE-MANIFEST.json', data: checksums });
    verifyStudioArchive(zip, entries);
    const damaged = Buffer.from(zip); damaged[damaged.indexOf('fixture-native-companion')] ^= 1;
    assert.throws(() => verifyStudioArchive(damaged, entries));
    for (const local of ['.mcp.json', 'mcp/server.mjs']) assert.deepEqual(await readFile(path.join(report.studioDirectory, local)), await readFile(path.join(env.root, local)));
    assert.deepEqual(JSON.parse(await readFile(path.join(report.studioDirectory, 'knowledge/x5-yahboom-imx415.json'), 'utf8')), JSON.parse(JSON.stringify(VISION_X5_IMX415_KNOWLEDGE)));
  } finally { await env.cleanup(); }
});

for (const fault of ['broken-reference', 'private-address', 'stale-knowledge', 'wrong-companion', 'symlink-reference']) test('Studio packaging rejects ' + fault, async () => {
  const env = await fixture();
  try {
    const reference = path.join(env.root, 'skills/rdk-camera-workshop/references/compatibility.md');
    if (fault === 'broken-reference') await writeFile(reference, '[Invalid](missing.md)');
    if (fault === 'private-address') await writeFile(reference, 'Private board endpoint: 10.1.2.3');
    if (fault === 'stale-knowledge') await writeFile(path.join(env.root, 'knowledge/x5-yahboom-imx415.json'), JSON.stringify({ ...VISION_X5_IMX415_KNOWLEDGE, diagnosticCases: [] }));
    if (fault === 'wrong-companion') await writeFile(path.join(env.root, '.mcp.json'), JSON.stringify({ mcpServers: { 'rdk-camera-workshop': { command: 'node', args: ['mcp/bridge.mjs'] } } }));
    if (fault === 'symlink-reference') { await rm(reference); await symlink(path.join(env.root, 'README.md'), reference); }
    await assert.rejects(packageStudioCameraWorkshop(env.source, env.output));
  } finally { await env.cleanup(); }
});
