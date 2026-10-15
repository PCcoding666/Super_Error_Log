/** 短句按词组分块（src/web/phrases.ts）：拼回去和原文逐字相同；收尾标点不打头；最后一块不是单字。 */
import { describe, expect, it } from 'vitest';
import { phrasePieces } from '../../src/web/phrases.js';

const SAMPLES = [
  '第 1 道印出来是这样', '展开看整张', '这周的事做完了', '连接这台手机', '看看找到的错题（3 道）', '下一步：选这周要练的题', '打印好了，回到今天',
  '拍这周的卷子', '说说为什么错', '整页拍，一页一张', '打出来，带回学校', '这周没发卷子，跳过', '拍卷子·打印', '放到主屏幕，像 App 一样打开',
  '真会了 ✓（1 道）', '做对了，过几天再确认（1 道）', 'AI 先帮你选好，5–8 道', '「相机」对准它', '还有 2 道没勾 · 漏了题可以补',
];
const letters = (text: string): number => (text.match(/[\p{L}\p{N}]/gu) ?? []).length;

describe('phrasePieces', () => {
  it('空括号、括号里的空格、引号均保持原文顺序', () => {
    for (const text of ['（ 题目）', '前面（ ）后面', 'abc( test)', 'abc()', '（「题目」）', '末尾（ ', '[  ]', '「 」']) {
      expect(phrasePieces(text).join(''), text).toBe(text);
    }
  });
  it('拼回去与原文逐字相同', () => {
    for (const text of SAMPLES) expect(phrasePieces(text).join(''), text).toBe(text);
  });

  it('收尾标点（，。：）」等）不在一块的开头，开头标点（（「）不在一块的结尾', () => {
    for (const text of SAMPLES) {
      for (const piece of phrasePieces(text)) {
        expect(piece, `${text} → ${piece}`).not.toMatch(/^[，。、；：！？）」』】]/);
        expect(piece, `${text} → ${piece}`).not.toMatch(/[（「『【]$/);
      }
    }
  });

  it('多于一个字的短句，最后一块不只有一个字；「」里的短引语不拆开', () => {
    for (const text of SAMPLES) {
      const pieces = phrasePieces(text).filter(piece => piece.trim() !== '');
      if (letters(text) > 1) expect(letters(pieces[pieces.length - 1]!), `${text} → ${pieces.join(' | ')}`).toBeGreaterThan(1);
    }
    expect(phrasePieces('「相机」对准它')[0]).toBe('「相机」');
  });

  it('举例：「第 1 道印出来是这样」不会剩下「样」，节奏条的窄格子按两个字分', () => {
    expect(phrasePieces('第 1 道印出来是这样')).toEqual(['第 1 道印', '出来是', '这样']);
    expect(phrasePieces('展开看整张')).toEqual(['展开看', '整张']);
    expect(phrasePieces('在纸上做', 2)).toEqual(['在纸', '上做']);
  });
});
