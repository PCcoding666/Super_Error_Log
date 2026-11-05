import { describe, expect, it } from 'vitest';
import { INSIGHT_MISTAKE_MAX_CHARS, repairLatexEscapes, validateAnswerReading, validateInsight } from '../../src/ai/evidence.js';
import { FIGURE_CSP, figureDocument, groupTraces, toItemInsight } from '../../src/web/api.js';

const valid = { answer: '$x = 10$', solution: '1. 列式 $(1+x)^2 = 121$\n2. 解得 $x = 10$', mistake: '你把两轮写成了一轮。', cause: '审题遗漏', uncertain: null, figure: null };

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
    expect(validateInsight({ answer: 'a', solution: 'b' })).toEqual({ answer: 'a', solution: 'b', mistake: null, cause: null, uncertain: null, figure: null });
  });

  it('交互图：HTML 要像 HTML、不超长，脚本里的制表符原样保留；结构不对就不要它，不作废解答', () => {
    const html = '<svg viewBox="0 0 10 10"></svg><script>\tlet t = 1;</script>';
    expect(validateInsight({ ...valid, figure: { kind: 'html', html } }).figure).toEqual({ kind: 'html', html });
    expect(validateInsight({ ...valid, figure: { kind: 'html', html: '就是一段话' } }).figure).toBeNull();
    expect(validateInsight({ ...valid, figure: { kind: 'html', html: `<svg>${'x'.repeat(30001)}</svg>` } }).figure).toBeNull();
    expect(validateInsight({ ...valid, figure: html }).figure).toBeNull();
    expect(validateInsight({ ...valid, figure: 42 }).answer).toBe('$x = 10$');
  });

  it('立体图：只收坐标、棱、强调线和面；引用了不存在的点、点太多、坐标不是数就不要', () => {
    const solid = { kind: 'solid', points: { A: [0, 0, 0], B: [2, 0, 0], C: [2, 2, 0], A1: [0, 0, 2] }, edges: [['A', 'B'], ['B', 'C'], ['A', 'A1']], highlights: [{ from: 'A1', to: 'C', label: 'A₁C' }, { from: 'A', to: 'Z' }], faces: [['A', 'B', 'C'], ['A', 'B']], caption: '红线是 A₁C' };
    expect(validateInsight({ ...valid, figure: solid }).figure).toEqual({ ...solid, highlights: [{ from: 'A1', to: 'C', label: 'A₁C' }], faces: [['A', 'B', 'C']] });
    expect(validateInsight({ ...valid, figure: { ...solid, edges: [['A', 'Z']] } }).figure).toBeNull();
    expect(validateInsight({ ...valid, figure: { ...solid, points: { ...solid.points, B: [1, 'x', 0] } } }).figure).toBeNull();
    expect(validateInsight({ ...valid, figure: { ...solid, points: { '<b>': [0, 0, 0], B: [1, 0, 0] }, edges: [['<b>', 'B']] } }).figure).toBeNull();
    expect(validateInsight({ ...valid, figure: { ...solid, edges: [] } }).figure).toBeNull();
  });

  it('答案只写了 LaTeX 没包 $ 的，整句当公式', () => {
    expect(validateInsight({ ...valid, answer: '\\frac{\\sqrt{2}}{2}' }).answer).toBe('$\\frac{\\sqrt{2}}{2}$');
    expect(validateInsight({ ...valid, answer: 'x = 10' }).answer).toBe('x = 10');
  });

  it('拍的答案：找到了要有文字，没找到文字为空', () => {
    expect(validateAnswerReading({ found: true, text: ' $x=1$ ' })).toEqual({ found: true, text: '$x=1$' });
    expect(validateAnswerReading({ found: false, text: '随便' })).toEqual({ found: false, text: null });
    expect(() => validateAnswerReading({ found: true, text: '' })).toThrow();
    expect(() => validateAnswerReading({ found: 'yes' })).toThrow();
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
      { id: 'u1', kind: 'unknown', text: '旁边的小字' },
      { id: 'w1', kind: 'student_work', text: '(1+x)² = 121' },
      { id: 't1', kind: 'teacher_note', text: '✗' },
      { id: 'c1', kind: 'correction', text: 'x = 10' },
      { id: 'w2', kind: 'student_work', text: '10 个人' },
      { id: 'r1', kind: 'reference_answer', text: '10' },
      { id: 'w3', kind: 'student_work', text: '   ' },
    ]);
    expect(grouped.work).toEqual([
      { id: 'w1', label: null, text: '(1+x)² = 121' },
      { id: 'w2', label: null, text: '10 个人' },
      { id: 'c1', label: '订正', text: 'x = 10' },
      { id: 'u1', label: '看不出是谁写的', text: '旁边的小字' },
    ]);
    expect(grouped.marking).toEqual([{ id: 't1', label: null, text: '✗' }]);
    expect(grouped.sourceAnswers).toEqual([{ id: 'r1', label: null, text: '10' }]);
  });
});

describe('解答状态给学生看的样子', () => {
  const insight = { answer: 'x = 10', solution: '…', mistake: null, cause: null, uncertain: '参考答案写的是 11，和推导不一致。', figure: null };

  it('就绪时附上认字、没看到图和模型自己的提醒', () => {
    const ready = toItemInsight({ state: 'ready', insight, requiresDiagram: true, images: 0 }, true);
    expect(ready).toMatchObject({ state: 'ready', answer: 'x = 10', mistake: null, figureUrl: null });
    expect(ready.state === 'ready' && ready.warnings).toEqual([
      '识别出的题目文字可能有错，解答以照片为准。',
      '这题有图，但 AI 没看到照片，只看了文字。',
      '参考答案写的是 11，和推导不一致。',
    ]);
    expect(toItemInsight({ state: 'ready', insight: { ...insight, uncertain: null }, requiresDiagram: true, images: 1 }, false)).toMatchObject({ warnings: [] });
    expect(toItemInsight({ state: 'ready', insight: { ...insight, figure: { kind: 'html', html: '<svg/>' } }, requiresDiagram: false, images: 1 }, false, figure => `/fig?${figure.kind}`)).toMatchObject({ figureUrl: '/fig?html' });
  });

  it('失败区分能不能重试；没法生成的给出原因；排队中原样给出', () => {
    expect(toItemInsight({ state: 'failed', rateLimited: false }, false)).toMatchObject({ state: 'failed', retryable: true });
    expect(toItemInsight({ state: 'failed', rateLimited: true }, false)).toMatchObject({ state: 'failed', retryable: false, message: expect.stringContaining('一小时') });
    expect(toItemInsight({ state: 'unavailable' }, false)).toMatchObject({ state: 'unavailable', message: expect.stringContaining('识别完整') });
    expect(toItemInsight({ state: 'queued' }, false)).toEqual({ state: 'queued' });
    expect(toItemInsight({ state: 'generating' }, false)).toEqual({ state: 'generating' });
  });
});

describe('交互图页面', () => {
  it('自带 CSP：只许内联脚本和样式，不许网络、表单，强制沙箱，只许本站嵌入；高度报给父页面', () => {
    expect(FIGURE_CSP).toContain("default-src 'none'");
    expect(FIGURE_CSP).toContain("script-src 'unsafe-inline'");
    expect(FIGURE_CSP).toContain("form-action 'none'");
    expect(FIGURE_CSP).toContain("frame-ancestors 'self'");
    expect(FIGURE_CSP).toMatch(/sandbox allow-scripts$/);
    expect(FIGURE_CSP).not.toMatch(/connect-src|https?:/);
    const page = figureDocument({ kind: 'html', html: '<svg id="g"></svg>' });
    expect(page).toMatch(/^<!doctype html>/);
    expect(page).toContain('<svg id="g"></svg>');
    expect(page).toContain('selFigureHeight');
  });

  it('立体图页面：数据当 JSON 放进去（< 转义，点名不会变成标签），用我们自己的旋转脚本', () => {
    const page = figureDocument({ kind: 'solid', points: { A: [0, 0, 0], B: [1, 0, 0] }, edges: [['A', 'B']], highlights: [], faces: [], caption: '</script><b>x</b>' });
    expect(page).toContain('type="application/json"');
    expect(page).not.toContain('</script><b>');
    expect(page).toContain('\\u003c/script>');
    expect(page).toContain('pointermove');
  });
});
