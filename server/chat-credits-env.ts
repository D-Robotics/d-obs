export function envFlagEnabled(name: string, defaultValue: boolean): boolean {
  const raw = String(process.env[name] ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return defaultValue;
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true;
  return defaultValue;
}

export function readPositiveIntEnv(name: string, fallback: number, max = 1000): number {
  const raw = String(process.env[name] ?? '').trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(1, parsed));
}
