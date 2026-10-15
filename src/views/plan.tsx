import type { ReactNode } from 'react';
import type { Role } from '../domain/types.js';
import { PLAN_MAX, PLAN_MIN, selectWeeklyPlan } from '../domain/scheduling.js';
import { EmptyState, Layout } from './layout.js';
import type { Recommendation } from '../services/planService.js';

export function PlanPage(props: {
  role: Role;
  recommendations: Recommendation[];
  notes: string[];
  flash?: { ok?: string; err?: string };
}): ReactNode {
  const { recommendations } = props;
  const selection = selectWeeklyPlan(recommendations);
  const notes = [...props.notes, ...selection.notes];
  const defaultSelected = new Set(selection.selected);
  return (
    <Layout title="本周复习计划" role={props.role} flash={props.flash}>
      <h1>本周复习计划</h1>
      <p className="muted">
        系统按评分与知识点分布默认勾选 {selection.selected.length} 道（每周 {PLAN_MIN}–
        {PLAN_MAX} 道）。你可以增删，但建议保留高价值的题。
      </p>
      {notes.length > 0 ? (
        <div className="flash warn" role="status">
          {notes.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
      ) : null}

      {recommendations.length === 0 ? (
        <EmptyState
          title="暂无可安排的题目"
          hint="先完成错题的上传、校正与四项反思，再来生成本周复习包。"
          actionHref="/reflect"
          actionText="去反思"
        />
      ) : (
        <form method="post" action="/plan" className="form">
          <ul className="list">
            {recommendations.map((r) => (
              <li key={r.itemId} className={`card ${r.conflict ? 'conflict' : ''}`}>
                <label className="check row">
                  <input type="checkbox" name="item_ids" value={r.itemId} defaultChecked={defaultSelected.has(r.itemId)} />
                  <span>
                    <strong>{r.shortId}</strong> · {r.subject ?? '未知学科'} · {r.primaryTag ?? '知识点待定'} · 评分{' '}
                    <strong>{r.score}</strong>
                    {r.conflict ? <span className="badge conf-low">与复发证据冲突</span> : null}
                  </span>
                </label>
                <ul className="reasons">
                  {r.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <button className="btn primary" type="submit">
            确认计划并生成复习包
          </button>
        </form>
      )}
    </Layout>
  );
}
