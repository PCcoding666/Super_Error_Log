import type { Completion, ItemStatus, MasteryFeeling, ReviewValue } from './types.js';

export const MIN_DELAY_DAYS = 3;

/** 可记录作答的状态；其余状态（如 stably_mastered、archived）直接拒绝 */
export const ATTEMPTABLE_STATUSES: readonly ItemStatus[] = [
  'scheduled',
  'packet_generated',
  'attempted',
  'needs_recheck',
  'temporarily_mastered',
];

export interface AttemptOutcome {
  completion: Completion;
  correct: boolean;
  /**
   * 距这道题上一次作答日（从未作答则为录入日）的天数。
   * 用于判定是否为延迟作答，而非当场重做；与练习包哪天生成无关。
   */
  delayDays: number;
  /** 是否为本题在 temporarily_mastered 后的确认作答 */
  isConfirmation: boolean;
}

export interface Transition {
  to: ItemStatus;
  reason: string;
}

/**
 * 回传作答后的状态流转。核心规则：
 * - 当场/看过答案后做对不算掌握（delayDays < MIN_DELAY_DAYS 不构成掌握证据）。
 * - 距上次接触 ≥3 天独立做对 → temporarily_mastered；确认轮独立做对 → stably_mastered。
 * - 确认轮先判轮次再判天数：确认轮间隔不足时保持 temporarily_mastered，不降级。
 * - 使用提示 / 不确定 / 做错 / 未完成 → needs_recheck，优先进入下次计划。
 */
export function statusAfterAttempt(current: ItemStatus, outcome: AttemptOutcome): Transition {
  if (!ATTEMPTABLE_STATUSES.includes(current)) {
    return { to: current, reason: `状态 ${current} 不可记录作答` };
  }

  const { completion, correct, delayDays, isConfirmation } = outcome;

  if (completion === 'unfinished') {
    return { to: 'needs_recheck', reason: '未完成，需再次安排' };
  }
  if (completion === 'failed') {
    return { to: 'needs_recheck', reason: '仍完全不会，优先安排重练' };
  }
  if (completion === 'hint_used') {
    return { to: 'needs_recheck', reason: '使用了提示，未形成独立掌握证据' };
  }
  if (completion === 'unsure') {
    return { to: 'needs_recheck', reason: '做出但不确定，需再次确认' };
  }

  // completion === 'independent'
  if (!correct) {
    return { to: 'needs_recheck', reason: '独立作答做错，需再次安排' };
  }
  if (isConfirmation || current === 'temporarily_mastered') {
    if (delayDays < MIN_DELAY_DAYS) {
      return { to: current, reason: '确认轮离上次作答不足 3 天，保持暂时掌握，到期再确认' };
    }
    return { to: 'stably_mastered', reason: '延迟确认再次独立做对，进入稳定掌握' };
  }
  if (delayDays < MIN_DELAY_DAYS) {
    return { to: 'attempted', reason: '当场做对不构成延迟掌握，仍待延迟验证' };
  }
  return { to: 'temporarily_mastered', reason: '延迟 3–7 天独立做对，进入暂时掌握' };
}

/** 反思提交后流转 */
export function statusAfterReflection(current: ItemStatus): Transition {
  if (current === 'ready_for_reflection' || current === 'captured' || current === 'needs_review') {
    return { to: 'eligible_for_review', reason: '学生完成四项最小反思' };
  }
  return { to: current, reason: `状态 ${current} 不重复进入可安排` };
}

/** 归档判断：学生认为没必要 且 系统无复发证据 */
export function canArchive(input: {
  reviewValue: ReviewValue | null;
  recurrenceCount: number;
  masteryFeeling: MasteryFeeling | null;
}): { ok: boolean; reason: string } {
  if (input.reviewValue !== '没必要再做') {
    return { ok: false, reason: '学生未判定为不值得保留' };
  }
  if (input.recurrenceCount > 0) {
    return { ok: false, reason: '同知识点/错因存在复发证据，不建议归档' };
  }
  if (input.masteryFeeling !== null && input.masteryFeeling <= 1) {
    return { ok: false, reason: '学生主观掌握感仍低，不建议归档' };
  }
  return { ok: true, reason: '学生判定没必要再做，且无复发证据' };
}
