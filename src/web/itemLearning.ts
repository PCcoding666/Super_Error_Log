import { notebookUrl, safeNotebookReturn } from './notebook.js';
import { MIN_DELAY_DAYS } from '../domain/stateMachine.js';

/** History describes this attempt, never infers mastery from the item's current status. */
export interface ItemPracticeRecord {
  id: string;
  correct: number | null;
  performed_at: string | null;
  completion?: string | null;
  hint_level?: number | null;
  generated_day?: string | null;
  /** 延迟锚点：这次之前最近一次作答日，没有则为录入日；缺省时退回练习纸生成日（旧数据）。 */
  anchor_day?: string | null;
  created_at?: string;
}

export function attemptLabel(record: ItemPracticeRecord): string {
  if (record.correct === null) return '尚未作答';
  if (record.completion === 'unfinished') return '未完成';
  if (record.completion === 'failed') return '没做出来';
  if (record.completion === 'unsure') return '做出但不确定';
  if (record.completion === 'hint_used' || (record.hint_level ?? 0) > 0) {
    const level = record.hint_level === 2 ? '二级' : record.hint_level === 1 ? '一级' : '';
    return `用了${level}提示后${record.correct ? '做对' : '做错'}`;
  }
  if (record.completion !== 'independent') return record.correct ? '做对了（未记录完成方式）' : '做错了（未记录完成方式）';
  if (!record.correct) return '独立作答做错';
  const anchor = record.anchor_day ?? record.generated_day;
  const days = anchor && record.performed_at
    ? (Date.parse(record.performed_at) - Date.parse(anchor)) / 86400000 : NaN;
  if (!Number.isInteger(days) || days < 0) return '独立做对（缺少延迟日期记录）';
  if (days < MIN_DELAY_DAYS) return `${days === 0 ? '当天' : `隔 ${days} 天`}独立做对 · 未计入延迟掌握`;
  return `隔 ${days} 天独立做对`;
}

/**
 * 题目历史（新的在前）每条的延迟锚点：比它更早的最近一次作答日，没有就是录入日。
 * 作答日用 dayOf（纸上作答日；旧记录没有作答日时用记录时间），与掌握判定 delayAnchorDay 同一回退。
 */
export function withHistoryAnchors<T extends { performed_at: string | null; attempt_created_at?: string | null }>(
  newestFirst: T[], intakeDay: string | null, dayOf: (attempt: { performed_at: string | null; created_at: string | null }) => string | null,
): Array<T & { anchor_day: string | null }> {
  return newestFirst.map((record, index) => ({
    ...record,
    anchor_day: newestFirst.slice(index + 1)
      .map(older => (older.attempt_created_at || older.performed_at ? dayOf({ performed_at: older.performed_at, created_at: older.attempt_created_at ?? null }) : null))
      .find(day => day !== null) ?? intakeDay,
  }));
}

/** Detail shares notebook normalization, retaining the current item's fallback position. */
export function itemNotebookReturn(value: unknown, item: {id:string;grade?:string;subject:string|null}): string {
  const fallback = notebookUrl({grade:item.grade,subject:item.subject ?? undefined},item.id);
  const destination = safeNotebookReturn(value,fallback);
  return destination.includes('#') ? destination : `${destination}#item-${item.id}`;
}

/** Local management destinations carry only a normalized notebook return context. */
export function itemContextUrl(item: {id:string;grade?:string;subject:string|null}, value: unknown, suffix: ''|'/category'|'/fix'|'/edit' = ''): string {
  return `/s/items/${item.id}${suffix}?${new URLSearchParams({returnTo:itemNotebookReturn(value,item)})}`;
}

/** Flash metadata carries an anchor ID, never an arbitrary redirect URL. */
export function removedNotebookUrl(value: string, itemId: string): string {
  const destination = new URL(safeNotebookReturn(value,`/s/items#item-${itemId}`),'https://notebook.invalid');
  destination.searchParams.set('removed',itemId);
  destination.searchParams.set('returnItem',destination.hash.slice('#item-'.length));
  return destination.pathname+destination.search+destination.hash;
}
