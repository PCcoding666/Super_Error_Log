import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { addDayText, monthDayText } from '../../src/domain/calendarDay.js';
import { PracticeDashboardPage } from '../../src/web/views/practiceDashboard.js';
import { RedoDateCard, RedoReminder } from '../../src/web/views/redoDate.js';

const html = (node: unknown): string => renderToStaticMarkup(node as ReactElement);

describe('P0-3「X 月 X 日再做」文案', () => {
  it('日历日运算跨月、跨年都对，中文日期不补零', () => {
    expect(addDayText('2026-10-30', 3)).toBe('2026-11-02');
    expect(addDayText('2026-12-30', 3)).toBe('2027-01-02');
    expect(monthDayText('2026-11-02')).toBe('11 月 2 日');
  });

  it('练完后的日期卡写明哪天、还有几天', () => {
    const out = html(RedoDateCard({ day: '2026-10-25', today: '2026-10-22' }));
    expect(out).toContain('下次再做：10 月 25 日（3 天后）');
    expect(out).toContain('今天先别再做这几道');
    expect(html(RedoDateCard({ day: null }))).toBe('');
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
