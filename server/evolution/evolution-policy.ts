import path from 'node:path';
import { sanitizeOpsSummary } from '../monitoring/ops-event-store.js';

export const EVOLUTION_WORKER_VERSION = '1.0.0';
export const EVOLUTION_CADENCE = '每天 03:30（Asia/Shanghai）';
export const EVOLUTION_MODE = 'candidate_only';
export const MIN_EVOLUTION_EVIDENCE = 3;
export const MAX_CHANGED_FILES = 20;
export const MAX_DIFF_LINES = 2_500;

export interface EvolutionSignal {
  failureTag: string;
  evidenceCount: number;
  sourceCount: number;
  priority: number;
  latestAt: string | null;
}

const PROTECTED_PATH_PREFIXES = [
  '.github/',
  '.codex/',
  '.agents/',
  'ops/',
  'supabase/migrations/',
  'server/evolution/',
  'server/agent-runtime/',
  'server/plugins/',
  'server/monitoring/observability-',
  'server/routes/auth',
  'server/sso',
  'server/credits',
  'server/credit',
  'scripts/evolution/',
  'scripts/check-',
  'scripts/verify-all.mjs',
  'config/rdk-studio-provider.defaults.json',
  'config/agent-provider.defaults.json',
];

const PROTECTED_EXACT_PATHS = new Set([
  'agents.md',
  'claude.md',
  'architecture.md',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.server.json',
  'tsconfig.cli.json',
  'vite.config.ts',
  'yarn.lock',
]);

const EVOLUTION_SOURCE_TOP_LEVEL = new Set([
  '.gitattributes',
  '.gitignore',
  '.gitmodules',
  '.prettierignore',
  '.prettierrc',
  'AGENTS.md',
  'ARCHITECTURE.md',
  'CLAUDE.md',
  'LICENSE',
  'README.md',
  'UI_SYSTEM.md',
  'build-resources',
  'config',
  'dev-app-update.yml',
  'docs',
  'e2e',
  'electron',
  'eslint.config.js',
  'examples',
  'external',
  'index.html',
  'marketing',
  'miniapp',
  'miniapp-preview',
  'package-lock.json',
  'package.json',
  'packages',
  'playwright',
  'playwright.config.ts',
  'pnpm-workspace.yaml',
  'public',
  'schema',
  'scripts',
  'server',
  'shared',
  'skills',
  'src',
  'supabase',
  'tools',
  'tsconfig.cli.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.server.json',
  'vite.config.ts',
]);

const EVOLUTION_SNAPSHOT_SAFE_DOTFILES = new Set([
  '.gitattributes',
  '.gitignore',
  '.gitmodules',
  '.prettierignore',
  '.prettierrc',
]);

const EVOLUTION_SNAPSHOT_EXCLUDED_SEGMENTS = new Set([
  '.git',
  '.smoke',
  'backups',
  'coverage',
  'dist',
  'dist-cli',
  'dist-server',
  'logs',
  'node_modules',
  'playwright-report',
  'release',
  'storage',
  'test-results',
  'tmp',
  'uploads',
]);

export function normalizeEvolutionPath(value: string): string {
  return path.posix.normalize(String(value ?? '').replaceAll('\\', '/')).replace(/^\.\/+/, '');
}

export function evolutionSnapshotPathAllowed(value: string): boolean {
  const normalized = normalizeEvolutionPath(value);
  if (
    !normalized ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    return false;
  }
  const segments = normalized.split('/');
  if (!EVOLUTION_SOURCE_TOP_LEVEL.has(segments[0])) return false;
  return !segments.some(
    (segment) =>
      EVOLUTION_SNAPSHOT_EXCLUDED_SEGMENTS.has(segment) ||
      (segment.startsWith('.') && !EVOLUTION_SNAPSHOT_SAFE_DOTFILES.has(segment)) ||
      segment.startsWith('dist.') ||
      segment.startsWith('dist-') ||
      segment.endsWith('.bak'),
  );
}

export function protectedEvolutionPath(value: string): boolean {
  const normalized = normalizeEvolutionPath(value);
  if (
    !normalized ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    return true;
  }
  const comparisonPath = normalized.toLowerCase();
  if (PROTECTED_EXACT_PATHS.has(comparisonPath)) return true;
  return PROTECTED_PATH_PREFIXES.some((prefix) => comparisonPath.startsWith(prefix));
}

export function evaluateEvolutionDiff(input: {
  changedFiles: string[];
  diffText: string;
  /** true=验证跑过且通过；false=验证跑过但失败；null=验证未执行（如保护路径提前拦截）。 */
  verificationPassed: boolean | null;
}): {
  passed: boolean;
  protectedFiles: string[];
  changedFileCount: number;
  diffLines: number;
  reasons: string[];
} {
  const changedFiles = [...new Set(input.changedFiles.map(normalizeEvolutionPath).filter(Boolean))];
  const protectedFiles = changedFiles.filter(protectedEvolutionPath);
  const diffLines = input.diffText ? input.diffText.split('\n').length : 0;
  const reasons: string[] = [];
  if (!changedFiles.length) reasons.push('Agent 未产生代码改动');
  if (protectedFiles.length)
    reasons.push(`触碰受保护路径：${protectedFiles.slice(0, 5).join('、')}`);
  if (changedFiles.length > MAX_CHANGED_FILES) {
    reasons.push(`改动文件数 ${changedFiles.length} 超过上限 ${MAX_CHANGED_FILES}`);
  }
  if (diffLines > MAX_DIFF_LINES) reasons.push(`补丁行数 ${diffLines} 超过上限 ${MAX_DIFF_LINES}`);
  if (input.verificationPassed === false) {
    reasons.push('确定性构建或回归测试未通过');
  }
  return {
    passed: reasons.length === 0,
    protectedFiles,
    changedFileCount: changedFiles.length,
    diffLines,
    reasons,
  };
}

export function selectEvolutionSignal(
  signals: EvolutionSignal[],
  recentlyAttemptedTags: Set<string>,
): EvolutionSignal | null {
  return (
    signals
      .filter(
        (signal) =>
          signal.evidenceCount >= MIN_EVOLUTION_EVIDENCE &&
          signal.sourceCount >= 2 &&
          !recentlyAttemptedTags.has(signal.failureTag),
      )
      .sort(
        (left, right) =>
          right.priority - left.priority ||
          signalSpecificity(right.failureTag) - signalSpecificity(left.failureTag) ||
          right.evidenceCount - left.evidenceCount ||
          left.failureTag.localeCompare(right.failureTag),
      )[0] ?? null
  );
}

function signalSpecificity(failureTag: string): number {
  if (failureTag === 'regression-holdout-candidate') return 30;
  if (failureTag === 'tool-failure-recovery') return 20;
  if (failureTag === 'unsafe-action') return 10;
  return 0;
}

export function buildEvolutionTask(signal: EvolutionSignal): string {
  const failureTag = sanitizeOpsSummary(signal.failureTag, 80) || 'unknown-quality-signal';
  return [
    '你正在 d-obs 的一次隔离式每日自我进化任务中。',
    '',
    '只实现一个小而可验证的代码质量改进；直接检查当前仓库并完成代码与测试。',
    `匿名质量信号：${failureTag}`,
    `最近 7 天证据数：${signal.evidenceCount}`,
    `独立信号来源数：${signal.sourceCount}`,
    `信号优先级：${signal.priority}`,
    '',
    '硬性边界：',
    '- 不读取或输出任何密钥、环境变量、用户身份、提示词、会话正文或生产数据。',
    '- 不修改 AGENTS.md、CLAUDE.md、依赖锁文件、CI、部署、数据库迁移、认证、积分、',
    '  可观测控制面、self-evolution worker 或已有质量闸门。',
    '- 不禁用、删除、放宽测试或安全检查；不执行部署、推送、外部发送或设备操作。',
    '- 最多修改 20 个文件，优先补充能复现该失败模式的窄回归测试。',
    '- 在前 8 次工具调用内完成定位；若有安全修复，应在第 20 次调用前开始编辑，',
    '  不要把全部工具预算用在重复阅读或只写实施建议上。',
    '- 如果证据不足以支持安全改动，保持工作树不变，并在最终答复说明原因。',
    '',
    '完成后简要说明：根因、改动、验证命令和仍需人工判断的风险。',
  ].join('\n');
}
