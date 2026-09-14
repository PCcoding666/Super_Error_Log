import { describe, expect, it } from 'vitest';
import * as audit from '../../src/ai/cropAudit.js';

// Catches trusting a model's top-level verdict instead of item-level omissions.
const inventory = { questionNumber: '9', sourceStatus: 'readable', referenceText: '已知2x−1，求B。', uncertainties: [], items: [
  { id: 'c1', category: 'condition', description: '完整的2x−1，包括换行的1' },
  { id: 'c2', category: 'request', description: '求B对应的数' },
] };
const comparison = () => ({ checks: [
  { id: 'c1', visibility: 'present', note: '裁图可见完整2x−1' },
  { id: 'c2', visibility: 'present', note: '裁图可见求B的要求' },
], unexpectedMissing: [], uncertainties: [], boundary: 'clear',
purity: { status: 'clean', issues: [] as string[] }, textFidelity: 'match', textNote: '题干保留了条件与要求' });

describe('裁图语义门禁：合成契约测试，不是模型准确率', () => {
  it('即使API成功且模型声明pass，漏掉关键字符仍判missing', () => {
    const c = comparison(); c.checks[0]!.visibility = 'missing';
    expect(audit.assessCrop(inventory, { ...c, verdict: 'pass' }, 'question').completeness).toBe('missing');
  });
  it('临题污染与完整性分开，审阅可完整但不纯净', () => {
    const c = comparison(); c.purity = { status: 'contaminated', issues: ['带入上一题'] };
    expect(audit.assessCrop(inventory, c, 'question')).toMatchObject({ completeness: 'pass', purity: 'contaminated' });
  });
  it.each(['missing', 'uncertain'])('逐项%s不能被总体置信度覆盖', visibility => {
    const c = comparison(); c.checks[1]!.visibility = visibility;
    expect(audit.assessCrop(inventory, c, 'question').completeness).toBe(visibility);
  });
  it('没有切字的边缘接触只产生警告，不自动失败', () => {
    const c = comparison(); c.boundary = 'touching';
    expect(audit.assessCrop(inventory, c, 'question')).toMatchObject({ completeness: 'pass', warnings: ['内容接触裁图边缘，请人工复核'] });
  });
  it('原图不清楚或存在未解决不确定项时不能pass', () => {
    expect(audit.assessCrop({ ...inventory, sourceStatus: 'uncertain' }, comparison(), 'question').completeness).toBe('uncertain');
    expect(audit.assessCrop({ ...inventory, uncertainties: ['看不清末尾'] }, comparison(), 'question').completeness).toBe('uncertain');
  });
  it('清单缺项、重复ID和空清单不能视为全部完成', () => {
    expect(() => audit.assessCrop(inventory, { ...comparison(), checks: [comparison().checks[0]] }, 'question')).toThrow();
    expect(() => audit.assessCrop(inventory, { ...comparison(), checks: [comparison().checks[0], comparison().checks[0]] }, 'question')).toThrow();
    expect(() => audit.assessCrop({ ...inventory, items: [] }, comparison(), 'question')).toThrow();
  });
  it('遗漏的不在清单上的内容仍构成不完整', () => {
    expect(audit.assessCrop(inventory, { ...comparison(), unexpectedMissing: ['第(2)问'] }, 'question').completeness).toBe('missing');
  });
  it('题干转写错误单独记录，不能用完整裁图证明文本正确', () => {
    expect(audit.assessCrop(inventory, { ...comparison(), textFidelity: 'mismatch', textNote: '文本把1写为3' }, 'question'))
      .toMatchObject({ completeness: 'pass', textFidelity: 'mismatch' });
  });
  it('扩大建议只扩大原框并截在原图边界内', () => {
    expect(audit.expandCropBox({ x: 0, y: .9, width: 1, height: .1 })).toEqual({ x: 0, y: .875, width: 1, height: .125 });
  });
  it('图示与作答的源清单不能跑成整道题目条件', () => {
    expect(() => audit.validateInventory(inventory, 'diagram')).toThrow();
    expect(() => audit.validateInventory(inventory, 'student_work')).toThrow();
  });
  it('题干清单不得将学生答案列成必须保留的条件', () => {
    expect(() => audit.validateInventory({ ...inventory, items: [...inventory.items, { id: 's1', category: 'mark', description: '学生写x=1' }] }, 'question')).toThrow();
  });
});
