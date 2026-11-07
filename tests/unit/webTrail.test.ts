/**
 * 网页版互动记录的两个纯函数：路由模板（ID 一律换成占位符）与点按 cookie 的解析（只认固定格式）。
 * 再加上 ISO 周号的显示写法。不连服务器，不写数据库。
 */
import { describe, expect, it } from 'vitest';
import { parseTapCookie, routeTemplate } from '../../src/web/trail.js';
import { isoWeekMonday, weekRangeText } from '../../src/web/format.js';

describe('互动记录：路由模板', () => {
  it('练习、题目、照片的 ID 换成占位符；查询参数与锚点不进模板', () => {
    expect(routeTemplate('/s/why/pkt_0123456789abcdef/itm_fedcba9876543210/confirm')).toBe('/s/why/:pid/:itemId/confirm');
    expect(routeTemplate('/s/photos/2b1c7f0e-4f3a-4d2b-9c1e-0a1b2c3d4e5f')).toBe('/s/photos/:jobId');
    expect(routeTemplate('/s/pair?code=SECRET')).toBe('/s/pair');
    expect(routeTemplate('/s/?printed=1#x')).toBe('/s/');
  });

  it('材料等其他带前缀的 ID 统一换成 :id，不进日志', () => {
    expect(routeTemplate('/s/materials/fragments/mfr_2e30023498746fbf/crop')).toBe('/s/materials/fragments/:id/crop');
    expect(routeTemplate('/s/materials/assets/ast_0123456789abcdef/image')).toBe('/s/materials/assets/:id/image');
    expect(routeTemplate('/s/materials/questions/mqu_0123456789abcdef/answers')).toBe('/s/materials/questions/:id/answers');
    expect(routeTemplate('/s/api/items/itm_0123456789abcdef/answer-photos/mdoc_0123456789abcdef')).toBe('/s/api/items/:itemId/answer-photos/:id');
    // 不像 ID 的段（前缀太长、位数不对、大写）原样保留。
    expect(routeTemplate('/s/materials/answers/import')).toBe('/s/materials/answers/import');
    expect(routeTemplate('/s/x/abcdefg_0123456789abcdef')).toBe('/s/x/abcdefg_0123456789abcdef');
    expect(routeTemplate('/s/x/ab_0123')).toBe('/s/x/ab_0123');
  });

  it('不像路由的路径（中文、空格、超长）一律记成 /s/*', () => {
    expect(routeTemplate('/s/我的名字')).toBe('/s/*');
    expect(routeTemplate('/s/a b')).toBe('/s/*');
    expect(routeTemplate(`/s/${'a'.repeat(80)}`)).toBe('/s/*');
    expect(routeTemplate('/v2/week')).toBe('/s/*');
  });
});

describe('互动记录：点按 cookie', () => {
  it('解析「短 ID.角色.按钮标识@页面路径」，最多 6 条，格式不对的丢掉', () => {
    const raw = [
      'ab12cd.primary.capture@/s/',
      'zz.secondary.skipShoot@/s/capture',
      'q1.content.today-step-pick@/s/',
      'e9.error.mic_denied@/s/why/pkt_0123456789abcdef/itm_0123456789abcdef',
      'bad.hacker.x@/s/',             // 角色不认
      'x1.primary.<script>@/s/',      // 标识里有不允许的字
      'x2.primary.ok@/elsewhere',     // 不在 /s 下
    ].join('|');
    expect(parseTapCookie(raw)).toEqual([
      { id: 'zz', role: 'secondary', key: 'skipShoot', route: '/s/capture' },
      { id: 'q1', role: 'content', key: 'today-step-pick', route: '/s/' },
      { id: 'e9', role: 'error', key: 'mic_denied', route: '/s/why/:pid/:itemId' },
    ]);
    expect(parseTapCookie(Array.from({ length: 9 }, (_, i) => `i${i}.top.back@/s/items`).join('|'))).toHaveLength(6);
  });
});

describe('ISO 周号的显示写法', () => {
  it('2026-W41 是 10/5（周一）到 10/11（周日）；跨年的周也对', () => {
    expect(isoWeekMonday('2026-W41')?.toISOString().slice(0, 10)).toBe('2026-10-05');
    expect(weekRangeText('2026-W41')).toBe('10/5–10/11');
    expect(weekRangeText('2026-W41', 'long')).toBe('10 月 5 日 – 10 月 11 日');
    expect(weekRangeText('2026-W01')).toBe('12/29–1/4');   // 2026 年第 1 周从 2025-12-29 开始
    expect(weekRangeText('2020-W53')).toBe('12/28–1/3');
    expect(weekRangeText('不是周号')).toBe('不是周号');
  });
});
