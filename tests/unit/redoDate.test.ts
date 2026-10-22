import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { addDayText, monthDayText } from '../../src/domain/calendarDay.js';
import { PracticeDashboardPage } from '../../src/web/views/practiceDashboard.js';
import { pendingRedoText, RedoDateCard, RedoReminder } from '../../src/web/views/redoDate.js';

const html = (node: unknown): string => renderToStaticMarkup(node as ReactElement);

describe('P0-3「X 月 X 日再做」文案', () => {
  it('日历日运算跨月、跨年都对，中文日期不补零', () => {
    expect(addDayText('2026-10-30', 3)).toBe('2026-11-02');
    expect(addDayText('2026-12-30', 3)).toBe('2027-01-02');
    expect(monthDayText('2026-11-02')).toBe('11 月 2 日');
  });

  it('练完后的日期卡写明哪天、还有几天', () => {
    const out = html(RedoDateCard({ days: ['2026-10-25'], today: '2026-10-22' }));
    expect(out).toContain('下次再做：10 月 25 日（3 天后）');
    expect(out).toContain('今天先别再做这几道');
    expect(html(RedoDateCard({ days: [] }))).toBe('');
  });

  it('日期不一时只说最早一天是「最早」，不暗示所有题都能在那天做', () => {
    const out = html(RedoDateCard({ days: ['2026-11-01', '2026-10-25'], today: '2026-10-22' }));
    expect(out).toContain('下次再做：最早 10 月 25 日（3 天后）');
    expect(out).toContain('最晚的要到 11 月 1 日');
    expect(out).toContain('没到日期的先别做');
    expect(out).not.toContain('今天先别再做这几道');
  });

  it('最早日期已到（例如晚几天才补录）时说今天就可以再做，而不是「先别做」', () => {
    const due = html(RedoDateCard({ days: ['2026-10-20'], today: '2026-10-22' }));
    expect(due).toContain('今天就可以再做了');
    expect(due).not.toContain('先别');
    const today = html(RedoDateCard({ days: ['2026-10-22', '2026-11-01'], today: '2026-10-22' }));
    expect(today).toContain('今天就可以再做了');
    expect(today).toContain('其余的要到 11 月 1 日前后');
  });

  it('当天做对那几道的说明区分同一天 / 不同日期 / 已到期', () => {
    expect(pendingRedoText('2026-10-25', '2026-10-25', '2026-10-22')).toBe('10 月 25 日以后再独立做对一次才算掌握。');
    expect(pendingRedoText('2026-10-25', '2026-10-28', '2026-10-22')).toBe('最早 10 月 25 日起可以再做第一道，最晚的要到 10 月 28 日；每道到期后练习页会排给你，没到日期的先别做。');
    expect(pendingRedoText('2026-10-20', '2026-10-28', '2026-10-22')).toContain('最早的一道今天就可以再做');
    expect(pendingRedoText('2026-10-20', '2026-10-21', '2026-10-22')).toBe('已经隔够天数了，现在就可以再做，独立做对就算掌握。');
    expect(pendingRedoText(null, null, '2026-10-22')).toBe('隔 3 天再独立做对一次才算掌握。');
  });

  it('首页只在到期当天及以后提示；没到期时 compact 不打扰', () => {
    expect(html(RedoReminder({ overview: { dueCount: 2, nextDay: null, nextCount: 0 }, compact: true }))).toContain('今天有 2 道题该再做了');
    expect(html(RedoReminder({ overview: { dueCount: 0, nextDay: '2026-10-25', nextCount: 3 }, compact: true }))).toBe('');
    expect(html(RedoReminder({ overview: { dueCount: 0, nextDay: '2026-10-25', nextCount: 3 } }))).toContain('下次再做：10 月 25 日（3 道）');
  });

  it('练习页没有可练的题但有冷却中的题时，告诉学生哪天再来，而不是「没有需要新增的练习」', () => {
    const out = html(PracticeDashboardPage({ tasks: [], activeId: null, requestKey: 'k', recommendation: { recommended: [], redo: { dueCount: 0, nextDay: '2026-10-25', nextCount: 3 } } }));
    expect(out).toContain('10 月 25 日再来做');
    expect(out).toContain('有 3 道之前做对过的题');
    expect(out).not.toContain('现在没有需要新增的练习');
    const none = html(PracticeDashboardPage({ tasks: [], activeId: null, requestKey: 'k', recommendation: { recommended: [], redo: { dueCount: 0, nextDay: null, nextCount: 0 } } }));
    expect(none).toContain('现在没有需要新增的练习');
  });
});
