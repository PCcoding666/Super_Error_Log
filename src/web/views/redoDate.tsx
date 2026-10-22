import type { ReactNode } from 'react';
import { dayOrdinal, localDayText, monthDayText } from '../../domain/calendarDay.js';

/** 「下次再做」与首页到期提示用到的总览（与 learning/queries 的 LearningRedoOverview 同形）。 */
export interface RedoOverviewView { dueCount: number; nextDay: string | null; nextCount: number }

function daysFromToday(day: string, today: string): number | null {
  const a = dayOrdinal(day), b = dayOrdinal(today);
  return a === null || b === null ? null : a - b;
}

/** 练完后的日期卡：「下次再做：10 月 25 日（3 天后）」。 */
export function RedoDateCard(props: { day: string | null; today?: string }): ReactNode {
  if (!props.day) return null;
  const today = props.today ?? localDayText(new Date());
  const gap = daysFromToday(props.day, today);
  const when = gap !== null && gap > 0 ? `（${gap} 天后）` : '';
  return (
    <section className="card" data-testid="redo-date">
      <h2 className="card-title">下次再做：{monthDayText(props.day)}{when}</h2>
      <p className="small muted">今天先别再做这几道。隔几天还能独立做对，才算真的会；到那天打开「练习」，会把它们排给你。</p>
    </section>
  );
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
