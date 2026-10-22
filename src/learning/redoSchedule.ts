import { getDb } from '../db/connection.js';
import { addDayText, localDayText } from '../domain/calendarDay.js';
import { MIN_DELAY_DAYS } from '../domain/stateMachine.js';

export { addDayText, dayOrdinal, localDayText, monthDayText } from '../domain/calendarDay.js';

/**
 * 延迟重做的日历规则（P0-3）。
 *
 * 「隔几天」的锚点是这道题上一次作答的日子；从没作答过就是录入日。与练习包哪天生成无关，
 * 所以「接受建议当场做 → 隔 3 天再做」能走到掌握，同时当天做对仍然不算掌握。
 *
 * 日历日按服务器进程时区计算，与 attemptService 校验作答日期的口径一致（生产为 Asia/Shanghai）。
 */

/** 时间戳或日期文本 → 本地日历日；无法解析返回 null。 */
function dayOf(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? localDayText(date) : null;
}

/**
 * 这道题「上一次接触」的日子：最近一次作答的作答日；从没作答就是录入日。
 * excludePacketId：计算某包内本次作答时，排除这包自己的作答（每包每题只有一条，正常不会有）。
 */
export function delayAnchorDay(itemId: string, excludePacketId?: string): string | null {
  const db = getDb();
  const attempts = db.prepare(
    'SELECT performed_at, created_at FROM review_attempt WHERE item_id = ? AND packet_id <> ?',
  ).all(itemId, excludePacketId ?? '') as Array<{ performed_at: string | null; created_at: string }>;
  let latest: string | null = null;
  for (const attempt of attempts) {
    const day = dayOf(attempt.performed_at) ?? dayOf(attempt.created_at);
    if (day && (latest === null || day > latest)) latest = day;
  }
  if (latest) return latest;
  const item = db.prepare('SELECT created_at FROM error_item WHERE id = ?').get(itemId) as { created_at: string } | undefined;
  return dayOf(item?.created_at);
}

/** 当场做对（attempted）后，最早哪天再做对才算数：上次作答日 + 3 天。 */
export function cooldownUntil(itemId: string): string | null {
  const anchor = delayAnchorDay(itemId);
  return anchor ? addDayText(anchor, MIN_DELAY_DAYS) : null;
}

/**
 * 某题下次该做的日子：attempted → 上次作答 + 3 天；temporarily_mastered → 确认日（next_review_at）；
 * 其余状态没有日期约束（needs_recheck 随时可以重练），返回 null。
 */
export function nextRedoDay(item: { id: string; status: string; next_review_at?: string | null }): string | null {
  if (item.status === 'attempted') return cooldownUntil(item.id);
  if (item.status === 'temporarily_mastered') return dayOf(item.next_review_at ?? null);
  return null;
}

export function todayText(): string {
  return localDayText(new Date());
}
