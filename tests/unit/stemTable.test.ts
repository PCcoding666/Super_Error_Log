import { describe, expect, it } from 'vitest';
import { stemBlocks } from '../../client/src/lib/stemBlocks.js';
import { withoutTableRows } from '../../src/web/stemText.js';

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
    const plain = '10. 若 -x²+2x+3 > 3x+1，x_1 * x_2 = ?\n- 1\n(1) |x-1|+|y|=3';
    expect(stemBlocks(plain)).toEqual([{ kind: 'text', text: plain }]);
  });

  it('needs the delimiter row; a pipe in prose is not a table', () => {
    const prose = '求 | x | 的值\n| a | b |\n再求 y';
    expect(stemBlocks(prose).every(block => block.kind === 'text')).toBe(true);
  });

  it('reads alignment, tables without outer pipes, escaped pipes, and ragged rows', () => {
    const [table] = stemBlocks('a | b | c\n:--|:-:|--:\n1 | 2\n3 | 4 | 5 | 6\nx \\| y | 7 | 8');
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(table.align).toEqual(['left', 'center', 'right']);
    expect(table.rows).toEqual([['1', '2', ''], ['3', '4', '5'], ['x | y', '7', '8']]);
  });

  it('keeps several tables apart and tolerates CRLF', () => {
    const blocks = stemBlocks('|a|\r\n|-|\r\n|1|\r\n\r\n中间\r\n\r\n|b|\r\n|-|\r\n|2|');
    expect(blocks.map(block => block.kind)).toEqual(['table', 'text', 'table']);
  });
});

describe('withoutTableRows', () => {
  it('drops table rows but keeps prose, including absolute values', () => {
    expect(withoutTableRows(QUESTION_10).split('\n')).toEqual([
      '10. (2026 原创题)借助函数可以认识方程与不等式. 观察表格：',
      '(1)【实践操作】在如图所示的平面直角坐标系中，已经画出了一次函数 y=3x+1 的图象；',
    ]);
    expect(withoutTableRows('|x-1|+|y|=3 求最小值')).toBe('|x-1|+|y|=3 求最小值');
  });
});
