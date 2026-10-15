/**
 * 照片进度的纯逻辑：对照 iOS WeekPlanTests.testLocalPhotoStatesFollowThePhotoProgressRules 与 PhotoFailurePlan 的文案。
 * 网页版没有「还在手机上」的照片：拍完立刻上传登记，所以只有 找题中 / 要你勾 / 没认出来 / 走完了。
 */
import { describe, expect, it } from 'vitest';
import type { RecognitionJob, RecognitionQuestion } from '../../src/mobile/contracts.js';
import { photoFailurePlan, photoState, pickMoreCount, showsNoMarksRow } from '../../src/web/photoPlan.js';

const none = { pickDone: false, dismissed: false };

function question(status: RecognitionQuestion['status'], extra: Partial<RecognitionQuestion> = {}): RecognitionQuestion {
  return { id: `q-${Math.random()}`, number: '1', revision: 1, status, selectionEvidence: 'unmarked', evidence: null, verification: null, questionMediaId: null, diagramMediaIds: [], error: null, confirmedAt: null, ...extra };
}
function job(status: RecognitionJob['status'], questions: RecognitionQuestion[], extra: Partial<RecognitionJob> = {}): RecognitionJob {
  return { version: 1, id: '3f7b69dc-9d37-4aaa-b965-bb61243445a0', revision: 2, photoName: 'p.jpg', sourceHash: 'abc', sourceMediaId: '6ddc034b-b0f8-4288-b9c1-4f496cfb90df', status, phase: 'complete', inventoryWarnings: [], questions, error: null, createdAt: '', updatedAt: '', ...extra };
}

describe('照片状态（与 iOS WeekPlan.localState 同规则）', () => {
  it('找题中 / 要你勾 / 点过「这页没有做错的题」/ 走完了 / 没认出来 / 移除', () => {
    expect(photoState(null, none)).toBe('finding');
    expect(photoState(job('processing', [question('processing')], { phase: 'questions' }), none)).toBe('finding');
    expect(photoState(job('completed', [question('unselected')]), none)).toBe('needsPick');
    expect(photoState(job('completed', [question('unselected')]), { pickDone: true, dismissed: false })).toBeNull();
    expect(photoState(job('completed', [question('ready', { selectionEvidence: 'marked_wrong' })]), none)).toBeNull();
    expect(photoState(job('failed', [], { phase: 'inventory', error: { code: 'invalid_image', message: '读不出来', stage: 'inventory', retryable: false } }), none)).toBe('failed');
    expect(photoState(job('failed', []), { pickDone: false, dismissed: true })).toBeNull();
  });

  it('有自动题的页不算「没批改痕迹」；识别中还有没勾的题时给补选数', () => {
    const mixed = job('completed', [question('ready', { selectionEvidence: 'marked_wrong' }), question('unselected')]);
    expect(showsNoMarksRow(mixed, none)).toBe(false);
    expect(pickMoreCount(job('processing', [question('processing'), question('unselected'), question('unselected')], { phase: 'questions' }))).toBe(2);
    expect(pickMoreCount(mixed)).toBeNull();
  });
});

describe('没识别成功时的说法（与 iOS PhotoFailurePlan 同文案）', () => {
  it('找题失败可恢复：整张再试一次', () => {
    const plan = photoFailurePlan(job('failed', [], { phase: 'inventory', error: { code: 'timeout', message: '超时', stage: 'inventory', retryable: true } }));
    expect(plan).toEqual({ title: '这张没识别成功', detail: '可以再试一次（会重新请求 AI）', retryTitle: '再试一次', dismissTitle: '移除这张', retryQuestionIds: null });
  });
  it('终态但一道题都没找到：只能移除', () => {
    expect(photoFailurePlan(job('completed', []))?.title).toBe('这张照片里没找到题目');
  });
  it('部分失败可重试：只重试失败的题，其余已进错题本', () => {
    const failed = question('failed', { id: 'f1', error: { code: 'timeout', message: '超时', stage: 'transcribe', retryable: true } });
    const plan = photoFailurePlan(job('partial', [question('ready'), question('ready'), failed]));
    expect(plan).toMatchObject({ title: '这张有 1 道没认出来', detail: '其余 2 道已进错题本', retryTitle: '重试这 1 道', dismissTitle: '不管了', retryQuestionIds: ['f1'] });
  });
  it('全部失败且不能恢复：说原因并建议重拍', () => {
    const failed = question('failed', { error: { code: 'invalid_image', message: '图片太糊', stage: 'transcribe', retryable: false } });
    expect(photoFailurePlan(job('partial', [failed]))?.detail).toBe('图片太糊。请重拍一张更清楚的');
  });
  it('没勾的题不算失败也不算总数', () => {
    expect(photoFailurePlan(job('completed', [question('unselected'), question('ready')]))).toBeNull();
  });
});
