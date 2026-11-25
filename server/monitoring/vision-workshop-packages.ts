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
const classroomFileSchema = z.object({
  bytes: z.number().int().positive().max(32 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const classroomManifestSchema = z.object({
  schema: z.literal('rdk.vision-workshop-classroom.v1'),
  lesson: classroomFileSchema,
  plugin: classroomFileSchema,
}).strict();
const classroomPolicy = "sandbox allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox; "
  + "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; "
  + "media-src data: blob:; font-src data:; frame-src 'self' blob: data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none';";
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
  async function verifiedPackages() {
    const manifest = manifestSchema.parse(JSON.parse((await regularFile('manifest.json', 16 * 1024)).toString('utf8')));
    if (new Set(manifest.packages.map(p => p.kind)).size !== manifest.packages.length) throw new Error('package_unavailable');
    // 逐包校验：单个包文件缺失或哈希不符只降级剔除该条目，不拖垮整个清单。
    const results = await Promise.allSettled(manifest.packages.map(async item => {
      const bytes = await regularFile(filenames[item.kind], 32 * 1024 * 1024);
      if (bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('package_unavailable');
      return { item, bytes };
    }));
    return results.flatMap(entry => entry.status === 'fulfilled' ? [entry.value] : []);
  }
  const ownerGuard: RequestHandler = (req, res, next) => {
    if (req.opsTenantAccess || options.owner(req) === 'ops-admin') { res.status(403).json({ ok: false, error: 'vision_identity_required' }); return; }
    next();
  };
  for (const asset of ['lesson', 'plugin'] as const) {
    const suffix = asset === 'lesson' ? '/classroom' : '/classroom/plugin';
    const filename = asset === 'lesson' ? 'classroom.html' : 'classroom.zip';
    router.get(VISION_WORKSHOP_API + suffix, options.access, ownerGuard, async (_req, res) => {
      try {
        const manifest = classroomManifestSchema.parse(JSON.parse((await regularFile('classroom-manifest.json', 4096)).toString('utf8')));
        const entry = manifest[asset];
        const bytes = await regularFile(filename, entry.bytes);
        if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
          throw new Error('classroom_asset_unavailable');
        }
        res.set('Cache-Control', 'private, no-store');
        res.set('ETag', '"' + entry.sha256 + '"');
        res.set('X-Content-Type-Options', 'nosniff');
        if (asset === 'lesson') {
          res.set('Content-Security-Policy', classroomPolicy);
          res.set('Referrer-Policy', 'no-referrer');
          res.type('html').send(bytes);
        } else {
          res.attachment('RDK-Camera-AI-Workshop.zip').type('application/zip').send(bytes);
        }
      } catch { res.status(503).json({ ok: false, error: 'vision_classroom_asset_unavailable' }); }
    });
  }
  router.get(VISION_WORKSHOP_API + '/plugin-packages', options.access, ownerGuard, async (_req, res) => {
    try {
      const packages = (await verifiedPackages()).map(({ item }) => ({ ...item, downloadPath: VISION_WORKSHOP_API + '/plugin-packages/' + item.kind + '/download' }));
      if (!packages.length) { res.status(503).json({ ok: false, error: 'vision_plugin_package_unavailable' }); return; }
      res.json({ ok: true, schema: 'rdk.vision-plugin-packages.v1', packages });
    } catch { res.status(503).json({ ok: false, error: 'vision_plugin_package_unavailable' }); }
  });
  router.get(VISION_WORKSHOP_API + '/plugin-packages/:kind/download', options.access, ownerGuard, async (req, res) => {
    if (!Object.hasOwn(filenames, String(req.params.kind))) { res.status(404).json({ ok: false, error: 'vision_plugin_package_not_found' }); return; }
    try {
      const entry = (await verifiedPackages()).find(({ item }) => item.kind === req.params.kind);
      if (!entry) { res.status(404).json({ ok: false, error: 'vision_plugin_package_not_found' }); return; }
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('ETag', '"' + entry.item.sha256 + '"');
      res.attachment('rdk-camera-workshop-' + entry.item.kind + '-' + entry.item.version + '.zip').type('application/zip').send(entry.bytes);
    } catch { res.status(503).json({ ok: false, error: 'vision_plugin_package_unavailable' }); }
  });
}
