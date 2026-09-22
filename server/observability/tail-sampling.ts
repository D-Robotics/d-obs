/**
 * 服务端尾部采样：按 trace 决定去留——error 与慢 trace 永远保留，
 * 其余按 RDK_OTLP_TAIL_SAMPLE_RATIO 比例采样。ratio=1（默认）= 全保留，
 * 即不启用采样时行为与历史完全一致。
 */

export type TailSampleConfig = { ratio: number; slowMs: number };

export type TraceCandidate = {
  spanCount: number;
  hasError: boolean;
  durationMs: number;
};

export function tailSampleConfigFromEnv(env: Record<string, string | undefined> = process.env): TailSampleConfig {
  const rawRatio = Number(env.RDK_OTLP_TAIL_SAMPLE_RATIO ?? '1');
  const ratio = Number.isFinite(rawRatio) ? Math.max(0, Math.min(1, rawRatio)) : 1;
  const rawSlow = Number(env.RDK_OTLP_TAIL_SAMPLE_SLOW_MS ?? '2000');
  const slowMs = Number.isFinite(rawSlow) && rawSlow >= 0 ? rawSlow : 2000;
  return { ratio, slowMs };
}

export function shouldKeepTrace(
  candidate: TraceCandidate,
  config: TailSampleConfig,
  random: () => number = Math.random,
): boolean {
  if (config.ratio >= 1) return true;
  if (candidate.hasError) return true;
  if (config.slowMs > 0 && candidate.durationMs >= config.slowMs) return true;
  return random() < config.ratio;
}
