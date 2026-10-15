import type { Request, RequestHandler, Router } from 'express';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { VISION_WORKSHOP_API } from './vision-workshop-operations.js';

const filenames = { platform: 'platform.zip', studio: 'studio.zip' } as const;
const packageSchema = z.object({
  kind: z.enum(['platform', 'studio']), name: z.string().min(1).max(120),
  version: z.string().regex(/^\d+\.\d+\.\d+$/), bytes: z.number().int().positive().max(32 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), requirements: z.array(z.string().min(1).max(300)).max(10),
}).strict();
const manifestSchema = z.object({ schema: z.literal('rdk.vision-plugin-packages.v1'), packages: z.array(packageSchema).min(1).max(2) }).strict();
type Options = { access: RequestHandler; owner: (req: Request) => string; packageDir?: string };

/** Published bytes only: no URL, path, credential or executable supplied by a caller. */
export function registerVisionPluginPackageRoutes(router: Router, options: Options): void {
  const packageDir = options.packageDir ?? fileURLToPath(new URL('../../plugins/vision-workshop-packages/', import.meta.url));
  async function regularFile(name: string, limit: number): Promise<Buffer> {
    const root = await realpath(packageDir); const file = join(root, name);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit || await realpath(file) !== file) throw new Error('package_unavailable');
    const bytes = await readFile(file);
    if (bytes.length !== stat.size || bytes.length > limit) throw new Error('package_unavailable');
    return bytes;
  }
  async function published() {
    const manifest = manifestSchema.parse(JSON.parse((await regularFile('manifest.json', 16 * 1024)).toString('utf8')));
    if (new Set(manifest.packages.map(p => p.kind)).size !== manifest.packages.length) throw new Error('package_unavailable');
    return Promise.all(manifest.packages.map(async item => {
      const bytes = await regularFile(filenames[item.kind], 32 * 1024 * 1024);
      if (bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('package_unavailable');
      return { item, bytes };
    }));
  }
  const ownerGuard: RequestHandler = (req, res, next) => {
    if (req.opsTenantAccess || options.owner(req) === 'ops-admin') { res.status(403).json({ ok: false, error: 'vision_identity_required' }); return; }
    next();
  };
  router.get(VISION_WORKSHOP_API + '/plugin-packages', options.access, ownerGuard, async (_req, res) => {
    try {
      const packages = (await published()).map(({ item }) => ({ ...item, downloadPath: VISION_WORKSHOP_API + '/plugin-packages/' + item.kind + '/download' }));
      res.json({ ok: true, schema: 'rdk.vision-plugin-packages.v1', packages });
    } catch { res.status(503).json({ ok: false, error: 'vision_plugin_package_unavailable' }); }
  });
  router.get(VISION_WORKSHOP_API + '/plugin-packages/:kind/download', options.access, ownerGuard, async (req, res) => {
    if (!Object.hasOwn(filenames, String(req.params.kind))) { res.status(404).json({ ok: false, error: 'vision_plugin_package_not_found' }); return; }
    try {
      const entry = (await published()).find(({ item }) => item.kind === req.params.kind);
      if (!entry) { res.status(404).json({ ok: false, error: 'vision_plugin_package_not_found' }); return; }
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('ETag', '"' + entry.item.sha256 + '"');
      res.attachment('rdk-camera-workshop-' + entry.item.kind + '-' + entry.item.version + '.zip').type('application/zip').send(entry.bytes);
    } catch { res.status(503).json({ ok: false, error: 'vision_plugin_package_unavailable' }); }
  });
}
