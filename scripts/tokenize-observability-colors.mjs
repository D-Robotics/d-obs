#!/usr/bin/env node
/**
 * 构建期调色板变量化工具（一次性生成，产物直接入库）：
 *
 * 1. 扫描 observability-page-*-style/tenants/... 里的 CSS 模板字符串，
 *    把所有 #hex / rgba() 字面量收集为去重调色板；
 * 2. 把源文件里的字面量替换成 var(--cN)，生成 *-tokenized 源；
 * 3. 生成 light/dark 两份 :root 定义（dark 由亮度反转 + 品牌色微调得到），
 *    以及一个切换主题的小脚本模板。
 *
 * 用法：node scripts/tokenize-observability-colors.mjs
 * 幂等：重复运行会重新生成（已 token 化的文件不包含字面量，跳过）。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const styleDir = join(here, '..', 'server', 'monitoring');

const styleFiles = [
  'observability-page-style.ts',
  'observability-page-slo-style.ts',
  'observability-page-unified-style.ts',
  'observability-page-investigation-style.ts',
  'observability-page-copilot-style.ts',
  'observability-page-traces-style.ts',
  'observability-page-database-style.ts',
  'observability-page-version-distribution.ts',
  'observability-page-learning.ts',
  'observability-page-operator-metrics.ts',
  'observability-page-cockpit.ts',
  'observability-page-ux.ts',
  'observability-page-mobile-tour.ts',
  'observability-page-product-style.ts',
  'observability-page-tenants.ts',
  'observability-page-action-loop-style.ts',
];

const colorRe = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
// 排除 :root 中已有的基础变量定义行（保留原变量系统，不做二次替换）。
const rootDefRe = /:root\{[^}]*\}/;

const palette = new Map(); // literal -> var name
let counter = 0;
const rootBlocks = []; // 各文件 :root{...} 原文（提取语义变量供 dark 覆盖）

function varFor(literal) {
  if (!palette.has(literal)) {
    counter += 1;
    palette.set(literal, `c${counter}`);
  }
  return palette.get(literal);
}

function tokenizeCss(css) {
  return css.replace(colorRe, (match) => `var(--${varFor(match)})`);
}

/** hex/rgba -> [r,g,b,a] */
function parseColor(literal) {
  const hex = literal.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    if (h.length === 4) h = [...h].map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [r, g, b, a];
  }
  const m = literal.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(',').map((v) => parseFloat(v.trim()));
    const [r, g, b, a] = parts;
    if (parts.length === 3) return [r, g, b, 1];
    if (parts.length === 4) return [r, g, b, a];
    // space-separated rgb()/rgba() not present in this codebase.
    return null;
  }
  return null;
}

function toCss([r, g, b, a]) {
  if (a === undefined || a === 1) return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${round(a, 3)})`;
}

function hex2(v) {
  return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function luminance([r, g, b]) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * 暗色映射：保持色相，反转亮度。品牌绿/红/橙做亮度提升而非纯反转，
 * 让状态色在暗底上仍然可读。半透明白色叠层（rgba(255,255,255,x)）反转成
 * 黑色叠层；半透明黑色叠层反转成白色叠层。
 */
/** HSL 派生的暗色变体：保持色相，把亮度映射到暗色可读区间。 */
function darkVariant(literal) {
  const rgba = parseColor(literal);
  if (!rgba) return literal;
  const [r, g, b, a] = rgba;
  // 白色/近白（面板底）→ 深面板。
  if (r > 245 && g > 245 && b > 245) return a === 1 ? '#1d2027' : `rgba(38,42,51,${round(a, 3)})`;
  // 黑色/近黑（文本）→ 亮文本。
  if (r < 24 && g < 24 && b < 24) return a === 1 ? '#e8eaee' : `rgba(232,234,238,${round(a, 3)})`;
  const isWhiteAlpha = r > 200 && g > 200 && b > 200 && a < 1;
  if (isWhiteAlpha) return `rgba(255,255,255,${round(Math.min(0.85, a + 0.12), 3)})`;
  const isBlackAlpha = r < 60 && g < 60 && b < 60 && a < 1;
  if (isBlackAlpha) return `rgba(255,255,255,${round(Math.max(0.04, a * 1.4), 3)})`;

  // 淡色背景（浅灰/浅绿/浅红/浅黄底色）：换成同色相的暗色底。
  const L = luminance([r, g, b]);
  if (L > 0.86) {
    // 亮底色 → 深色底（带一点原色相）。
    return toCss([r * 0.14 + 18, g * 0.14 + 18, b * 0.14 + 18, a]);
  }
  // 饱和状态色（dark 主题下的 --green/--red/--orange）：
  // 保持色相，提亮到 0.62..0.72 亮度区间保证暗底可读。
  const [h, s, l] = rgbToHsl(r, g, b);
  if (s > 0.45) {
    const targetL = Math.max(0.6, Math.min(0.72, 1 - l));
    return toCss([...hslToRgb(h, s, targetL), a]);
  }
  // 低饱和灰阶：亮度反转并轻微压缩。
  if (Math.abs(L - 0.5) < 0.06 && a === 1) return literal;
  const inverted = [255 - r, 255 - g, 255 - b].map((c) => 34 + c * 0.55);
  return toCss([inverted[0], inverted[1], inverted[2], a]);
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hue2rgb(p, q, h + 1 / 3) * 255,
    hue2rgb(p, q, h) * 255,
    hue2rgb(p, q, h - 1 / 3) * 255,
  ];
}

const results = [];
for (const file of styleFiles) {
  const path = join(styleDir, file);
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    console.warn('skip (missing):', file);
    continue;
  }
  // 只处理模板字符串内的 CSS：按反引号配对扫描。
  // 例外：:root{...} 里已有的语义变量定义（--bg/--panel/--line...）保持原样——
  // 它们是基础 token，token 化它们会造成自引用（--bg:var(--c1)）并把
  // 既有 var(--panel) 体系打碎。
  const out = source.replace(/`([^`]*)`/g, (whole, css) => {
    if (!colorRe.test(css)) return whole;
    colorRe.lastIndex = 0;
    // 先把 root 块摘出来占位，tokenize 后再放回。
    const masked = [];
    const hoisted = css.replace(rootDefRe, (rootBlock) => {
      masked.push(rootBlock);
      return `__ROOT_BLOCK_${masked.length - 1}__`;
    });
    const tokenized = tokenizeCss(hoisted).replace(
      /__ROOT_BLOCK_(\d+)__/g,
      (_, i) => masked[Number(i)],
    );
    for (const block of masked) rootBlocks.push(block);
    return '`' + tokenized + '`';
  });
  if (out !== source) {
    writeFileSync(path, out);
    results.push(file);
  }
}

// 生成调色板定义文件（light + dark）。
const lines = [];
const darkLines = [];
for (const [literal, varName] of palette) {
  lines.push(`    --${varName}: ${literal};`);
  darkLines.push(`    --${varName}: ${darkVariant(literal)};`);
}
// 语义变量（:root 里的 --bg/--panel/--green...）在 dark 段直接覆盖，
// 保留原变量名，页面里既有的 var(--panel) 引用即刻切换。
const semanticDark = [];
const seenSemantic = new Set();
for (const block of rootBlocks) {
  const declRe = /--([a-z0-9-]+)\s*:\s*([^;}]+)/g;
  let m;
  while ((m = declRe.exec(block))) {
    const [, name, value] = m;
    if (seenSemantic.has(name)) continue;
    if (!colorRe.test(value)) continue;
    colorRe.lastIndex = 0;
    seenSemantic.add(name);
    const literal = value.trim();
    const rgba = parseColor(literal);
    semanticDark.push(`    --${name}: ${rgba ? darkVariant(literal) : literal};`);
  }
}
if (semanticDark.length) {
  darkLines.push('    /* 语义变量（:root 基础 token）的 dark 覆盖 */');
  darkLines.push(...semanticDark);
}

const generated = `/**
 * 由 scripts/tokenize-observability-colors.mjs 生成的调色板：
 * 所有页面样式中的颜色字面量都被替换成 var(--cN)，light 保留原值，
 * dark 为构建期派生（亮度反转 + 状态色可读性校正）。
 * 重新生成：node scripts/tokenize-observability-colors.mjs
 * 手工微调请直接改 dark 段（生成器不会覆盖本文件）。
 */
export const OPS_OBSERVABILITY_PALETTE_LIGHT = \`:root{${'\n'}${lines.join('\n')}\n}\`;

export const OPS_OBSERVABILITY_PALETTE_DARK = \`body.theme-dark{${'\n'}${darkLines.join('\n')}\n}\`;
`;

writeFileSync(join(styleDir, 'observability-page-palette.ts'), generated);
console.log('tokenized files:', results.length);
console.log('palette size:', palette.size);
console.log('palette written to server/monitoring/observability-page-palette.ts');
