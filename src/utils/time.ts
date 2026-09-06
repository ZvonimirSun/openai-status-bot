export function formatDateTime(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(date)
    .replaceAll("/", "-");
}

export function isWithinLookback(
  value: string,
  now: Date,
  days: number,
): boolean {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && timestamp >= now.getTime() - days * 86_400_000
  );
}
