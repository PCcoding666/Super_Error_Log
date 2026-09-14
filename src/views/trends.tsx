import type { ReactNode } from 'react';
import type { Role } from '../domain/types.js';
import { STATUS_LABEL, type ItemStatus } from '../domain/types.js';
import { Layout } from './layout.js';
import type { RecurrenceAlert, WeakTag } from '../services/trendService.js';

export function TrendsPage(props: {
  role: Role;
  weakTags: WeakTag[];
  alerts: RecurrenceAlert[];
  mastery: Array<{ status: string; n: number }>;
}): ReactNode {
  return (
    <Layout title="趋势" role={props.role}>
      <h1>趋势</h1>

      <section className="card">
        <h2>错误模式复发提醒</h2>
        {props.alerts.length === 0 ? (
          <p className="muted">暂无复发信号（同一知识点或错因出现 2 次以上会在这里提示）。</p>
        ) : (
          <ul className="list">
            {props.alerts.map((a) => (
              <li key={`${a.kind}-${a.name}`} className="row">
                <span className="badge conf-low">{a.kind === 'tag' ? '知识点' : '错因'}复发</span>
                <span>
                  「{a.name}」已出现 <strong>{a.count}</strong> 次 —— 单题掌握不代表这个模式已消失
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>薄弱知识点</h2>
        {props.weakTags.length === 0 ? (
          <p className="muted">暂无数据。</p>
        ) : (
          <ul className="list">
            {props.weakTags.map((t) => (
              <li key={t.tag} className="row">
                <strong>{t.tag}</strong>
                <span className="muted">
                  {t.subject ?? ''} · {t.count} 题{t.causes.length > 0 ? ` · 常见错因：${t.causes.join('、')}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>掌握状态分布</h2>
        <ul className="list">
          {props.mastery.map((m) => (
            <li key={m.status} className="row">
              <span>{STATUS_LABEL[m.status as ItemStatus] ?? m.status}</span>
              <strong>{m.n}</strong>
            </li>
          ))}
        </ul>
      </section>
    </Layout>
  );
}
