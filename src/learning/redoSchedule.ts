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

/** 一次作答的作答日：纸上作答日；旧记录没有作答日时用记录时间（与掌握判定同一口径）。 */
export function attemptDay(attempt: { performed_at: string | null; created_at: string | null }): string | null {
  return dayOf(attempt.performed_at) ?? dayOf(attempt.created_at);
}

/** 录入日。 */
export function intakeDay(itemId: string): string | null {
  const item = getDb().prepare('SELECT created_at FROM error_item WHERE id = ?').get(itemId) as { created_at: string } | undefined;
  return dayOf(item?.created_at);
}

/**
 * 这道题「上一次接触」的日子：最近一次作答的作答日；从没作答就是录入日。
 * excludePacketId：计算某包内本次作答时，排除这包自己的作答（每包每题只有一条，正常不会有）。
 */
export function delayAnchorDay(itemId: string, excludePacketId?: string): string | null {
  const attempts = getDb().prepare(
    'SELECT performed_at, created_at FROM review_attempt WHERE item_id = ? AND packet_id <> ?',
  ).all(itemId, excludePacketId ?? '') as Array<{ performed_at: string | null; created_at: string }>;
  let latest: string | null = null;
  for (const attempt of attempts) {
    const day = attemptDay(attempt);
    if (day && (latest === null || day > latest)) latest = day;
  }
  return latest ?? intakeDay(itemId);
}

/** 最早哪天再做对才算数：上次作答日（没作答过是录入日）+ 3 天。 */
export function cooldownUntil(itemId: string): string | null {
  const anchor = delayAnchorDay(itemId);
  return anchor ? addDayText(anchor, MIN_DELAY_DAYS) : null;
}

/** 按「上次接触 + 3 天」排期的状态：新错题、上次没独立做对、当场做对。 */
const DELAYED_STATUSES = new Set(['ready_for_reflection', 'eligible_for_review', 'needs_recheck', 'attempted']);

/**
 * 某题下次该做的日子（「今天该做」队列的到期日）：
 * - temporarily_mastered → 确认日（next_review_at）；
 * - 新错题、上次没独立做对、当场做对 → 上次作答日（没作答过是录入日）+ 3 天；
 * - 其余状态（稳定掌握、练习中、归档）没有日期，返回 null。
 * 到期那天独立做对就算数：没到日期做对只记 attempted，还要再排一次。
 */
export function nextRedoDay(item: { id: string; status: string; next_review_at?: string | null }): string | null {
  if (item.status === 'temporarily_mastered') return dayOf(item.next_review_at ?? null);
  if (DELAYED_STATUSES.has(item.status)) return cooldownUntil(item.id);
  return null;
}

export function todayText(): string {
  return localDayText(new Date());
}
