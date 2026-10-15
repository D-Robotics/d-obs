import { mkdir, readFile, readdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAMERA_WORKSHOP_PLUGIN_TEMPLATE } from '../server/plugins/plugin-camera-workshop.js';
import { VISION_CAMERA_FIELD_EXPERIENCE } from '../server/monitoring/vision-workshop-field-experience.js';
import { VISION_X5_IMX415_KNOWLEDGE } from '../server/monitoring/vision-workshop-x5-imx415-knowledge.js';
import { createVisionArchive, type VisionArchiveEntry } from '../server/monitoring/vision-workshop-export.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] ?? path.join(root, 'output', 'plugins'));
const source = path.join(root, 'plugins', 'rdk-camera-workshop');
const manifest = JSON.parse(await readFile(path.join(source, 'plugin.json'), 'utf8')) as { version: string };
const version = manifest.version;
const skillHeader = (await readFile(path.join(source, 'skills', 'rdk-camera-workshop', 'SKILL.md'), 'utf8')).split('---')[1] ?? '';
const skillVersion = /^version:\s*(\d+\.\d+\.\d+)\s*$/m.exec(skillHeader)?.[1];
if (skillVersion !== version) throw new Error('Camera plugin skill version mismatch');
if (!/^\d+\.\d+\.\d+$/.test(version) || CAMERA_WORKSHOP_PLUGIN_TEMPLATE.manifest.version !== version) throw new Error('Camera plugin version mismatch');
const target = path.join(output, 'rdk-camera-workshop-' + version);
const copiedPaths = new Set<string>();
const nativeTestPaths = new Set(['backend_test.c', 'modules_test.c', 'replay_test.c'].map(name => 'tools/vision-x5-native/tests/' + name));
async function copySource(from: string, to: string) {
  await copyFile(from, to); copiedPaths.add(path.relative(target, to).split(path.sep).join('/'));
}
async function copyDirectory(from: string, to: string) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (/(?:^tests?$|^fixtures?$|^build$|^__pycache__$|\.test\.|\.spec\.|\.pyc$|\.(?:so|dylib|a|o|exe)$)/.test(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error('Plugin source must not contain symlinks');
    if (entry.isDirectory()) await copyDirectory(path.join(from, entry.name), path.join(to, entry.name));
    else if (entry.isFile()) await copySource(path.join(from, entry.name), path.join(to, entry.name));
  }
}
await mkdir(target, { recursive: true });
// Fixed source allowlist excludes private configs, credentials and runtime fixtures.
for (const name of ['plugin.json', '.mcp.json', 'README.md', 'mcp/bridge.mjs']) {
  const destination = path.join(target, name); await mkdir(path.dirname(destination), { recursive: true }); await copySource(path.join(source, name), destination);
}
// Repository README links resolve differently in a self-contained unpacked ZIP.
const packageReadme = path.join(target, 'README.md');
await writeFile(packageReadme, (await readFile(packageReadme, 'utf8')).replaceAll('../../docs/', 'docs/'));
await copyDirectory(path.join(source, 'skills'), path.join(target, 'skills'));
await mkdir(path.join(target, 'tools'), { recursive: true });
for (const name of ['vision-workshop-device-runner.mjs', 'vision-uvc-camera.py', 'vision-uvc-http-adapter.py',
  'vision-x5-preflight.py', 'vision-x5-camera.py', 'vision-x5-frame.py', 'vision-x5-isp.py', 'vision-x5-calibration.py']) {
  await copySource(path.join(root, 'tools', name), path.join(target, 'tools', name));
}
const native = path.join(target, 'tools', 'vision-x5-native'); await mkdir(native, { recursive: true });
for (const name of ['x5_camera_backend.c', 'x5_camera_backend.h', 'x5_isp_modules.inc.c', 'x5_isp_replay.inc.c', 'Makefile', 'README.md', 'LICENSE']) {
  const from = path.join(root, 'tools', 'vision-x5-native', name);
  try { await copySource(from, path.join(native, name)); } catch (error) { if (name !== 'LICENSE' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
// Only these isolated SDK shim sources are included to make the documented Makefile test usable.
await mkdir(path.join(native, 'tests'), { recursive: true });
for (const local of nativeTestPaths) await copySource(path.join(root, local), path.join(target, local));
await mkdir(path.join(target, 'docs'), { recursive: true });
for (const name of ['vision-workshop-atomics.md', 'vision-workshop-capabilities.md', 'vision-workshop-x5-native.md']) await copySource(path.join(root, 'docs', name), path.join(target, 'docs', name));
await mkdir(path.join(target, 'knowledge'), { recursive: true });
await writeFile(path.join(target, 'knowledge', 'x5-yahboom-imx415.json'), JSON.stringify(VISION_X5_IMX415_KNOWLEDGE, null, 2) + '\n');
copiedPaths.add('knowledge/x5-yahboom-imx415.json');
await writeFile(path.join(target, 'knowledge', 'camera-field-experience.json'), JSON.stringify(VISION_CAMERA_FIELD_EXPERIENCE, null, 2) + '\n');
copiedPaths.add('knowledge/camera-field-experience.json');
const declaration = JSON.stringify(CAMERA_WORKSHOP_PLUGIN_TEMPLATE, null, 2) + '\n';
const declarationPath = path.join(output, 'camera-workshop.json');
await writeFile(declarationPath, declaration);
const entries: VisionArchiveEntry[] = [];
async function archiveDirectory(directory: string, prefix: string) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error('Package output must not contain symlinks');
    if (entry.isDirectory()) await archiveDirectory(path.join(directory, entry.name), prefix + entry.name + '/');
    else if (entry.isFile()) {
      const local = (prefix + entry.name).slice('rdk-camera-workshop/'.length);
      if (local === 'SOURCE-MANIFEST.json') continue;
      if (!copiedPaths.has(local)) throw new Error('Unexpected non-source package asset: ' + local);
      const data = await readFile(path.join(directory, entry.name));
      // No deployment credentials, extraction code or private board destinations.
      const text = data.toString('utf8');
      if (/\bpfvt\b|\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9_-]{24,})|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:192\.168|10\.\d+|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+|\/Users\/d-robotics\//.test(text)) throw new Error('Private data in camera package: ' + prefix + entry.name);
      if (!nativeTestPaths.has(local) && /\.test\.|\.spec\.|\/tests?\/|\/fixtures?\/|\.pyc$|\.(?:so|dylib|a|o|exe)$/.test(prefix + entry.name)) throw new Error('Non-source asset in camera package');
      entries.push({ name: prefix + entry.name, data });
    }
  }
}
await archiveDirectory(target, 'rdk-camera-workshop/');
const fileManifest = entries.map(entry => ({ path: entry.name, bytes: entry.data.length, sha256: createHash('sha256').update(entry.data).digest('hex') }));
const checksums = Buffer.from(JSON.stringify({ version, hardwareVerification: 'unverified', files: fileManifest }, null, 2) + '\n');
await writeFile(path.join(target, 'SOURCE-MANIFEST.json'), checksums);
entries.push({ name: 'rdk-camera-workshop/SOURCE-MANIFEST.json', data: checksums });
const zip = createVisionArchive(entries);
const archivePath = path.join(output, 'rdk-camera-workshop-' + version + '.zip'); await writeFile(archivePath, zip);
await writeFile(path.join(output, 'camera-workshop-package.json'), JSON.stringify({ version, knowledgeId: VISION_X5_IMX415_KNOWLEDGE.id, hardwareVerification: 'unverified', nativeStudioConnection: 'loopback-local-only', deployment: 'not_deployed', declaration: { filename: 'camera-workshop.json', sha256: createHash('sha256').update(declaration).digest('hex') }, archive: { filename: path.basename(archivePath), sha256: createHash('sha256').update(zip).digest('hex'), bytes: zip.length }, studioDirectory: path.basename(target), sourceFiles: fileManifest.length }, null, 2) + '\n');
console.log(JSON.stringify({ declarationPath, archivePath, studioDirectory: target, hardwareVerification: 'unverified' }));
