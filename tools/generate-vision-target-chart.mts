import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVisionTargetChartPng, VISION_TARGET_PATCHES } from '../server/monitoring/vision-workshop-quality.js';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'assets', 'vision-target-chart-v1.png');
const png = buildVisionTargetChartPng();
writeFileSync(out, png, { mode: 0o644 });
console.log('written:', out);
console.log('bytes:', png.length, 'sha256:', createHash('sha256').update(png).digest('hex'));
console.log('patches:', VISION_TARGET_PATCHES.length, '(12 灰阶 + 12 彩色，参考值见 server/monitoring/vision-workshop-quality.ts)');
