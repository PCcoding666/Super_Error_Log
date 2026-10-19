import { isGrade } from '../classification/itemCategories.js';
import { MIN_DELAY_DAYS } from '../domain/stateMachine.js';

/** History describes this attempt, never infers mastery from the item's current status. */
export interface ItemPracticeRecord {
  id: string;
  correct: number | null;
  performed_at: string | null;
  completion?: string | null;
  hint_level?: number | null;
  generated_day?: string | null;
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
  const days = record.generated_day && record.performed_at
    ? (Date.parse(record.performed_at) - Date.parse(record.generated_day)) / 86400000 : NaN;
  if (!Number.isInteger(days) || days < 0) return '独立做对（缺少延迟日期记录）';
  if (days < MIN_DELAY_DAYS) return `${days === 0 ? '当天' : `隔 ${days} 天`}独立做对 · 未计入延迟掌握`;
  return `隔 ${days} 天独立做对`;
}

/** Standalone detail also works before the notebook filtering PR is integrated. */
export function itemNotebookReturn(value: unknown, item: {id:string;grade?:string;subject:string|null}): string {
  const fallbackQuery = new URLSearchParams();
  if (isGrade(item.grade)) fallbackQuery.set('grade',item.grade);
  if (item.subject) fallbackQuery.set('subject',item.subject);
  const fallback = `/s/items${fallbackQuery.size ? `?${fallbackQuery}` : ''}#item-${item.id}`;
  if (typeof value !== 'string' || !/^\/s\/items(?:\?[^#]*)?(?:#item-itm_[0-9a-f]{16})?$/.test(value) || /[\\\r\n\t]/.test(value)) return fallback;
  const url = new URL(value,'https://notebook.invalid');
  if ([...url.searchParams.keys()].some(key => !['grade','subject','chapter','status','q'].includes(key))) return fallback;
  const query = new URLSearchParams();
  for (const key of ['grade','subject','chapter','status','q']) {
    const part = url.searchParams.get(key)?.trim();
    if (part && (key !== 'grade' || isGrade(part))) query.set(key,part.slice(0,key === 'q' ? 200 : 100));
  }
  return `/s/items${query.size ? `?${query}` : ''}${url.hash || `#item-${item.id}`}`;
}
