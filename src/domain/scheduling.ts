export interface PlanCandidate {
  itemId: string;
  score: number;
  primaryTag: string | null;
  conflict: boolean;
  /** 可选：同分时的优先顺序（小的优先）；缺省退回 itemId 字典序（Web 原有行为不变）。 */
  order?: number;
}

export interface PlanResult {
  selected: string[];
  notes: string[];
}

export const PLAN_MIN = 5;
export const PLAN_MAX = 8;
export const SAME_TAG_CAP = 2;
/** 「今天该做」每天最多几道，到期多的顺延。 */
export const TODAY_LIMIT = 5;
/** 暂时掌握后隔几天再确认一次。 */
export const CONFIRMATION_DAYS = 10;

/**
 * 每周选 5–8 题：按评分降序，同知识点最多 2 道；候选不足 5 道则全部纳入并提示。
 * 冲突题（学生认为没必要但有复发证据）优先保留。
 */
export function selectWeeklyPlan(candidates: PlanCandidate[]): PlanResult {
  const notes: string[] = [];
  const sorted = [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.conflict !== b.conflict) return a.conflict ? -1 : 1;
    if (a.order !== undefined && b.order !== undefined && a.order !== b.order) return a.order - b.order;
    return a.itemId.localeCompare(b.itemId);
  });

  const selected: string[] = [];
  const tagCount = new Map<string, number>();
  const overflow: string[] = [];

  for (const c of sorted) {
    if (selected.length >= PLAN_MAX) break;
    const tag = c.primaryTag ?? '__none__';
    const n = tagCount.get(tag) ?? 0;
    if (n >= SAME_TAG_CAP) {
      overflow.push(c.itemId);
      continue;
    }
    tagCount.set(tag, n + 1);
    selected.push(c.itemId);
  }

  // 同知识点限制导致不足 5 道时，从溢出中补齐
  const beforeFill = selected.length;
  for (const id of overflow) {
    if (selected.length >= Math.min(PLAN_MIN, sorted.length)) break;
    selected.push(id);
  }
  if (selected.length > beforeFill) notes.push('候选知识点较集中，为满足最低题量，已放宽同知识点最多2题的建议。');

  if (candidates.length < PLAN_MIN) {
    notes.push(`本周可安排题目仅 ${candidates.length} 道，不足 ${PLAN_MIN} 道，已全部纳入`);
  }
  if (selected.length > candidates.length) {
    // 不会发生，防御
  }
  const conflicts = sorted.filter((c) => c.conflict && selected.includes(c.itemId)).length;
  if (conflicts > 0) {
    notes.push(`其中 ${conflicts} 道存在「学生认为没必要但有复发证据」的冲突，建议保留`);
  }

  return { selected, notes };
}

function toDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

/** 首次复习计划日期：确认日后第 4 天（落在 3–7 天延迟窗口内） */
export function plannedDateForPacket(confirmDate: Date): string {
  return toDay(addDays(confirmDate, 4));
}

/** 暂时掌握后的确认复习日期：+10 天（落在 7–14 天窗口内） */
export function confirmationDateFor(now: Date): string {
  return toDay(addDays(now, CONFIRMATION_DAYS));
}

export function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / 86400000);
}

export function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}
