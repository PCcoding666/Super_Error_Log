export type Subject = '数学' | '物理' | '化学';
export const SUBJECTS: readonly Subject[] = ['数学', '物理', '化学'];

export type ItemStatus =
  | 'captured'
  | 'needs_review'
  | 'ready_for_reflection'
  | 'eligible_for_review'
  | 'scheduled'
  | 'packet_generated'
  | 'attempted'
  | 'needs_recheck'
  | 'temporarily_mastered'
  | 'stably_mastered'
  | 'archived_not_worth_review';

export const STATUS_LABEL: Record<ItemStatus, string> = {
  captured: '已采集',
  needs_review: '待校正',
  ready_for_reflection: '待反思',
  eligible_for_review: '可安排复习',
  scheduled: '已安排',
  packet_generated: '已入复习包',
  attempted: '已作答',
  needs_recheck: '待重练',
  temporarily_mastered: '暂时掌握',
  stably_mastered: '稳定掌握',
  archived_not_worth_review: '已归档',
};

export const ATTEMPT_STATES = [
  '完全不会',
  '知道考什么但没想到方法',
  '方法基本正确但步骤出错',
  '本来会但审题计算书写失误',
  '时间不足',
  '其他',
] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

export const CAUSES = [
  '知识概念',
  '方法选择',
  '推理步骤',
  '计算',
  '审题遗漏',
  '表达规范',
  '时间注意力状态',
] as const;
export type Cause = (typeof CAUSES)[number];

export const REVIEW_VALUES = ['必须再做', '可以再做', '没必要再做'] as const;
export type ReviewValue = (typeof REVIEW_VALUES)[number];

export type MasteryFeeling = 0 | 1 | 2 | 3;
export const MASTERY_FEELING_LABEL: Record<MasteryFeeling, string> = {
  0: '仍不会',
  1: '看提示可能会',
  2: '现在重做应该会',
  3: '隔几天也有把握',
};

export type Completion = 'independent' | 'unsure' | 'hint_used' | 'failed' | 'unfinished';
export const COMPLETION_LABEL: Record<Completion, string> = {
  independent: '独立完成',
  unsure: '做出但不确定',
  hint_used: '使用提示',
  failed: '完全不会',
  unfinished: '未完成',
};

export type BatchStatus = 'processing' | 'needs_attention' | 'partial' | 'done' | 'failed';

export type AssetStatus =
  | 'queued'
  | 'processing'
  | 'done'
  | 'failed'
  | 'duplicate'
  | 'unsupported'
  | 'too_large'
  | 'empty';

export type Role = 'student' | 'parent';

export interface ReflectionInput {
  attemptState: AttemptState;
  cause: Cause;
  masteryFeeling: MasteryFeeling;
  reviewValue: ReviewValue;
}
