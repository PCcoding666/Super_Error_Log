import { isGrade } from '../classification/itemCategories.js';
import type { V2WeekItem } from '../v2/weekService.js';

export const NOTEBOOK_STATUSES: Record<string, string> = {
  captured: '已采集', needs_review: '待检查',
  ready_for_reflection: '待练习', eligible_for_review: '可复习', needs_recheck: '下次再练',
  scheduled: '已加入练习', packet_generated: '已生成练习纸', attempted: '已记录作答',
  temporarily_mastered: '已延迟做对', stably_mastered: '已多次延迟做对',
};
export interface NotebookFilters { grade: string; subject: string; chapter: string; status: string; q: string }
export function notebookUrl(filters: Partial<NotebookFilters>, itemId?: string): string {
  const query = new URLSearchParams();
  if (isGrade(filters.grade)) query.set('grade', filters.grade);
  for (const key of ['subject', 'chapter', 'status', 'q'] as const) {
    const value = filters[key]?.trim();
    if (value && (key !== 'status' || Object.hasOwn(NOTEBOOK_STATUSES,value))) query.set(key, value.slice(0, key === 'q' ? 200 : 100));
  }
  return `/s/items${query.size ? `?${query}` : ''}${itemId && /^itm_[0-9a-f]{16}$/.test(itemId) ? `#item-${itemId}` : ''}`;
}
/** Accept only the literal notebook path, never normalized arbitrary paths or origins. */
export function safeNotebookReturn(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !/^\/s\/items(?:\?[^#]*)?(?:#item-itm_[0-9a-f]{16})?$/.test(value) || /[\\\r\n\t]/.test(value)) return fallback;
  const url = new URL(value, 'https://notebook.invalid');
  if ([...url.searchParams.keys()].some(key=>!['grade','subject','chapter','status','q'].includes(key))) return fallback;
  const filters: Partial<NotebookFilters> = {};
  for (const key of ['grade', 'subject', 'chapter', 'status', 'q'] as const) {
    const part = url.searchParams.get(key);
    if (part) filters[key] = part;
  }
  return notebookUrl(filters, url.hash ? url.hash.slice('#item-'.length) : undefined);
}
export function matchesNotebook(item: V2WeekItem, filters: NotebookFilters, questionText = ''): boolean {
  return item.grade === filters.grade && (item.subject || '未分类') === filters.subject
    && (!filters.chapter || (item.chapter || '未分类') === filters.chapter)
    && (!filters.status || item.status === filters.status)
    && (!filters.q || [questionText, item.questionExcerpt, item.shortId, item.chapter, ...item.knowledgeTags]
      .filter(Boolean).join(' ').toLocaleLowerCase().includes(filters.q.toLocaleLowerCase()));
}
