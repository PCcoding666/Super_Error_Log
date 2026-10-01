import { describe, expect, it } from 'vitest';
import { validateEvidence, validateDiagnosis, validateLayout, assertPrintable, validateFollowupAsk, validateCorrectionProposal } from '../../src/ai/evidence.js';

export const evidenceFixture = () => ({
  version: 1, questionNumber: '13', questionText: '两根互为倒数，求 m。', subject: '数学',
  chapter: '一元二次方程', knowledgeTags: ['根与系数'], questionType: '计算',
  questionRegion: { x: .1, y: .1, width: .8, height: .8 }, requiresDiagram: false,
  regions: [{ id: 'r1', kind: 'student_work', box: { x: .2, y: .3, width: .4, height: .3 }, confidence: .9, cleanForPrint: false }],
  observations: [{ id: 'o1', kind: 'student_work', text: 'x1 + x2 = 0，m = 1', regionId: 'r1', confidence: .9 }],
  uncertainties: [],
});

describe('证据边界', () => {
  it('完整作答、区域来源在校验后保留，而不降为布尔标记', () => {
    const result = validateEvidence(evidenceFixture());
    expect(result.observations[0]!.text).toBe('x1 + x2 = 0，m = 1');
    expect(result.regions[0]!.box).toEqual({ x: .2, y: .3, width: .4, height: .3 });
  });
  it('拒绝空题干、越界裁图、重复证据 ID 与不存在的来源', () => {
    const base = evidenceFixture();
    expect(() => validateEvidence({ ...base, questionText: ' ' })).toThrow();
    expect(() => validateEvidence({ ...base, questionRegion: { x: .9, y: 0, width: .5, height: 1 } })).toThrow();
    expect(() => validateEvidence({ ...base, observations: [...base.observations, ...base.observations] })).toThrow();
    expect(() => validateEvidence({ ...base, observations: [{ ...base.observations[0], regionId: 'missing' }] })).toThrow();
  });
  it('诊断必须引用存在的学生证据，不能只有题目就断言错因', () => {
    const e = validateEvidence(evidenceFixture());
    const d = { summary: '所用关系与条件不符', possibleCause: '知识概念', confidence: .7,
      findings: [{ observationIds: ['o1'], explanation: '倒数应检查乘积' }], clarificationQuestion: '你当时如何理解倒数？' };
    expect(validateDiagnosis(d, e).findings[0]!.observationIds).toEqual(['o1']);
    expect(() => validateDiagnosis({ ...d, findings: [{ observationIds: ['fake'], explanation: '猜测' }] }, e)).toThrow();
    expect(() => validateDiagnosis(d, { ...e, observations: [] })).toThrow();
  });
  it('缺图或未确认干净图示的题目不可打印', () => {
    const e = validateEvidence(evidenceFixture());
    expect(() => assertPrintable(e, false)).toThrow();
    expect(() => assertPrintable({ ...e, requiresDiagram: true }, true)).toThrow();
    const diagram = { ...e.regions[0]!, id: 'd1', kind: 'diagram' as const, cleanForPrint: false };
    expect(() => assertPrintable({ ...e, requiresDiagram: true, regions: [diagram] }, true)).toThrow();
    expect(() => assertPrintable({ ...e, requiresDiagram: true, regions: [{ ...diagram, cleanForPrint: true }] }, true)).not.toThrow();
  });
  it('布局拒绝重复题号和非法坐标，空数组是合法的无题结果', () => {
    expect(validateLayout({ questions: [] })).toEqual({ questions: [] });
    const q = { questionNumber: '1', box: { x: 0, y: 0, width: 1, height: 1 }, confidence: .9, selectionEvidence: 'unclear' };
    expect(() => validateLayout({ questions: [q, q] })).toThrow();
  });
});

describe('T5R2-F3 追问引用规则', () => {
  const withCorrection = () => validateEvidence({
    ...evidenceFixture(),
    regions: [...evidenceFixture().regions, { id: 'r2', kind: 'correction' as const, box: { x: .2, y: .7, width: .4, height: .1 }, confidence: .9, cleanForPrint: false }],
    observations: [...evidenceFixture().observations, { id: 'o2', kind: 'correction' as const, text: '改：m = -1', regionId: 'r2', confidence: .9 }],
  });

  it('有 student_work 时 referencedObservationIds 至少含一个 student_work，否则按失败处理', () => {
    const e = withCorrection();
    // 只引订正 → 抛错（上层退回固定开放句）。
    expect(() => validateFollowupAsk({ question: '你当时是怎么想的？', referencedObservationIds: ['o2'] }, e)).toThrow();
    // 原作 + 订正都引 → 通过。
    expect(validateFollowupAsk({ question: '你当时是怎么想的？', referencedObservationIds: ['o1', 'o2'] }, e).referencedObservationIds).toEqual(['o1', 'o2']);
    // 只引原作 → 通过。
    expect(validateFollowupAsk({ question: '你当时是怎么想的？', referencedObservationIds: ['o1'] }, e).referencedObservationIds).toEqual(['o1']);
  });

  it('没有 student_work 时引用订正合法', () => {
    const e = validateEvidence({
      ...evidenceFixture(), regions: [{ id: 'r2', kind: 'correction' as const, box: { x: .2, y: .7, width: .4, height: .1 }, confidence: .9, cleanForPrint: false }],
      observations: [{ id: 'o2', kind: 'correction' as const, text: '改：m = -1', regionId: 'r2', confidence: .9 }],
    });
    expect(validateFollowupAsk({ question: '你当时是怎么想的？', referencedObservationIds: ['o2'] }, e).referencedObservationIds).toEqual(['o2']);
  });
});

describe('T5R2-F4 clarify 截断', () => {
  it('clarify 超过 80 字截断到 80 字，不判失败；80 字以内原样保留', () => {
    const e = validateEvidence(evidenceFixture());
    const long = validateCorrectionProposal({ changes: [], clarify: '问'.repeat(100) }, e);
    expect(long.clarify).toHaveLength(80);
    const short = validateCorrectionProposal({ changes: [], clarify: '是哪个字认错了？' }, e);
    expect(short.clarify).toBe('是哪个字认错了？');
  });
});
