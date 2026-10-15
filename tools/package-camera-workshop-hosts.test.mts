import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, mkdir, cp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildHostPackages, HOST_VERSION } from './package-camera-workshop-hosts.mjs';

test('host distributions remain relocatable with complete hashed payloads and self-contained skills', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'camera-host-package-test-'));
  try {
    const output = path.join(temporary, 'output'); const result = await buildHostPackages(output);
    assert.equal(result.publication, 'not_published'); assert.equal(result.artifacts.length, 4);
    for (const host of ['qoder', 'workbuddy']) {
      const directory = path.join(output, 'rdk-camera-workshop-' + host + '-' + HOST_VERSION);
      const market = JSON.parse(await readFile(path.join(directory, 'marketplace.json'), 'utf8'));
      const plugin = path.resolve(directory, market.plugins[0].source);
      const metadataDir = host === 'qoder' ? '.qoder-plugin' : '.codebuddy-plugin';
      const manifest = JSON.parse(await readFile(path.join(plugin, metadataDir, 'plugin.json'), 'utf8'));
      assert.equal(manifest.name, market.plugins[0].name); assert.equal(manifest.version, HOST_VERSION);
      const inventory = JSON.parse(await readFile(path.join(plugin, 'SOURCE-MANIFEST.json'), 'utf8'));
      for (const file of inventory.files) {
        const bytes = await readFile(path.join(plugin, file.path));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
        assert.equal(bytes.length, file.bytes);
      }
      const skill = await readFile(path.join(plugin, 'skills/rdk-camera-workshop/SKILL.md'), 'utf8');
      assert.ok(!skill.includes('requires_board:'));
      for (const match of skill.matchAll(/\]\((references\/[^)]+)\)/g)) await readFile(path.join(plugin, 'skills/rdk-camera-workshop', match[1]));
      const relocated = path.join(temporary, '移动目录 with spaces', host); await mkdir(path.dirname(relocated), { recursive: true }); await cp(plugin, relocated, { recursive: true });
      const config = JSON.parse(await readFile(path.join(relocated, '.mcp.json'), 'utf8')).mcpServers['rdk-camera-workshop'];
      const variable = host === 'qoder' ? '${QODER_PLUGIN_ROOT}' : '${CODEBUDDY_PLUGIN_ROOT}';
      assert.ok(config.args[0].startsWith(variable));
      const args = config.args.map((arg: string) => arg.replaceAll(variable, relocated));
      const child = spawnSync(process.execPath, args, { cwd: temporary, input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n', encoding: 'utf8' });
      assert.equal(child.status, 0); assert.equal(JSON.parse(child.stdout).result.protocolVersion, '2025-03-26');
      const onboarding = spawnSync(process.execPath, args, { cwd: temporary, env: { ...process.env, ...config.env, RDK_CAMERA_WORKSHOP_CONFIG: path.join(temporary, 'missing-config') }, input: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n', encoding: 'utf8' });
      assert.equal(onboarding.status, 0); assert.deepEqual(JSON.parse(onboarding.stdout).result.tools.map((tool: {name: string}) => tool.name), ['vision_connection_status']);
      const fallback = spawnSync(process.execPath, [path.join(relocated, 'mcp/setup.mjs'), 'client-config'], { cwd: temporary, encoding: 'utf8' });
      assert.equal(fallback.status, 0); assert.ok(JSON.parse(fallback.stdout).mcpServers['rdk-camera-workshop'].args[0].endsWith(path.join(host, 'mcp/bridge.mjs')));
      assert.ok(!(await readdir(plugin)).includes('plugin.json'));
    }
    for (const artifact of result.artifacts as {filename: string; sha256: string}[]) {
      const archive = await readFile(path.join(output, artifact.filename));
      assert.equal(createHash('sha256').update(archive).digest('hex'), artifact.sha256);
      const check = spawnSync('unzip', ['-t', path.join(output, artifact.filename)], { encoding: 'utf8' }); assert.equal(check.status, 0);
    }
    await assert.rejects(buildHostPackages(output), { code: 'EEXIST' });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
