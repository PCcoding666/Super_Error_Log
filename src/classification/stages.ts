/** School stage only. Year grades such as 初一/高三 are not modeled. */
export const STAGES = ['初中', '高中'] as const;
export type Stage = typeof STAGES[number];
export const ALL_STAGES = '全部';
export const STAGE_REQUIRED_MESSAGE = '请选择初中或高中。';

export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

export function compareStage(a: string, b: string): number {
  const order = STAGES as readonly string[];
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  if (ia === -1 && ib === -1) return a.localeCompare(b, 'zh-CN');
  if (ia === -1) return 1;
  if (ib === -1) return -1;
  return ia - ib;
}

/** Settings and per-item edits offer 初中/高中, plus a stored value that is not in that list. */
export function stageChoices(current?: string | null): string[] {
  const choices = [...STAGES] as string[];
  const extra = current?.trim();
  if (extra && !choices.includes(extra)) choices.push(extra);
  return choices;
}
