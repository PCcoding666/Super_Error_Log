/**
 * 上传材料按「自然日」筛选。库里的 material_asset.created_at 是 UTC
 * （SQLite CURRENT_TIMESTAMP 的 `YYYY-MM-DD HH:MM:SS`，或偶尔带 T/Z 的 ISO）。
 * 学生看到的一天按 Asia/Singapore（UTC+8，无夏令时）切，晚上拍的不会落到前一天。
 * 不新增列：只把日历日换成 UTC 区间再查已有时间戳。
 */

export const STUDENT_UPLOAD_ZONE = 'Asia/Singapore';
/** 和「我的材料」原图列表同一页大小。筛选关闭时录入态仍一次返回全部，不套用这个上限。 */
export const ASSET_PAGE_SIZE = 8;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export class DayFilterError extends Error {
  constructor() { super('日期要写成 2026-11-04 这样。'); this.name = 'DayFilterError'; }
}

/** 真实存在的公历日。`2026-02-31` 这种不算。 */
export function isCalendarDay(value: string): boolean {
  const match = DAY.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 新加坡日历日的起点（含）和次日起点（不含），UTC 的 `YYYY-MM-DD HH:MM:SS`，给 SQLite datetime() 用。 */
export function singaporeDayBounds(day: string): { start: string; end: string } {
  if (!isCalendarDay(day)) throw new DayFilterError();
  const [year, month, date] = day.split('-').map(Number);
  const startMs = Date.UTC(year!, month! - 1, date!) - 8 * 60 * 60 * 1000;
  return { start: sqliteUtc(startMs), end: sqliteUtc(startMs + 86_400_000) };
}

function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

export interface AssetDayFilter {
  /** `date=` 指定的那一天；起止日筛选时为 null。 */
  date: string | null;
  from: string | null;
  to: string | null;
  /** 含。null 表示不限起点。 */
  start: string | null;
  /** 不含。null 表示不限终点。 */
  end: string | null;
}

function one(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new DayFilterError();
  return value.trim();
}

/**
 * 可选查询参数。都没有则返回 null（列表与现在完全一致）。
 * `date` 是单日，优先于 `from` / `to`。`from`、`to` 都按新加坡自然日、含当天。
 */
export function parseAssetDayFilter(query: { date?: unknown; from?: unknown; to?: unknown }): AssetDayFilter | null {
  const date = one(query.date);
  const from = one(query.from);
  const to = one(query.to);
  if (date === undefined && from === undefined && to === undefined) return null;
  if (date !== undefined) {
    if (!date || !isCalendarDay(date)) throw new DayFilterError();
    const bounds = singaporeDayBounds(date);
    return { date, from: null, to: null, start: bounds.start, end: bounds.end };
  }
  if (from !== undefined && !isCalendarDay(from ?? '')) throw new DayFilterError();
  if (to !== undefined && !isCalendarDay(to ?? '')) throw new DayFilterError();
  const start = from ? singaporeDayBounds(from).start : null;
  const end = to ? singaporeDayBounds(to).end : null;
  if (start && end && start >= end) throw new DayFilterError();
  return { date: null, from: from || null, to: to || null, start, end };
}

/** 拼进已有 `WHERE owner_id=?` 后面。无筛选时是空串，不改变原来的 SQL。 */
export function createdAtRangeSql(filter: AssetDayFilter | null): { sql: string; params: string[] } {
  if (!filter) return { sql: '', params: [] };
  const expr = "datetime(replace(replace(created_at, 'T', ' '), 'Z', ''))";
  const parts: string[] = [];
  const params: string[] = [];
  if (filter.start) { parts.push(`${expr} >= datetime(?)`); params.push(filter.start); }
  if (filter.end) { parts.push(`${expr} < datetime(?)`); params.push(filter.end); }
  return parts.length ? { sql: ` AND ${parts.join(' AND ')}`, params } : { sql: '', params: [] };
}

/** 分页链接要带上正在用的筛选，否则翻页会回到全部。无筛选时是空串。 */
export function assetPageQuery(filter: AssetDayFilter | null): string {
  if (!filter) return '';
  const params = new URLSearchParams();
  if (filter.date) params.set('date', filter.date);
  else {
    if (filter.from) params.set('from', filter.from);
    if (filter.to) params.set('to', filter.to);
  }
  const text = params.toString();
  return text ? `&${text}` : '';
}

/** 把库里的 UTC 时间戳（空格或 ISO）解析成毫秒。解析不了返回 null。 */
export function utcMillis(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/i.test(trimmed) ? trimmed : `${trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

export function instantInRange(value: string, filter: AssetDayFilter): boolean {
  const ms = utcMillis(value);
  if (ms === null) return false;
  if (filter.start) {
    const start = utcMillis(filter.start);
    if (start !== null && ms < start) return false;
  }
  if (filter.end) {
    const end = utcMillis(filter.end);
    if (end !== null && ms >= end) return false;
  }
  return true;
}

export function singaporeToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: STUDENT_UPLOAD_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return isCalendarDay(parts) ? parts : now.toISOString().slice(0, 10);
}

/** 录入页的筛选状态。默认关，page 只在打开时发给服务器。 */
export interface UploadDayFilter {
  enabled: boolean;
  day: string;
  page: number;
}

export function initialUploadDayFilter(now: Date = new Date()): UploadDayFilter {
  return { enabled: false, day: singaporeToday(now), page: 0 };
}

/** 打开、关掉或换一天，都从第 0 页重新列，避免还停在上一组的页码上。 */
export function reduceUploadDayFilter(state: UploadDayFilter, action:
  | { type: 'toggle'; enabled: boolean }
  | { type: 'day'; day: string }
  | { type: 'page'; page: number },
): UploadDayFilter {
  if (action.type === 'toggle') return action.enabled === state.enabled ? state : { ...state, enabled: action.enabled, page: 0 };
  if (action.type === 'day') {
    if (!isCalendarDay(action.day) || action.day === state.day) return state;
    return { ...state, day: action.day, page: 0 };
  }
  const page = Number.isSafeInteger(action.page) && action.page >= 0 ? Math.min(action.page, 100000) : state.page;
  if (page === state.page) return state;
  return { ...state, page };
}

/** 筛选关闭时不带任何参数，请求和现在一样。 */
export function intakeListParams(state: UploadDayFilter): Record<string, string> {
  if (!state.enabled) return {};
  return { date: state.day, page: String(state.page) };
}

/** 服务端这份列表是不是当前筛选要的。还没返回时，关掉筛选沿用原来的空列表；打开筛选则先不要显示上一份。 */
export function intakeResponseMatches(state: UploadDayFilter, data: { filter?: { date?: string | null } | null; page?: number } | null): boolean {
  if (!data) return !state.enabled;
  if (!state.enabled) return data.filter == null;
  return data.filter?.date === state.day && data.page === state.page;
}

/**
 * 刚传完、服务器列表里还没有的照片要继续刷新。
 * 「全部」和「今天的第一页」一定会带上这张新照片。别的日期和后面的页不会出现它，不能因此一直刷新。
 */
export function intakeWaitsForUpload(state: UploadDayFilter, now: Date = new Date()): boolean {
  return !state.enabled || (state.page === 0 && state.day === singaporeToday(now));
}
