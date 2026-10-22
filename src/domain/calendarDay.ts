// 纯日历日（YYYY-MM-DD）运算与中文日期文案；不读数据库，视图与领域层都可以用。

/** 本地日历日 YYYY-MM-DD（进程时区）。 */
export function localDayText(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** YYYY-MM-DD → 日序号（自 1970-01-01）；格式不对返回 null。 */
export function dayOrdinal(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const value = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(value) ? Math.round(value / 86_400_000) : null;
}

/** 日历日加减天数（纯日历运算，不受时区影响）。 */
export function addDayText(text: string, days: number): string {
  const ordinal = dayOrdinal(text);
  if (ordinal === null) return text;
  const date = new Date((ordinal + days) * 86_400_000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** 「10 月 25 日」。 */
export function monthDayText(text: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})/.exec(text);
  return match ? `${Number(match[1])} 月 ${Number(match[2])} 日` : text;
}

