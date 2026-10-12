/** Pure text redaction before model transmission; operator-visible results stay intact. */
export function redactPlatformAssistantText(value: string): string {
  return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b((?:set-cookie|cookie)\s*:\s*)[^\r\n]*/gi, '$1[REDACTED]')
    .replace(/((?:["']?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|authorization|cookie|dsn|(?:[A-Z_]{0,64}DB_URL))["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\\n])*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]');
}
