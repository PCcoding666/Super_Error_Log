import type { ReactNode } from 'react';
import { Layout } from './layout.js';
import type { ParentAggregate } from '../services/trendService.js';

/** 家长聚合视图：只有聚合数字与知识点名称，无题目原文、无反思、无图片 */
export function ParentPage(props: { data: ParentAggregate }): ReactNode {
  const d = props.data;
  return (
    <Layout title="家长视图" role="parent">
      <h1>家长视图（仅汇总）</h1>
      <p className="muted">
        这里只展示趋势与汇总数字。孩子的错题原文、图片和私人反思不会出现在这里——那些是孩子自己的学习空间。
      </p>

      <section className="card">
        <h2>每周任务完成情况</h2>
        {d.weeklyCompletion.length === 0 ? (
          <p className="muted">暂无复习包记录。</p>
        ) : (
          <ul className="list">
            {d.weeklyCompletion.map((w) => (
              <li key={w.week} className="row">
                <span>{w.week}</span>
                <span>
                  完成 {w.attempted}/{w.total}（{w.total === 0 ? 0 : Math.round((w.attempted / w.total) * 100)}%）
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>各学科掌握趋势</h2>
        {d.subjectMastery.length === 0 ? (
          <p className="muted">暂无数据。</p>
        ) : (
          <ul className="list">
            {d.subjectMastery.map((s) => (
              <li key={s.subject} className="row">
                <span>{s.subject}</span>
                <span>
                  已掌握 {s.mastered}/{s.total}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>需要关注的知识点（Top 5）</h2>
        {d.topWeakTags.length === 0 ? (
          <p className="muted">暂无数据。</p>
        ) : (
          <ul className="list">
            {d.topWeakTags.map((t) => (
              <li key={t.tag} className="row">
                <span>{t.tag}</span>
                <span>{t.count} 次</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Layout>
  );
}
