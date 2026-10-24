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
