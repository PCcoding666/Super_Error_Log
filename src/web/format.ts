/**
 * 学生看得到的日期写法（只是显示，服务器的 ISO 周、日期字段都不变）。
 * ISO 周号（如 2026-W41）学生看不懂，换成这一周的起止日期：周一到周日。
 */

/** ISO 周（YYYY-Www）的周一（UTC 日期）；认不出时返回 null。 */
export function isoWeekMonday(key: string): Date | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) return null;
  // 1 月 4 日一定在第 1 周；它所在那周的周一就是第 1 周的周一。
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const weekday = jan4.getUTCDay() || 7;
  return new Date(Date.UTC(year, 0, 4 - (weekday - 1) + (week - 1) * 7));
}

/**
 * 「10/5–10/11」（short，列表里用）或「10 月 5 日 – 10 月 11 日」（long，练习纸封面用）。
 * 认不出的周号原样返回（不吞掉信息）。
 */
export function weekRangeText(key: string, style: 'short' | 'long' = 'short'): string {
  const monday = isoWeekMonday(key);
  if (!monday) return key;
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  const part = (date: Date): [number, number] => [date.getUTCMonth() + 1, date.getUTCDate()];
  const [m1, d1] = part(monday);
  const [m2, d2] = part(sunday);
  return style === 'long' ? `${m1} 月 ${d1} 日 – ${m2} 月 ${d2} 日` : `${m1}/${d1}–${m2}/${d2}`;
}
