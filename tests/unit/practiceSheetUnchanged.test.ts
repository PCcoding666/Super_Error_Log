/**
 * 练习纸（A4）的版式与内容不改（Peng 2026-10-11 的决定；quality round 2 只改打印前后的网页）。
 * 固定样本：tests/fixtures/practice-sheet-r1.html 与 practice-sheet-r1.css 是在 R2 开工前的基线
 * （5436a44，R1 合并后的工作分支）上用同一份合成快照渲染、从样式表里摘出来的。
 * 这里逐字比对：纸面的 HTML 一个字节都不变；纸面的样式（.sheet… 规则与 @media print 块里原有的每一行）都还在。
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PrintSnapshot } from '../../src/v2/printService.js';
import { PracticeSheet } from '../../src/web/views/practice.js';
import { STYLES } from '../../src/web/assets.js';

const fixtures = path.join(import.meta.dirname, '..', 'fixtures');

describe('练习纸版式不变（R1 基线）', () => {
  it('同一份快照渲染出的纸面 HTML 与基线逐字相同', () => {
    const snapshot = JSON.parse(fs.readFileSync(path.join(fixtures, 'practice-sheet-snapshot.json'), 'utf8')) as PrintSnapshot;
    const expected = fs.readFileSync(path.join(fixtures, 'practice-sheet-r1.html'), 'utf8').trimEnd();
    expect(renderToStaticMarkup(PracticeSheet({ snapshot }) as never)).toBe(expected);
  });

  it('纸面的样式规则（.sheet… 与打印块里原有的每一行）都原样还在', () => {
    const lines = fs.readFileSync(path.join(fixtures, 'practice-sheet-r1.css'), 'utf8').split('\n').filter(line => line.trim() !== '');
    expect(lines.length).toBeGreaterThan(20);
    const current = STYLES.split('\n');
    for (const line of lines) expect(current, line).toContain(line);
  });
});
