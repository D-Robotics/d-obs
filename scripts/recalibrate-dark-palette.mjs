/**
 * 暗色段重校准：tokenize 脚本的 darkVariant 对「中饱和度」颜色走了亮度反演
 * 分支，导致文本灰发闷、teal→粉、purple→橄榄、投影变成白光晕。本脚本不改
 * light 段、不碰已 tokenize 的样式文件，只根据「token 在样式里的使用上下文」
 * 重算 dark 段：
 *   A. color: 文本上下文（不透明且 light 亮度低）：HSL 保色相提亮
 *   B. 薄荷绿家族 rgba(112,255,245,*) 等 → 校准 teal rgba(79,208,186,*)
 *   C. 仅用于 box-shadow 的白光晕 token → 黑色投影（alpha×4 钳 0.28..0.6）
 *   D. MANUAL 手工语义值（c327..c394 产品层语义 token）最后覆盖
 * 重新生成 dark 段后手工微调请改 MANUAL 或直接改文件（生成器不回写）。
 * 用法：node scripts/recalibrate-dark-palette.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const palettePath = path.join(root, 'server/monitoring/observability-page-palette.ts');
const styleDir = path.join(root, 'server/monitoring');
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
  'observability-page-action-loop-style.ts',
  'observability-page-product-style.ts',
  'observability-page-mobile-tour.ts',
  'observability-page-tenants.ts',
];

// ---------- 颜色工具（与 tokenize 脚本同源的 HSL 转换） ----------
function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
    a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
  };
}
function rgbToHex(r, g, b) {
  const c = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h, s, l };
}
function hslToRgb(h, s, l) {
  if (s === 0) return { r: l, g: l, b: l };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = h;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: f(hk + 1 / 3), g: f(hk), b: f(hk - 1 / 3) };
}
function parseColor(value) {
  const v = value.trim();
  if (v.startsWith('#')) return { ...hexToRgb(v), fmt: 'hex' };
  const m = v.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(',').map((p) => p.trim());
    const [r, g, b] = parts.slice(0, 3).map(Number);
    const a = parts.length > 3 ? Number(parts[3]) : 1;
    return { r: r / 255, g: g / 255, b: b / 255, a, fmt: 'rgba' };
  }
  return null;
}
function formatColor(c) {
  if (c.fmt === 'rgba' || c.a < 1) {
    const r = Math.round(c.r * 255), g = Math.round(c.g * 255), b = Math.round(c.b * 255);
    return `rgba(${r},${g},${b},${Number(c.a.toFixed(3))})`;
  }
  return rgbToHex(c.r, c.g, c.b);
}

// ---------- 读取 light/dark 两个调色板段 ----------
const src = fs.readFileSync(palettePath, 'utf8');
const lightBody = src.match(/OPS_OBSERVABILITY_PALETTE_LIGHT = `:root\{([\s\S]*?)\n\}`/)[1];
const darkConst = src.match(/(OPS_OBSERVABILITY_PALETTE_DARK = `html\[data-theme="dark"\]\{)([\s\S]*?)(\n\}`)/);

const lightTokens = new Map();
for (const m of lightBody.matchAll(/--c(\d+):\s*([^;]+);/g)) {
  lightTokens.set(Number(m[1]), m[2].trim());
}

// ---------- 收集 token 使用上下文 ----------
const textTokens = new Set();   // color:var(--cN)
const bgTokens = new Set();     // background...var(--cN)
const shadowTokens = new Set(); // box-shadow:...var(--cN)
const css = styleFiles.map((f) => fs.readFileSync(path.join(styleDir, f), 'utf8')).join('\n');
for (const m of css.matchAll(/([a-zA-Z-]+)\s*:[^;{}]*var\(--c(\d+)\)/g)) {
  const prop = m[1], id = Number(m[2]);
  if (prop === 'color' || prop === 'fill' || prop === 'stroke') textTokens.add(id);
  else if (prop.startsWith('background') || prop.startsWith('--') ) bgTokens.add(id);
  if (prop === 'box-shadow' || prop === 'text-shadow') shadowTokens.add(id);
}
// 产品层 --shadow:0 10px 30px var(--c392) 这类自定义属性也算投影上下文
for (const m of css.matchAll(/--shadow[a-z-]*\s*:[^;{}]*var\(--c(\d+)\)/g)) {
  shadowTokens.add(Number(m[1]));
}

// 规则 C：仅投影上下文、且当前 dark 值是白光晕的 token → 黑色投影
const WHITE_GLOW = /^rgba\(255,255,255,/;

// 规则 D：手工校准值（优先级最高）
const MANUAL = {
  327: '#16181b', 111: '#23262e', 379: '#33383d', 380: '#474c53',
  381: '#e6e9e7', 382: '#9aa5a1', 383: '#4fd0ba', 384: '#6fe0cd',
  385: 'rgba(79,208,186,0.13)', 389: '#a98fe0', 390: '#0f1114', 391: '#14171b',
  392: 'rgba(0,0,0,0.5)', 393: 'rgba(0,0,0,0.38)', 394: 'rgba(0,0,0,0.32)',
};

const TEAL = { r: 79 / 255, g: 208 / 255, b: 186 / 255 };
const changes = [];

// ---------- 逐 token 计算 dark 新值 ----------
const darkBody = darkConst[2];
const newLines = darkBody.split('\n').map((line) => {
  const m = line.match(/^(\s*--c(\d+):\s*)([^;]+)(;.*)$/);
  if (!m) return line;
  const id = Number(m[2]);
  const current = m[3].trim();

  if (id in MANUAL) {
    if (current !== MANUAL[id]) changes.push(`c${id}: ${current} → ${MANUAL[id]} (manual)`);
    return m[1] + MANUAL[id] + m[4];
  }

  // B：薄荷绿家族 → 校准 teal（保持 alpha）
  const mint = current.match(/^rgba\((112,255,245|117,250,229|121,246,225|112,255,207),([^)]*)\)$/);
  if (mint) {
    const next = formatColor({ ...TEAL, a: Number(mint[2]) });
    changes.push(`c${id}: ${current} → ${next} (mint→teal)`);
    return m[1] + next + m[4];
  }

  // C：仅投影上下文的白光晕 → 黑色投影
  if (shadowTokens.has(id) && !textTokens.has(id) && !bgTokens.has(id) && WHITE_GLOW.test(current)) {
    const a = Number(current.match(/rgba\(255,255,255,([\d.]+)\)/)[1]);
    const nextA = Math.min(0.6, Math.max(0.28, a * 4));
    const next = `rgba(0,0,0,${nextA})`;
    changes.push(`c${id}: ${current} → ${next} (white-glow shadow→black)`);
    return m[1] + next + m[4];
  }

  // A：文本上下文（不参与 background 的才算，避免把表面色提亮）
  const light = lightTokens.get(id);
  if (!light || !textTokens.has(id) || bgTokens.has(id)) return line;
  const c = parseColor(light);
  if (!c || c.a < 1) return line; // 半透明文本当前的白色化已经正确
  const { h, s, l } = rgbToHsl(c.r, c.g, c.b);
  if (l >= 0.55) return line; // light 主题下已是亮色文本，dark 反演已合理
  let next;
  if (s < 0.15) {
    // 中性文本：整体提亮到 0.62..0.9
    const l2 = 0.9 - l * 0.5;
    next = formatColor({ ...hslToRgb(h, s, l2), a: 1 });
  } else {
    // 彩色强调文本：保色相，提亮到 0.6..0.78
    const l2 = Math.min(0.78, Math.max(0.6, 0.6 + (0.55 - l) * 0.25));
    const s2 = Math.min(s, 0.5);
    next = formatColor({ ...hslToRgb(h, s2, l2), a: 1 });
  }
  if (next !== current) {
    changes.push(`c${id}: ${current} → ${next} (text L${l.toFixed(2)} S${s.toFixed(2)})`);
    return m[1] + next + m[4];
  }
  return line;
});

// ---------- 写回 ----------
const out = src.slice(0, darkConst.index) + darkConst[1] + newLines.join('\n') + darkConst[3] + src.slice(darkConst.index + darkConst[0].length);
fs.writeFileSync(palettePath, out);
console.log(`recalibrated ${changes.length} dark tokens:`);
for (const c of changes) console.log('  ' + c);
const overlap = [...textTokens].filter((id) => bgTokens.has(id));
if (overlap.length) console.log('text∩bg tokens (skipped rule A): ' + overlap.map((n) => 'c' + n).join(' '));
