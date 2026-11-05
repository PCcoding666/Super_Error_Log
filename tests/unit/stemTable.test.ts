import { describe, expect, it } from 'vitest';
import { questionExcerpt, stemBlocks, withoutTableRows } from '../../src/text/stemBlocks.js';

const QUESTION_10 = [
  '10. (2026 原创题)借助函数可以认识方程与不等式. 观察表格：',
  '| x | … | -2 | -1 | 0 | 1 | 2 | 3 | … |',
  '|---|---|---|---|---|---|---|---|---|',
  '| 3x+1 | … | -5 | -2 | 1 | 4 | 7 | 10 | … |',
  '| -x²+2x+3 | … | -5 | 0 | m | 4 | 3 | 0 | … |',
  '(1)【实践操作】在如图所示的平面直角坐标系中，已经画出了一次函数 y=3x+1 的图象；',
].join('\n');

describe('stemBlocks', () => {
  it('splits a stem into text, a real table, and the text after it', () => {
    const blocks = stemBlocks(QUESTION_10);
    expect(blocks.map(block => block.kind)).toEqual(['text', 'table', 'text']);
    const table = blocks[1]!;
    if (table.kind !== 'table') throw new Error('expected a table');
    expect(table.head).toEqual(['x', '…', '-2', '-1', '0', '1', '2', '3', '…']);
    expect(table.rows).toEqual([
      ['3x+1', '…', '-5', '-2', '1', '4', '7', '10', '…'],
      ['-x²+2x+3', '…', '-5', '0', 'm', '4', '3', '0', '…'],
    ]);
    expect(blocks[0]).toEqual({ kind: 'text', text: '10. (2026 原创题)借助函数可以认识方程与不等式. 观察表格：' });
  });

  it('leaves text without a table exactly as it was', () => {
    const plain = '10. 若 -x²+2x+3 > 3x+1，x_1 * x_2 = ?\n- 1\n(1) |x-1|+|y|=3\n|x-1| = |y+2|';
    expect(stemBlocks(plain)).toEqual([{ kind: 'text', text: plain }]);
  });

  it('needs the delimiter row; a pipe in prose is not a table', () => {
    const prose = '求 | x | 的值\n| a | b |\n再求 y';
    expect(stemBlocks(prose).every(block => block.kind === 'text')).toBe(true);
  });

  it('does not swallow a question line with absolute values that follows the table', () => {
    const blocks = stemBlocks('| x | y |\n|---|---|\n| 1 | 2 |\n(1) 求 |x-1|+|y| 的最小值。\n|x-1| = |y+2| 时呢？');
    expect(blocks.map(block => block.kind)).toEqual(['table', 'text']);
    expect(blocks[0]).toMatchObject({ rows: [['1', '2']] });
    expect(blocks[1]).toEqual({ kind: 'text', text: '(1) 求 |x-1|+|y| 的最小值。\n|x-1| = |y+2| 时呢？' });
  });

  it('ends the table at a row with the wrong cell count instead of truncating or padding it', () => {
    const blocks = stemBlocks('|a|b|\n|-|-|\n|1|2|\n|3|\n|4|5|');
    expect(blocks.map(block => block.kind)).toEqual(['table', 'text']);
    expect(blocks[0]).toMatchObject({ rows: [['1', '2']] });
    expect(blocks[1]).toEqual({ kind: 'text', text: '|3|\n|4|5|' });
  });

  it('reads alignment, tables without outer pipes, and escaped pipes', () => {
    const [table] = stemBlocks('a | b | c\n:--|:-:|--:\n1 | 2 | 3\nx \\| y | 7 | 8');
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(table.align).toEqual(['left', 'center', 'right']);
    expect(table.rows).toEqual([['1', '2', '3'], ['x | y', '7', '8']]);
  });

  it('keeps several tables apart and tolerates CRLF', () => {
    const blocks = stemBlocks('|a|\r\n|-|\r\n|1|\r\n\r\n中间\r\n\r\n|b|\r\n|-|\r\n|2|');
    expect(blocks.map(block => block.kind)).toEqual(['table', 'text', 'table']);
  });
});

describe('pipe rows without a delimiter row (what the model wrote on a real photo)', () => {
  const REAL = [
    '(II)水电站希望安装的发电机尽可能运行，但每年发电机最多可运行台数受年入流量X限制，并有如下关系：',
    '年入流量X | 40 < X < 80 | 80 ≤ X < 120 | X > 120',
    '发电机最多可运行台数 | 1 | 2 | 3',
    '若某台发电机运行，则该台年利润为5000万元；若某台发电机未运行，则该台年亏损800万元。',
  ].join('\n');

  it('draws them as a table, first row as the header', () => {
    const blocks = stemBlocks(REAL);
    expect(blocks.map(block => block.kind)).toEqual(['text', 'table', 'text']);
    expect(blocks[1]).toEqual({
      kind: 'table',
      head: ['年入流量X', '40 < X < 80', '80 ≤ X < 120', 'X > 120'],
      align: [null, null, null, null],
      rows: [['发电机最多可运行台数', '1', '2', '3']],
    });
    expect(blocks[2]).toEqual({ kind: 'text', text: '若某台发电机运行，则该台年利润为5000万元；若某台发电机未运行，则该台年亏损800万元。' });
  });

  it('also accepts outer pipes and more rows', () => {
    const [table] = stemBlocks('| x | 1 | 2 |\n| y | 3 | 4 |\n| z | 5 | 6 |');
    expect(table).toMatchObject({ kind: 'table', head: ['x', '1', '2'], rows: [['y', '3', '4'], ['z', '5', '6']] });
  });

  it('stays text for divisibility, absolute values, two-column lists and a single row', () => {
    for (const text of [
      '(1) 若 2 | a\n(2) 若 3 | b',
      '求 |x-1|+|y| 的最小值。\n|x-1| = |y+2|',
      'a | b\nc | d',
      '年入流量X | 40 | 80 | 120',
      '年入流量X | 40 | 80\n没有第二行',
      '行一 | 1 | 2\n行二 | 3',
      '(1) 求 | x | + | y | 的最小值。\n(2) 求 | x | - | y | 的最大值。',
      '求 | x - 1 | 的最小值。\n求 | y + 1 | 的最大值。',
      '① 若 | a | = | b |\n② 若 | c | = | d |',
    ]) {
      expect(stemBlocks(text), text).toEqual([{ kind: 'text', text }]);
    }
  });

  it('keeps spaced absolute-value sub-questions, and their excerpt, intact', () => {
    const text = '(1) 求 | x | + | y | 的最小值。\n(2) 求 | x | - | y | 的最大值。';
    expect(withoutTableRows(text)).toBe(text);
    expect(questionExcerpt(text)).toBe(text);
  });

  it('still draws a data row whose first cell is a decimal or starts with a digit', () => {
    const [table] = stemBlocks('x | 1 | 2.5 | 3\n3.5 | 4 | 5 | 6');
    expect(table).toMatchObject({ kind: 'table', rows: [['3.5', '4', '5', '6']] });
  });

  it('keeps the table out of list excerpts', () => {
    expect(withoutTableRows(REAL)).not.toContain('|');
    expect(withoutTableRows(REAL)).toContain('若某台发电机运行');
  });
});

describe('withoutTableRows / questionExcerpt', () => {
  it('drops the whole table, including header and delimiter, but keeps prose', () => {
    expect(withoutTableRows(QUESTION_10).split('\n')).toEqual([
      '10. (2026 原创题)借助函数可以认识方程与不等式. 观察表格：',
      '(1)【实践操作】在如图所示的平面直角坐标系中，已经画出了一次函数 y=3x+1 的图象；',
    ]);
  });

  it('never removes absolute-value text that is not part of a table', () => {
    for (const text of ['|x-1|+|y|=3 求最小值', '|x-1| = |y+2|', '求 |x-1|+|y| 的最小值。\n|x-1| = |y+2|']) {
      expect(withoutTableRows(text)).toBe(text);
    }
    expect(withoutTableRows('| 1 | 2 |\n(1) |x-1| = |y+2|')).toBe('| 1 | 2 |\n(1) |x-1| = |y+2|');
  });

  it('truncates after removing the table, so a table is never cut in half, and is unchanged without one', () => {
    expect(questionExcerpt(QUESTION_10)).not.toContain('|');
    expect(questionExcerpt(QUESTION_10)).toHaveLength(80);
    const plain = '一二三四五六七八九十'.repeat(12);
    expect(questionExcerpt(plain)).toBe(plain.slice(0, 80));
  });
});
