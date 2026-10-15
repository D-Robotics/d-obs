import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createVisionArchive, type VisionArchiveEntry } from '../server/monitoring/vision-workshop-export.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'plugins/rdk-camera-workshop/distribution');
const name = 'rdk-camera-workshop';
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function readDistributionFiles(directory: string, prefix = ''): Promise<VisionArchiveEntry[]> {
  const result: VisionArchiveEntry[] = [];
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.isSymbolicLink()) throw new Error('Public package cannot contain symlinks');
    if (item.isDirectory()) result.push(...await readDistributionFiles(path.join(directory, item.name), prefix + item.name + '/'));
    else if (item.isFile()) result.push({ name: prefix + item.name, data: await readFile(path.join(directory, item.name)) });
  }
  return result;
}
export async function verifyBasePackage(base: string, host: string) {
  const receipt = JSON.parse(await readFile(path.join(base, 'host-packages.json'), 'utf8'));
  const artifact = receipt.artifacts.find((entry: { host: string; kind: string }) => entry.host === host && entry.kind === 'plugin');
  if (!artifact || path.basename(artifact.filename) !== artifact.filename || !artifact.filename.endsWith('-plugin.zip')) throw new Error('Missing base host archive');
  const archive = path.join(base, artifact.filename);
  if (sha(await readFile(archive)) !== artifact.sha256) throw new Error('Base archive checksum mismatch');
  const directory = path.join(base, artifact.filename.replace(/-plugin\.zip$/, ''), 'plugins', name);
  const inventoryBytes = await readFile(path.join(directory, 'SOURCE-MANIFEST.json'));
  const archived = spawnSync('unzip', ['-p', archive, 'SOURCE-MANIFEST.json'], { maxBuffer: 2 * 1024 * 1024 });
  if (archived.status !== 0 || !inventoryBytes.equals(archived.stdout)) throw new Error('Base inventory differs from verified archive');
  const inventory = JSON.parse(inventoryBytes.toString('utf8'));
  const actual = (await readDistributionFiles(directory)).filter(entry => entry.name !== 'SOURCE-MANIFEST.json');
  if (actual.length !== inventory.files.length) throw new Error('Unexpected base package files');
  for (const entry of actual) {
    const expected = inventory.files.find((file: { path: string }) => file.path === entry.name);
    if (!expected || expected.sha256 !== sha(entry.data) || expected.bytes !== entry.data.length) throw new Error('Base payload checksum mismatch');
  }
  return { directory, version: receipt.version as string };
}
type Localized = { zh: string; en: string };
export interface PublicListing {
  version: string; author: { name: string; email: string }; displayName: Localized; profession: Localized;
  description: string; displayDescription: Localized; categoryId: string; keywords: string[];
  tags: Localized[]; quickPrompts: Localized[];
}
export function validatePublicListing(value: PublicListing) {
  if (!/^\d+\.\d+\.\d+$/.test(value.version) || !value.author?.name?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.author?.email ?? '')) throw new Error('Public publisher name, email and release version are required');
  for (const item of [value.displayName, value.profession, value.displayDescription, ...value.tags, ...value.quickPrompts]) {
    if (!item?.zh?.trim() || !item?.en?.trim()) throw new Error('Public listing needs Chinese and English metadata');
  }
  if (value.tags.length !== 3 || value.quickPrompts.length !== 3 || value.categoryId !== '02-Engineering') throw new Error('Invalid public expert category, tags or prompts');
  const length = [...value.displayDescription.zh].length;
  if (length < 40 || length > 50) throw new Error('Chinese expert summary must be 40–50 characters');
}
export async function buildPublicSubmissions(output: string, base: string, listing?: PublicListing) {
  listing ??= JSON.parse(await readFile(path.join(source, 'public-listing.json'), 'utf8')) as PublicListing;
  validatePublicListing(listing);
  await mkdir(output, { recursive: true });
  const artifacts = [];
  {
    // Build from a previously verified immutable delivery, independent of concurrent source edits.
    for (const host of ['qoder', 'workbuddy']) {
      const verified = await verifyBasePackage(base, host);
      const plugin = path.join(output, name + '-' + host + '-' + listing.version);
      await mkdir(plugin);
      await cp(verified.directory, plugin, { recursive: true });
      const metadataDir = host === 'qoder' ? '.qoder-plugin' : '.codebuddy-plugin';
      const filename = path.join(plugin, metadataDir, 'plugin.json');
      const original = JSON.parse(await readFile(filename, 'utf8'));
      const manifest = { ...original, version: listing.version, author: listing.author, description: listing.description, keywords: listing.keywords,
        ...(host === 'qoder' ? { displayName: listing.displayName.zh } : {
          skills: ['./skills/rdk-camera-workshop'], agents: ['./agents/rdk-camera-engineer.md'],
          expertType: 'agent', agentName: 'rdk-camera-engineer', displayName: listing.displayName,
          profession: listing.profession, displayDescription: listing.displayDescription,
          avatar: 'avatars/camera.png', categoryId: listing.categoryId, defaultInitPrompt: listing.quickPrompts[0],
          plugin: name, tags: listing.tags, quickPrompts: listing.quickPrompts,
        }),
      };
      await writeFile(filename, json(manifest));
      await mkdir(path.join(plugin, 'avatars')); await cp(path.join(source, 'avatars/camera.png'), path.join(plugin, 'avatars/camera.png'));
      if (host === 'workbuddy') {
        await mkdir(path.join(plugin, 'agents')); await cp(path.join(source, 'expert.md'), path.join(plugin, 'agents/rdk-camera-engineer.md'));
      }
      const skillPath = path.join(plugin, 'skills/rdk-camera-workshop/SKILL.md');
      await writeFile(skillPath, (await readFile(skillPath, 'utf8')).replace('version: "' + verified.version + '"', 'version: "' + listing.version + '"'));
      await writeFile(path.join(plugin, 'DISTRIBUTION.json'), json({ host, version: listing.version, publisher: listing.author.name,
        publication: 'not_submitted', hardware: 'unverified', requires: ['Node.js >=22', 'user-managed d-obs camera service', 'private service credentials'],
        listingKeywords: listing.keywords, submissionPortal: host === 'qoder' ? 'https://qoder.com/account/apphub-publications' : 'https://open.workbuddy.cn/',
      }));
      await cp(path.join(source, 'PUBLIC-RELEASE.md'), path.join(plugin, 'PUBLIC-RELEASE.md'));
      const entries = (await readDistributionFiles(plugin)).filter(entry => entry.name !== 'SOURCE-MANIFEST.json');
      await writeFile(path.join(plugin, 'SOURCE-MANIFEST.json'), json({ version: listing.version, files: entries.map(entry => ({ path: entry.name, bytes: entry.data.length, sha256: sha(entry.data) })) }));
      const data = createVisionArchive(await readDistributionFiles(plugin));
      const archiveName = name + '-' + host + '-' + listing.version + '-submission.zip';
      await writeFile(path.join(output, archiveName), data, { flag: 'wx' });
      artifacts.push({ host, filename: archiveName, bytes: data.length, sha256: sha(data), validation: 'local_structure_only', publication: 'not_submitted' });
    }
    await writeFile(path.join(output, 'public-submissions.json'), json({ publisher: listing.author, version: listing.version, artifacts }), { flag: 'wx' });
    return artifacts;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: package-camera-workshop-public.mts OUTPUT VERIFIED_HOST_PACKAGES');
  console.log(json(await buildPublicSubmissions(path.resolve(process.argv[2]), path.resolve(process.argv[3]))));
}
