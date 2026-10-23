import type { ReactNode } from 'react';
import { dayOrdinal, localDayText, monthDayText } from '../../domain/calendarDay.js';

/** 「下次再做」与首页到期提示用到的总览（与 learning/queries 的 LearningRedoOverview 同形）。 */
export interface RedoOverviewView { dueCount: number; nextDay: string | null; nextCount: number }

function daysFromToday(day: string, today: string): number | null {
  const a = dayOrdinal(day), b = dayOrdinal(today);
  return a === null || b === null ? null : a - b;
}

/**
 * 练完后的日期卡。days 是这次练习里所有「再做」日期（升序）：
 * - 最早一天已到（例如晚几天才补录）：说今天就可以再做，不说「先别做」；
 * - 只有一个日期：「下次再做：10 月 25 日（3 天后）」；
 * - 日期不一：只说最早一天，并说明其余各有日期、没到日期的先别做。
 */
export function RedoDateCard(props: { days: readonly string[]; today?: string }): ReactNode {
  const days = [...props.days].sort();
  const first = days[0];
  if (!first) return null;
  const today = props.today ?? localDayText(new Date());
  const last = days[days.length - 1]!;
  const gap = daysFromToday(first, today);
  if (gap !== null && gap <= 0) {
    return (
      <section className="card" data-testid="redo-date" data-due="">
        <h2 className="card-title tone-green">今天就可以再做了</h2>
        <p className="small muted">{last > today ? `已经隔够天数的题，现在独立做对就算数；其余的要到 ${monthDayText(last)}前后，到期后「练习」会排给你，没到日期的先别做。` : '已经隔够天数了，现在独立做对就算数。'}</p>
        <a className="btn" href="/s/practices">去练习</a>
      </section>
    );
  }
  const when = gap !== null && gap > 0 ? `（${gap} 天后）` : '';
  const single = first === last;
  return (
    <section className="card" data-testid="redo-date">
      <h2 className="card-title">下次再做：{single ? '' : '最早 '}{monthDayText(first)}{when}</h2>
      <p className="small muted">{single
        ? '今天先别再做这几道。隔几天还能独立做对，才算真的会；到那天打开「练习」，会把它们排给你。'
        : `这几道各有日期，最晚的要到 ${monthDayText(last)}。每道到期后打开「练习」会排给你，没到日期的先别做。`}</p>
    </section>
  );
}

/** 当天做对（还不算掌握）那几道的说明：日期一致说日期；日期不一只说最早和最晚；已到期说现在就能做。 */
export function pendingRedoText(first: string | null, last: string | null, today: string = localDayText(new Date())): string {
  if (!first) return '隔 3 天再独立做对一次才算掌握。';
  const end = last ?? first;
  if (end <= today) return '已经隔够天数了，现在就可以再做，独立做对就算掌握。';
  if (first === end) return `${monthDayText(first)}以后再独立做对一次才算掌握。`;
  const start = first <= today ? '最早的一道今天就可以再做' : `最早 ${monthDayText(first)}起可以再做第一道`;
  return `${start}，最晚的要到 ${monthDayText(end)}；每道到期后练习页会排给你，没到日期的先别做。`;
}

/** 首页 / 练习页的到期提示：到了再做的日子才出现；还没到时只给一句日期。 */
export function RedoReminder(props: { overview: RedoOverviewView | null | undefined; compact?: boolean }): ReactNode {
  const overview = props.overview;
  if (!overview) return null;
  if (overview.dueCount > 0) {
    return (
      <section className="card" data-testid="redo-due">
        <h2 className="card-title tone-orange">今天有 {overview.dueCount} 道题该再做了</h2>
        <p className="small muted">之前做对过，已经隔了几天。这次再独立做对，就算掌握。</p>
        <a className="btn primary" href="/s/practices">去练习</a>
      </section>
    );
  }
  if (overview.nextDay && !props.compact) {
    return <p className="hint" data-testid="redo-next">下次再做：{monthDayText(overview.nextDay)}（{overview.nextCount} 道）。</p>;
  }
  return null;
}
