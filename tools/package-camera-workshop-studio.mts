import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VISION_X5_IMX415_KNOWLEDGE } from '../server/monitoring/vision-workshop-x5-imx415-knowledge.js';
import { createVisionArchive, visionCrc32, type VisionArchiveEntry } from '../server/monitoring/vision-workshop-export.js';

const prefix = 'rdk-camera-workshop/';
const knowledgeFile = 'knowledge/x5-yahboom-imx415.json';
const skillFile = 'skills/rdk-camera-workshop/SKILL.md';
const baseFiles = ['plugin.json', '.mcp.json', 'README.md', 'mcp/server.mjs'];
const excluded = /(?:^tests?$|^fixtures?$|^build$|^__pycache__$|\.test\.|\.spec\.|\.pyc$|\.(?:so|dylib|a|o|exe|bin|zip)$)/;
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function scan(data: Buffer, name: string) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  if (/\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9_-]{24,})|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:192\.168|10\.\d+|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+|\/(?:Users|home)\/[^\s/]+\/|\/var\/folders\/|(?:\/(?:tmp|private\/tmp)\/[^\s"'`]+)|\btyped_isp_(?:bridge|preload)\b/.test(text)) throw new Error('Private or diagnostic-only data in Studio package: ' + name);
}

function checkLinks(files: Map<string, Buffer>) {
  for (const [name, data] of files) {
    if (!name.endsWith('.md')) continue;
    for (const match of data.toString('utf8').matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const link = match[1].replace(/^<|>$/g, '');
      if (/^(?:https?:|mailto:)/i.test(link) || link.startsWith('#')) continue;
      if (/^[a-z]+:/i.test(link) || link.startsWith('/')) throw new Error('Non-portable Studio package link: ' + name);
      const local = path.posix.normalize(path.posix.join(path.posix.dirname(name), decodeURIComponent(link.split(/[?#]/)[0])));
      if (local.startsWith('../') || !files.has(local)) throw new Error('Missing Studio package reference: ' + name + ' -> ' + link);
    }
  }
}

/** Verify both ZIP directories against the frozen bytes, including every CRC. */
export function verifyStudioArchive(zip: Buffer, entries: VisionArchiveEntry[]) {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 8), entries.length);
  assert.equal(zip.readUInt16LE(end + 10), entries.length);
  assert.equal(zip.readUInt16LE(end + 20), 0);
  let local = 0; let central = zip.readUInt32LE(end + 16);
  const centralStart = central;
  for (const entry of entries) {
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    assert.equal(zip.readUInt16LE(local + 8), 0);
    const length = zip.readUInt16LE(local + 26); const extra = zip.readUInt16LE(local + 28);
    assert.equal(zip.subarray(local + 30, local + 30 + length).toString('utf8'), entry.name);
    assert.equal(zip.readUInt32LE(local + 18), entry.data.length);
    assert.equal(zip.readUInt32LE(local + 22), entry.data.length);
    assert.equal(zip.readUInt32LE(local + 14), visionCrc32(entry.data));
    assert.deepEqual(zip.subarray(local + 30 + length + extra, local + 30 + length + extra + entry.data.length), entry.data);
    assert.equal(zip.readUInt32LE(central), 0x02014b50);
    assert.equal(zip.readUInt16LE(central + 10), 0);
    assert.equal(zip.readUInt32LE(central + 16), visionCrc32(entry.data));
    assert.equal(zip.readUInt32LE(central + 20), entry.data.length);
    assert.equal(zip.readUInt32LE(central + 24), entry.data.length);
    assert.equal(zip.readUInt32LE(central + 42), local);
    const nameLength = zip.readUInt16LE(central + 28);
    assert.equal(zip.subarray(central + 46, central + 46 + nameLength).toString('utf8'), entry.name);
    central += 46 + nameLength + zip.readUInt16LE(central + 30) + zip.readUInt16LE(central + 32);
    local += 30 + length + extra + entry.data.length;
  }
  assert.equal(local, centralStart);
  assert.equal(central, end);
  assert.equal(zip.readUInt32LE(end + 12), end - centralStart);
}

export async function packageStudioCameraWorkshop(studioSource: string, output: string) {
  const source = path.join(path.resolve(studioSource), 'plugins', 'rdk-camera-workshop');
  if (!(await lstat(source)).isDirectory()) throw new Error('Studio plugin source directory required');
  const files = new Map<string, Buffer>();
  async function add(name: string) {
    let location = source;
    for (const component of name.split('/')) {
      location = path.join(location, component);
      if ((await lstat(location)).isSymbolicLink()) throw new Error('Studio source symlink denied: ' + name);
    }
    const info = await lstat(location);
    if (!info.isFile() || info.size > 4 * 1024 * 1024 || files.size >= 128) throw new Error('Studio source limit: ' + name);
    const data = await readFile(location); scan(data, name); files.set(name, data);
  }
  async function walk(relative: string) {
    for (const item of (await readdir(path.join(source, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded.test(item.name)) continue;
      const name = relative + '/' + item.name;
      if (item.isSymbolicLink()) throw new Error('Studio source symlink denied: ' + name);
      if (item.isDirectory()) await walk(name);
      else if (item.isFile() && /\.(?:md|json)$/.test(item.name)) await add(name);
      else throw new Error('Unexpected Studio skill asset: ' + name);
    }
  }
  for (const name of baseFiles) await add(name);
  await walk('skills'); await add(knowledgeFile);
  const manifest = JSON.parse(files.get('plugin.json')!.toString('utf8'));
  const version = manifest.version;
  if (manifest.name !== 'rdk-camera-workshop' || !/^\d+\.\d+\.\d+$/.test(version) || manifest.skills !== './skills/' || manifest.mcpServers !== './.mcp.json') throw new Error('Studio plugin manifest mismatch');
  if (!new RegExp('^version: ' + version.replaceAll('.', '\\.') + '$', 'm').test(files.get(skillFile)?.toString('utf8') ?? '')) throw new Error('Studio skill version mismatch');
  assert.deepEqual(JSON.parse(files.get('.mcp.json')!.toString('utf8')), { mcpServers: { 'rdk-camera-workshop': { transport: 'stdio', command: 'node', args: ['mcp/server.mjs'] } } }, 'Preserve the native Studio companion declaration');
  assert.deepEqual(JSON.parse(files.get(knowledgeFile)!.toString('utf8')), JSON.parse(JSON.stringify(VISION_X5_IMX415_KNOWLEDGE)), 'Studio knowledge must match the complete reviewed platform knowledge');
  checkLinks(files);
  const entries = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, data]) => ({ name: prefix + name, data }));
  const sourceManifest = { version, knowledgeId: VISION_X5_IMX415_KNOWLEDGE.id, knowledgeVersion: VISION_X5_IMX415_KNOWLEDGE.version,
    hardwareVerification: 'unverified', deployment: 'not_deployed',
    files: entries.map(entry => ({ path: entry.name, bytes: entry.data.length, sha256: sha(entry.data) })) };
  const checksums = Buffer.from(JSON.stringify(sourceManifest, null, 2) + '\n');
  entries.push({ name: prefix + 'SOURCE-MANIFEST.json', data: checksums });
  const zip = createVisionArchive(entries); verifyStudioArchive(zip, entries);
  output = path.resolve(output); await mkdir(output, { recursive: true });
  const target = path.join(output, 'rdk-camera-workshop-studio-' + version);
  try { await lstat(target); throw new Error('Studio candidate directory already exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const staging = await mkdtemp(path.join(output, '.camera-studio-'));
  try {
    for (const entry of entries) {
      const destination = path.join(staging, entry.name.slice(prefix.length));
      await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, entry.data);
      assert.equal(sha(await readFile(destination)), sha(entry.data));
    }
    await rename(staging, target);
  } finally { await rm(staging, { recursive: true, force: true }); }
  const archivePath = path.join(output, path.basename(target) + '.zip');
  await writeFile(archivePath, zip, { flag: 'wx' });
  const report = { version, knowledgeVersion: VISION_X5_IMX415_KNOWLEDGE.version, hardwareVerification: 'unverified', deployment: 'not_deployed',
    nativeCompanion: 'studio_origin_proxy_unchanged', sourceFiles: sourceManifest.files.length,
    archive: { filename: path.basename(archivePath), bytes: zip.length, sha256: sha(zip), crcVerification: 'passed' },
    sourceManifestSha256: sha(checksums), localReferences: 'passed', privateDataScan: 'passed' };
  await writeFile(path.join(output, 'camera-workshop-studio-package.json'), JSON.stringify(report, null, 2) + '\n');
  return { archivePath, studioDirectory: target, ...report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--studio-source' || args[2] !== '--output') throw new Error('Usage: node --import tsx tools/package-camera-workshop-studio.mts --studio-source <Studio repository> --output <candidate directory>');
  console.log(JSON.stringify(await packageStudioCameraWorkshop(args[1], args[3])));
}
