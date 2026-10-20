import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ItemDetailPage } from '../../src/web/views/itemDetail.js';
import { answerItem, LONG_ANSWER } from '../fixtures/answerRendering.js';

function renderNote(text: string, kind = 'student_work'): string {
  return renderToStaticMarkup(ItemDetailPage({
    item: answerItem, canDiscard: true, reflected: false,
    evidence: { questionText: '合成题目', subject: '数学', knowledgeTags: [], badge: 'ok', revision: 1,
      observations: [{ id: 'synthetic-note', kind, text }] },
  }));
}

describe('original answer presentation', () => {
  it('separates questions and cases and typesets existing Unicode fractions, roots and powers', () => {
    const html = renderNote(LONG_ANSWER);
    expect(html.match(/class="answer-part"/g)).toHaveLength(2);
    expect(html.match(/class="answer-case"/g)).toHaveLength(3);
    expect(html.match(/class="answer-result"/g)).toHaveLength(2);
    expect(html).toContain('<mfrac>');
    expect(html).toContain('<msqrt>');
    expect(html).toContain('<msup>');
    expect(html).toContain('<msub>');
    // Retain the student's deliberate mistakes in a verbatim disclosure.
    expect(html).toContain('查看原文');
    expect(html).toContain(LONG_ANSWER.replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
    expect(html).toContain('(4-2m)²');
    expect(html).not.toContain('Q(1,3)');
  });

  it('does not treat coordinates, decimals, dates or prices as numbered steps or fractions', () => {
    const text = '点 (1,2)，日期 2026/10/20，编号 (12)，单价 $5，合计 $10。';
    const html = renderNote(text);
    expect(html).not.toContain('class="answer-part"');
    expect(html).not.toContain('<math');
    expect(html).toContain(text);
  });

  it('renders explicit LaTeX without requiring browser scripts', () => {
    const html = renderNote(String.raw`由 \(a=\frac{1}{3}\) 得：\[y=\sqrt{x^2+1}\]`);
    expect(html).toContain('<mfrac>');
    expect(html).toContain('<msqrt>');
    expect(html).toContain('display="block"');
    expect(html).not.toMatch(/<script[^>]*katex/);
  });

  it('keeps malformed formulas and untrusted markup readable without executing HTML', () => {
    const text = String.raw`\(\badcommand{x}\) <img src=x onerror=alert(1)>，x² = 9`;
    const html = renderNote(text);
    expect(html).toContain('\\badcommand{x}');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img src="x"');
    expect(html).not.toContain('<script>alert');
  });

  it('labels a teacher deduction while preserving ordinary teacher comments', () => {
    expect(renderNote('-2', 'teacher_note')).toContain('扣 2 分');
    expect(renderNote('第二步符号有误，x=-2', 'teacher_note')).toContain('第二步符号有误，x=-2');
    expect(renderNote('-2', 'student_work')).not.toContain('扣 2 分');
  });

  it.each(['(1)² = 1', '(1)/2 = 0.5', '(1) + (2) = 3'])('keeps parenthesized mathematical atoms in their expression: %s', text => {
    const html = renderNote(text);
    expect(html).not.toContain('class="answer-part"');
  });

  it.each(['1,000/2', '1e3/2', '1e−3/2', '2.5E−3/2', '1e⁻³/2', '1 000/2', 'x^2/2', '$5 and $10'])('keeps ambiguous numeric notation verbatim: %s', text => {
    const html = renderNote(text);
    expect(html).not.toContain('<math');
    expect(html).toContain(text);
  });
});
