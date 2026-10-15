#!/usr/bin/env node
/** Consistent snapshots of data-center metadata and immutable blobs. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DataCenterService } from '../server/monitoring/data-center-service.js';
import { CollectionWorkspaceService, COLLECTION_WORKSPACE_CONTRACT } from '../server/monitoring/collection-workspace-service.js';

const managed = /^data-center-\d{8}T\d{9}Z-[0-9a-f-]{36}$/;
export async function backupDataCenter({ stateDir, backupDir, keep = 24, now = new Date() }) {
  if (!stateDir || !backupDir || !Number.isSafeInteger(keep) || keep < 1 || keep > 168 || !Number.isFinite(now.getTime())) throw new Error('invalid_backup_options');
  const source = resolve(stateDir); const destination = resolve(backupDir);
  if (destination === source || destination.startsWith(source + '/') || source.startsWith(destination + '/')) throw new Error('invalid_backup_directory');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const stat = await lstat(destination); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_backup_directory');
  await chmod(destination, 0o700);
  const name = 'data-center-' + now.toISOString().replace(/[-:.]/g, '') + '-' + randomUUID();
  const staging = join(destination, '.' + name + '.pending');
  const service = new DataCenterService({ dataDir: source });
  let collection;
  try {
    const collectionDir = join(source, 'collection-workspace');
    try {
      const configured = await lstat(collectionDir);
      if (!configured.isDirectory() || configured.isSymbolicLink()) throw new Error('unsafe_collection_state_directory');
      collection = new CollectionWorkspaceService({ stateDir: collectionDir, drivers: [], archive: async () => { throw new Error('backup_execution_forbidden'); }, pollIntervalMs: 0 });
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const perform = async () => {
      const result = await service.backupState(staging);
      if (collection) {
        // Fixed lock order: collection metadata first, then data assets. Do not
        // re-enter a collection service method while holding its lock.
        const descriptor = await open(join(collectionDir, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
        let content;
        try { const stat = await descriptor.stat(); if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('unsafe_collection_manifest'); content = await descriptor.readFile(); } finally { await descriptor.close(); }
        const output = join(staging, 'collection-workspace'); await mkdir(output, { mode: 0o700 });
        for (const [filename, data] of [['manifest.json', content], ['initialized', Buffer.from(COLLECTION_WORKSPACE_CONTRACT)]]) {
          const file = await open(join(output, filename), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
        }
        const directory = await open(output, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
      }
      return result;
    };
    const result = collection ? await collection.withExclusiveStorageLock(perform) : await perform();
    const manifest = await readFile(join(staging, 'manifest.json'));
    const sha256 = createHash('sha256').update(manifest).digest('hex');
    await rename(staging, join(destination, name));
    const directory = await open(destination, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
    const snapshots = [];
    for (const entry of await readdir(destination)) {
      if (!managed.test(entry)) continue;
      const item = await lstat(join(destination, entry));
      if (item.isDirectory() && !item.isSymbolicLink()) snapshots.push(entry);
    }
    snapshots.sort().reverse();
    for (const old of snapshots.slice(keep)) await rm(join(destination, old), { recursive: true });
    return { snapshot: name, assets: result.assets, manifestSha256: sha256, completedAt: result.completedAt };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  finally { await collection?.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 2) throw new Error('environment_configuration_required');
    const result = await backupDataCenter({ stateDir: process.env.RDK_DATA_CENTER_STATE_DIR,
      backupDir: process.env.RDK_DATA_CENTER_BACKUP_DIR || '/var/backups/d-obs-data-center',
      keep: process.env.RDK_DATA_CENTER_BACKUP_KEEP ? Number(process.env.RDK_DATA_CENTER_BACKUP_KEEP) : 24 });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch { process.stderr.write('data_center_backup_failed\n'); process.exitCode = 1; }
}
