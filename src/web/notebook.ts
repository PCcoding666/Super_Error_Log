import { ALL_STAGES, compareStage, isStage } from '../classification/stages.js';
import type { V2WeekItem } from '../v2/weekService.js';

/**
 * 学生看到的四档状态，和结果页「真会了 / 再对就算稳了」同一套说法。
 * 状态机的细分（待检查、已生成练习纸、当天做对待延迟验证……）只在服务端判断时使用。
 */
export const NOTEBOOK_STATUS_GROUPS = { todo: '待练习', practicing: '练习中', mastered: '真会了', stable: '稳了' } as const;
export type NotebookStatusGroup = keyof typeof NOTEBOOK_STATUS_GROUPS;
const STATUS_GROUP: Record<string, NotebookStatusGroup> = {
  captured: 'todo', needs_review: 'todo', ready_for_reflection: 'todo', eligible_for_review: 'todo', needs_recheck: 'todo',
  // 当天做对不算掌握，还要隔几天再做一次。
  attempted: 'todo',
  scheduled: 'practicing', packet_generated: 'practicing',
  temporarily_mastered: 'mastered', stably_mastered: 'stable',
};
/** 题目状态归到哪一档；不在错题本里显示的状态（如已归档）没有档位。 */
export function notebookStatusGroup(status: string): NotebookStatusGroup | null {
  return Object.hasOwn(STATUS_GROUP, status) ? STATUS_GROUP[status]! : null;
}
/** 筛选参数只认四档；旧链接里的细分状态归到它所在的档，其余丢弃。 */
export function notebookStatusFilter(value: string): NotebookStatusGroup | '' {
  if (Object.hasOwn(NOTEBOOK_STATUS_GROUPS, value)) return value as NotebookStatusGroup;
  return notebookStatusGroup(value) ?? '';
}
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
    const kept = key === 'status' && value ? notebookStatusFilter(value) : value;
    if (kept) query.set(key, kept.slice(0, key === 'q' ? 200 : 100));
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
    && (!filters.status || notebookStatusGroup(item.status) === filters.status)
    && (!filters.q || [questionText, item.questionExcerpt, item.shortId, item.chapter, ...item.knowledgeTags]
      .filter(Boolean).join(' ').toLocaleLowerCase().includes(filters.q.toLocaleLowerCase()));
}
