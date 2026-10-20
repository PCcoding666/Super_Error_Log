/**
 * 练习纸（A4）以 R1 为基线；2026-10-16 用户批准删除预设时间、统一答案页原卷提示。
 * 固定样本：tests/fixtures/practice-sheet-r1.html 与 practice-sheet-r1.css 是在 R2 开工前的基线
 * （5436a44，R1 合并后的工作分支）上用同一份合成快照渲染、从样式表里摘出来的。
 * 除这两类已批准文案外逐字比对 HTML；纸面的样式（.sheet… 与 @media print）保持不变。
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
  it('旧快照只调整预设时间和原卷提示，其余纸面 HTML 与基线逐字相同', () => {
    const snapshot = JSON.parse(fs.readFileSync(path.join(fixtures, 'practice-sheet-snapshot.json'), 'utf8')) as PrintSnapshot;
    const expected = fs.readFileSync(path.join(fixtures, 'practice-sheet-r1.html'), 'utf8').trimEnd()
      .replace('<p>什么时候做：周三晚自习</p>', '')
      .replace('<p>对照原卷第 3 题</p>', '<p>对照原卷查看解析</p>')
      .replace('<p>回家后对照原卷</p>', '<p>对照原卷查看解析</p>');
    expect(renderToStaticMarkup(PracticeSheet({ snapshot }) as never)).toBe(expected);
  });

  it('纸面的样式规则（.sheet… 与打印块里原有的每一行）都原样还在', () => {
    const lines = fs.readFileSync(path.join(fixtures, 'practice-sheet-r1.css'), 'utf8').split('\n').filter(line => line.trim() !== '');
    expect(lines.length).toBeGreaterThan(20);
    const current = STYLES.split('\n');
    for (const line of lines) expect(current, line).toContain(line);
  });
});
