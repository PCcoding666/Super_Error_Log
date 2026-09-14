import type { ReactNode } from 'react';
import type { Role } from '../domain/types.js';
import { STATUS_LABEL } from '../domain/types.js';
import { ConfidenceBadge, EmptyState, Layout, StatusBadge } from './layout.js';
import type { ItemRow } from '../services/itemService.js';
import { getEvidence } from '../services/evidenceService.js';

export function ItemsPage(props: { role: Role; items: ItemRow[]; statusFilter?: string }): ReactNode {
  return (
    <Layout title="错题" role={props.role}>
      <h1>错题列表</h1>
      <form method="get" action="/items" className="filterbar">
        <label htmlFor="status">状态</label>
        <select id="status" name="status" defaultValue={props.statusFilter ?? ''}>
          <option value="">全部</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <button className="btn" type="submit">
          筛选
        </button>
      </form>
      {props.items.length === 0 ? (
        <EmptyState title="暂无错题" hint="从首页上传本周错题开始。" actionHref="/" actionText="去上传" />
      ) : (
        <ul className="list">
          {props.items.map((i) => (
            <li key={i.id} className="card row">
              <div>
                <strong>{i.short_id ?? '未编号'}</strong> <StatusBadge status={i.status} />
                <div className="muted">
                  {i.subject ?? '未知学科'} · {(JSON.parse(i.knowledge_tags) as string[]).join('、') || '知识点待定'} ·{' '}
                  {i.question_type ?? '题型待定'}
                </div>
                {i.next_review_at ? <div className="muted">下次确认：{i.next_review_at}</div> : null}
              </div>
              <a className="btn" href={`/items/${i.id}`}>
                详情
              </a>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}

export function ItemDetailPage(props: {
  role: Role;
  item: ItemRow;
  diagnosis: { attempt_state: string; cause: string; mastery_feeling: number; review_value: string } | null;
  flash?: { ok?: string; err?: string };
}): ReactNode {
  const { item, diagnosis } = props;
  const suggestion = item.ai_suggestion ? (JSON.parse(item.ai_suggestion) as { fieldConfidence?: Record<string, number> }) : null;
  return (
    <Layout title={`错题 ${item.short_id ?? ''}`} role={props.role} flash={props.flash}>
      <h1>
        错题 {item.short_id ?? ''} <StatusBadge status={item.status} />
      </h1>
      {getEvidence(item.id) ? <p><a className="btn primary" href={`/items/${item.id}/evidence`}>校对题目、图示、作答与 AI 诊断</a></p> : null}

      <section className="card">
        <h2>题目图片</h2>
        <p>
          <a href={`/media/asset/${item.asset_id}`} target="_blank" rel="noreferrer">
            查看原图（新窗口）
          </a>
        </p>
        <img className="item-img" src={`/media/asset/${item.asset_id}`} alt={`错题 ${item.short_id} 原图`} />
        <ul className="muted">
          <li>原题图：{item.has_question_img ? '有' : '无'}</li>
          <li>你的解题过程：{item.has_work_img ? '有' : '无'}</li>
          <li>教师批注：{item.has_teacher_note ? '有' : '无'}</li>
          <li>标准答案：{item.has_answer_img ? '有' : '无'}</li>
        </ul>
      </section>

      <section className="card">
        <h2>识别字段</h2>
        <ConfidenceBadge confidence={item.confidence} />
        <dl className="fields">
          <dt>学科</dt>
          <dd>{item.subject ?? '待定'}</dd>
          <dt>章节</dt>
          <dd>{item.chapter ?? '待定'}</dd>
          <dt>知识点</dt>
          <dd>{(JSON.parse(item.knowledge_tags) as string[]).join('、') || '待定'}</dd>
          <dt>题型</dt>
          <dd>{item.question_type ?? '待定'}</dd>
        </dl>
        {suggestion?.fieldConfidence ? (
          <p className="muted">
            AI 字段置信度：{Object.entries(suggestion.fieldConfidence).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join('；')}
            。以上为 AI 建议，可在校正页修改。
          </p>
        ) : null}
        {item.text_excerpt ? <blockquote>{item.text_excerpt}</blockquote> : null}
      </section>

      <section className="card">
        <h2>我的反思</h2>
        {diagnosis ? (
          <dl className="fields">
            <dt>做题状态</dt>
            <dd>{diagnosis.attempt_state}</dd>
            <dt>主要错因</dt>
            <dd>{diagnosis.cause}</dd>
            <dt>当前掌握感</dt>
            <dd>{diagnosis.mastery_feeling} 分</dd>
            <dt>复习价值</dt>
            <dd>{diagnosis.review_value}</dd>
          </dl>
        ) : (
          <p className="muted">还没有完成反思。<a href="/reflect">去反思</a></p>
        )}
      </section>

      {['eligible_for_review', 'attempted', 'ready_for_reflection'].includes(item.status) ? (
        <form
          method="post"
          action={`/items/${item.id}/archive`}
          data-confirm="确认归档？只有你认为没必要再做、且没有复发证据的题才建议归档。"
        >
          <button className="btn warn" type="submit">
            归档（不值得长期保留）
          </button>
        </form>
      ) : null}
    </Layout>
  );
}
