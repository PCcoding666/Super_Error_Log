import { describe, expect, it } from 'vitest';
import { INSIGHT_MISTAKE_MAX_CHARS, repairLatexEscapes, validateInsight } from '../../src/ai/evidence.js';
import { groupTraces, toItemInsight } from '../../src/web/api.js';

const valid = { answer: '$x = 10$', solution: '1. 列式 $(1+x)^2 = 121$\n2. 解得 $x = 10$', mistake: '你把两轮写成了一轮。', cause: '审题遗漏', uncertain: null };

describe('详情页 AI 解答的契约', () => {
  it('合法输出原样通过', () => {
    expect(validateInsight(valid)).toEqual(valid);
  });

  it('答案或解题过程为空、超长都判失败', () => {
    expect(() => validateInsight({ ...valid, answer: ' ' })).toThrow();
    expect(() => validateInsight({ ...valid, solution: '' })).toThrow();
    expect(() => validateInsight({ ...valid, solution: 'x'.repeat(20001) })).toThrow();
    expect(() => validateInsight({ ...valid, answer: 42 })).toThrow();
  });

  it('错因过长截断而不是作废整次解答；类别不合法或没有错因时不显示类别', () => {
    const long = validateInsight({ ...valid, mistake: '你'.repeat(300) });
    expect(long.mistake).toHaveLength(INSIGHT_MISTAKE_MAX_CHARS);
    expect(long.mistake!.endsWith('…')).toBe(true);
    expect(validateInsight({ ...valid, cause: '粗心' }).cause).toBeNull();
    expect(validateInsight({ ...valid, mistake: null }).cause).toBeNull();
    expect(validateInsight({ ...valid, mistake: '  ' }).mistake).toBeNull();
    expect(validateInsight({ answer: 'a', solution: 'b' })).toEqual({ answer: 'a', solution: 'b', mistake: null, cause: null, uncertain: null });
  });
});

describe('JSON 里少写一个反斜杠的 LaTeX 命令', () => {
  // JSON.parse('"\\frac"') 得到换页符 + rac；这里直接用解析后的结果。
  const parsed = (json: string): string => JSON.parse(`"${json}"`) as string;

  it('换页、退格、制表、回车被吃掉的命令改回来', () => {
    expect(repairLatexEscapes(parsed('$\\frac{1}{2} \\times 3 \\beta \\right)$'))).toBe('$\\frac{1}{2} \\times 3 \\beta \\right)$');
  });

  it('换行只在公式里、后面是常见命令时才改回 \\n…', () => {
    expect(repairLatexEscapes(parsed('$a \\neq b$'))).toBe('$a \\neq b$');
    expect(repairLatexEscapes(parsed('$$\\nexists x$$'))).toBe('$$\\nexists x$$');
    expect(repairLatexEscapes('$$\nx \u000aeq 1\n$$')).toBe('$$\nx \\neq 1\n$$');
  });

  it('正常的换行、制表和写对的命令不动', () => {
    const text = '1. 第一步\neq 是一个字母组合\n2. $\\frac{1}{2}$\n\t缩进';
    expect(repairLatexEscapes(text)).toBe(text);
    expect(validateInsight({ ...valid, solution: parsed('$\\frac{a}{b}$') }).solution).toBe('$\\frac{a}{b}$');
  });
});

describe('详情页的笔迹分组', () => {
  it('两段原作合在「你写的」一处，订正、看不出是谁写的另外标出；老师批注进批改痕迹；资料答案单列', () => {
    const grouped = groupTraces([
      { kind: 'unknown', text: '旁边的小字' },
      { kind: 'student_work', text: '(1+x)² = 121' },
      { kind: 'teacher_note', text: '✗' },
      { kind: 'correction', text: 'x = 10' },
      { kind: 'student_work', text: '10 个人' },
      { kind: 'reference_answer', text: '10' },
      { kind: 'student_work', text: '   ' },
    ]);
    expect(grouped.work).toEqual([
      { label: null, text: '(1+x)² = 121' },
      { label: null, text: '10 个人' },
      { label: '订正', text: 'x = 10' },
      { label: '看不出是谁写的', text: '旁边的小字' },
    ]);
    expect(grouped.marking).toEqual([{ label: null, text: '✗' }]);
    expect(grouped.sourceAnswers).toEqual(['10']);
  });
});

describe('解答状态给学生看的样子', () => {
  const insight = { answer: 'x = 10', solution: '…', mistake: null, cause: null, uncertain: '参考答案写的是 11，和推导不一致。' };

  it('就绪时附上认字、看图和模型自己的提醒', () => {
    const ready = toItemInsight({ state: 'ready', insight, requiresDiagram: true }, true);
    expect(ready).toMatchObject({ state: 'ready', answer: 'x = 10', mistake: null });
    expect(ready.state === 'ready' && ready.warnings).toEqual([
      '题目文字可能认错了，解答是按识别出的文字做的，以照片为准。',
      '这题有图，AI 只看了文字，没看图。',
      '参考答案写的是 11，和推导不一致。',
    ]);
    expect(toItemInsight({ state: 'ready', insight: { ...insight, uncertain: null }, requiresDiagram: false }, false)).toMatchObject({ warnings: [] });
  });

  it('失败区分能不能重试；没法生成的给出原因', () => {
    expect(toItemInsight({ state: 'failed', rateLimited: false }, false)).toMatchObject({ state: 'failed', retryable: true });
    expect(toItemInsight({ state: 'failed', rateLimited: true }, false)).toMatchObject({ state: 'failed', retryable: false, message: expect.stringContaining('一小时') });
    expect(toItemInsight({ state: 'unavailable' }, false)).toMatchObject({ state: 'unavailable', message: expect.stringContaining('识别完整') });
    expect(toItemInsight({ state: 'generating' }, false)).toEqual({ state: 'generating' });
  });
});
