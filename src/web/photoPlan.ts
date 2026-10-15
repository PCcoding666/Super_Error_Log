// 照片进度的纯逻辑：移植自 iOS `PhotoPickReminder.swift`、`PhotoFailurePlan.swift` 与 `WeekPlan.localState`。
// 网页版没有手机本地照片：拍完立刻上传并登记，所以照片状态全部从服务器上的识别任务读出来；
// 「这页没有做错的题」(pickDone) 与「移除这张」(dismissed) 两个本机标记由网页存在 cookie 里，由调用方传入。

import { canRecover, type RecognitionJob, type RecognitionQuestion } from '../mobile/contracts.js';
import type { LocalPhotoState } from './weekPlan.js';

export interface PhotoFlags { pickDone: boolean; dismissed: boolean }

export interface PhotoFailurePlan {
  title: string;
  detail: string;
  /** 重试按钮文案；null = 识别不了，不能重试。 */
  retryTitle: string | null;
  /** 收尾按钮文案：「移除这张」/「不管了」/「知道了」，都只是不再显示。 */
  dismissTitle: string;
  /** 逐题重试的题目 id；null = 整张重试（仅找题阶段失败且可恢复时服务器才接受）。 */
  retryQuestionIds: string[] | null;
}

const TERMINAL = new Set(['completed', 'partial']);

function isActive(job: RecognitionJob): boolean {
  return job.status === 'queued' || job.status === 'processing' || job.questions.some(q => q.status === 'queued' || q.status === 'processing');
}

export function unselectedQuestions(job: RecognitionJob | null): RecognitionQuestion[] {
  return job?.questions.filter(q => q.status === 'unselected') ?? [];
}

function failureReason(job: RecognitionJob, failed: RecognitionQuestion[]): string | null {
  return job.error?.message ?? failed.map(q => q.error?.message).find(Boolean) ?? null;
}

function unreadableDetail(reason: string | null): string {
  const trimmed = (reason ?? '').trim();
  const base = trimmed === '' ? 'AI 没能读出这张照片' : trimmed;
  const sentence = /[。！？]$/.test(base) ? base : `${base}。`;
  return `${sentence}请重拍一张更清楚的`;
}

/** 照片没识别成功时学生看到什么、能点什么；null = 没有要他决定的失败。与 iOS PhotoFailurePlan.plan 同规则同文案。 */
export function photoFailurePlan(job: RecognitionJob | null): PhotoFailurePlan | null {
  if (!job) return null;
  const questions = job.questions.filter(q => q.status !== 'unselected');
  const failed = questions.filter(q => q.status === 'failed');
  const recoverableIds = failed.filter(q => canRecover(q.error)).map(q => q.id);
  const inventoryFailure = job.error && job.error.stage === 'inventory' ? job.error : null;

  if (job.status === 'interrupted') {
    return { title: '识别中断了', detail: '回到前台会自动继续；一直不动可以再试一次', retryTitle: '再试一次', dismissTitle: '移除这张',
      retryQuestionIds: inventoryFailure && canRecover(inventoryFailure) ? null : recoverableIds };
  }
  if (job.status === 'failed' && inventoryFailure) {
    if (canRecover(inventoryFailure)) {
      return { title: '这张没识别成功', detail: '可以再试一次（会重新请求 AI）', retryTitle: '再试一次', dismissTitle: '移除这张', retryQuestionIds: null };
    }
    return { title: '这张识别不了', detail: unreadableDetail(inventoryFailure.message), retryTitle: null, dismissTitle: '移除这张', retryQuestionIds: null };
  }
  if (TERMINAL.has(job.status) && job.questions.length === 0) {
    return { title: '这张照片里没找到题目', detail: '把整页拍清楚再拍一张；不是试卷的照片可以直接移除', retryTitle: null, dismissTitle: '移除这张', retryQuestionIds: null };
  }
  if (failed.length === 0) return null;
  if (failed.length === questions.length) {
    if (recoverableIds.length > 0) {
      return { title: `${failed.length} 道都没认出来`, detail: '可以再试一次（只重试失败的题）', retryTitle: '再试一次', dismissTitle: '移除这张', retryQuestionIds: recoverableIds };
    }
    return { title: '这张识别不了', detail: unreadableDetail(failureReason(job, failed)), retryTitle: null, dismissTitle: '移除这张', retryQuestionIds: null };
  }
  const succeeded = questions.length - failed.length;
  if (recoverableIds.length > 0) {
    return { title: `这张有 ${failed.length} 道没认出来`, detail: `其余 ${succeeded} 道已进错题本`, retryTitle: `重试这 ${failed.length} 道`, dismissTitle: '不管了', retryQuestionIds: recoverableIds };
  }
  return { title: `这张有 ${failed.length} 道没认出来`, detail: `其余 ${succeeded} 道已进错题本；这几道识别不了，需要的话把它们单独重拍`, retryTitle: null, dismissTitle: '知道了', retryQuestionIds: null };
}

/** 「这页没有批改痕迹」行：已过找题（终态）、一道自动题都没有、没点过「这页没有做错的题」、没有失败方案。 */
export function showsNoMarksRow(job: RecognitionJob | null, flags: PhotoFlags): boolean {
  if (!job || !TERMINAL.has(job.status) || flags.pickDone || job.questions.length === 0) return false;
  if (!job.questions.every(q => q.status === 'unselected')) return false;
  return photoFailurePlan(job) === null;
}

/** 识别中且还有未选题：「还有 N 道没勾 · 漏了题可以补」的 N；null 不显示。 */
export function pickMoreCount(job: RecognitionJob | null): number | null {
  if (!job || !isActive(job)) return null;
  const count = unselectedQuestions(job).length;
  return count > 0 ? count : null;
}

/** 一张照片现在处在哪一段；null = 已经走完（识别完成、没有要他处理的），或已被他移除。与 WeekPlan.localState 同规则。 */
export function photoState(job: RecognitionJob | null, flags: PhotoFlags): LocalPhotoState | null {
  if (!job) return 'finding';
  if (TERMINAL.has(job.status)) {
    if (!flags.dismissed && photoFailurePlan(job) !== null) return 'failed';
    if (showsNoMarksRow(job, flags)) return 'needsPick';
    return null;
  }
  if (job.status === 'failed' || job.status === 'interrupted') return flags.dismissed ? null : 'failed';
  // 识别中，或未知状态：都按「AI 在干活」算，不误报完成。
  return 'finding';
}
