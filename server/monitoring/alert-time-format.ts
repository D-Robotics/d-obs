const ALERT_TIME_ZONE = 'Asia/Shanghai';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatBeijingTimestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: ALERT_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const pick = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((part) => part.type === type)?.value ?? '';
    return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')} 北京时间`;
  } catch {
    const date = new Date(ms + 8 * 60 * 60_000);
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())} 北京时间`;
  }
}
