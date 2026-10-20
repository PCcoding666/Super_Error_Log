import { ALL_STAGES, compareStage, isStage } from '../classification/stages.js';
import type { V2WeekItem } from '../v2/weekService.js';

export const NOTEBOOK_STATUSES: Record<string, string> = {
  captured: '已采集', needs_review: '待检查',
  ready_for_reflection: '待练习', eligible_for_review: '可复习', needs_recheck: '下次再练',
  scheduled: '已加入练习', packet_generated: '已生成练习纸', attempted: '已记录作答',
  temporarily_mastered: '已延迟做对', stably_mastered: '已多次延迟做对',
};
export interface NotebookFilters { grade: string; subject: string; chapter: string; status: string; q: string }
export const MAX_NOTEBOOK_RETURN_LENGTH = 6000;
export function validNotebookSelection(ids: string[]): boolean {
  return ids.every(id=>/^itm_[0-9a-f]{16}$/.test(id)) && new Set(ids).size === ids.length;
}
/** Distinct stored stages for one subject. Empty and whitespace-only values are omitted. */
export function stagesInScope(items: Array<{ grade?: string | null; subject?: string | null }>, subject: string): string[] {
  const found = new Set<string>();
  for (const item of items) {
    if ((item.subject || '未分类') !== subject) continue;
    const stage = item.grade?.trim();
    if (stage) found.add(stage);
  }
  return [...found].sort(compareStage);
}

/** No stored stage → 全部. One stage → that stage. Two or more → 全部 plus those stages. */
export function stageFilterChoices(present: string[]): string[] {
  const unique = [...new Set(present.map(stage => stage.trim()).filter(Boolean))].sort(compareStage);
  if (unique.length === 0) return [ALL_STAGES];
  if (unique.length === 1) return unique;
  return [ALL_STAGES, ...unique];
}

/**
 * The notebook request's stage is the selection return URLs must keep, even after the
 * last question in that stage is removed. A cookie or profile stage applies only when
 * questions of that stage are still stored for the subject.
 */
export function resolveNotebookStage(
  requested: string,
  remembered: Array<string | null | undefined>,
  present: string[],
): { grade: string; stages: string[] } {
  const explicit = requested.trim();
  const honored = explicit === ALL_STAGES || isStage(explicit) ? explicit : '';
  const stored = [...new Set(present.map(stage => stage.trim()).filter(Boolean))];
  const source = honored && isStage(honored) && !stored.includes(honored) ? [...stored, honored] : stored;
  let stages = stageFilterChoices(source);
  if (honored === ALL_STAGES && !stages.includes(ALL_STAGES)) stages = [ALL_STAGES, ...stages];
  const grade = honored || remembered.find(value => !!value && stages.includes(value)) || stages[0] || ALL_STAGES;
  return { grade, stages };
}

export function notebookUrl(filters: Partial<NotebookFilters>, itemId?: string, selectedIds?: string[]): string {
  const query = new URLSearchParams();
  if (filters.grade === ALL_STAGES || isStage(filters.grade)) query.set('grade', filters.grade);
  for (const key of ['subject', 'chapter', 'status', 'q'] as const) {
    const value = filters[key]?.trim();
    if (value && (key !== 'status' || Object.hasOwn(NOTEBOOK_STATUSES,value))) query.set(key, value.slice(0, key === 'q' ? 200 : 100));
  }
  if (selectedIds) { query.set('mode','select'); selectedIds.forEach(id=>query.append('itemIds',id)); }
  return `/s/items${query.size ? `?${query}` : ''}${itemId && /^itm_[0-9a-f]{16}$/.test(itemId) ? `#item-${itemId}` : ''}`;
}
/** Accept only the literal notebook path, never normalized arbitrary paths or origins. */
export function safeNotebookReturn(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length > MAX_NOTEBOOK_RETURN_LENGTH || !/^\/s\/items(?:\?[^#]*)?(?:#item-itm_[0-9a-f]{16})?$/.test(value) || /[\\\r\n\t]/.test(value)) return fallback;
  const url = new URL(value, 'https://notebook.invalid');
  if ([...url.searchParams.keys()].some(key=>!['grade','subject','chapter','status','q','mode','itemIds'].includes(key))) return fallback;
  if ([...url.searchParams.keys()].some(key=>key !== 'itemIds' && url.searchParams.getAll(key).length !== 1)) return fallback;
  const selecting = url.searchParams.get('mode') === 'select';
  if ((url.searchParams.has('mode') && !selecting) || (url.searchParams.has('itemIds') && !selecting)) return fallback;
  const selectedIds = url.searchParams.getAll('itemIds');
  if (!validNotebookSelection(selectedIds)) return fallback;
  const filters: Partial<NotebookFilters> = {};
  for (const key of ['grade', 'subject', 'chapter', 'status', 'q'] as const) {
    const part = url.searchParams.get(key);
    if (part) filters[key] = part;
  }
  return notebookUrl(filters, url.hash ? url.hash.slice('#item-'.length) : undefined, selecting ? selectedIds : undefined);
}
export function matchesNotebook(item: Omit<V2WeekItem, 'jobId'>, filters: NotebookFilters, questionText = ''): boolean {
  return (filters.grade === ALL_STAGES || item.grade === filters.grade) && (item.subject || '未分类') === filters.subject
    && (!filters.chapter || (item.chapter || '未分类') === filters.chapter)
    && (!filters.status || item.status === filters.status)
    && (!filters.q || [questionText, item.questionExcerpt, item.shortId, item.chapter, ...item.knowledgeTags]
      .filter(Boolean).join(' ').toLocaleLowerCase().includes(filters.q.toLocaleLowerCase()));
}
