import type { ReactNode } from 'react';
import type { Role } from '../domain/types.js';
import { ConfidenceBadge, EmptyState, Layout, StatusBadge } from './layout.js';
import type { ItemRow } from '../services/itemService.js';

export interface BatchRow {
  id: string;
  status: string;
  total_files: number;
  done_files: number;
  failed_files: number;
  created_at: string;
}

const BATCH_STATUS_LABEL: Record<string, string> = {
  processing: '处理中',
  needs_attention: '待校正',
  partial: '部分成功',
  done: '已完成',
  failed: '失败',
};

export function BatchesPage(props: { role: Role; batches: BatchRow[] }): ReactNode {
  return (
    <Layout title="批次" role={props.role}>
      <h1>上传批次</h1>
      {props.batches.length === 0 ? (
        <EmptyState title="还没有上传记录" hint="周末把一周的错题照片或 PDF 一次性上传。" actionHref="/" actionText="去上传" />
      ) : (
        <ul className="list">
          {props.batches.map((b) => (
            <li key={b.id} className="card row">
              <div>
                <strong>批次 {b.id.slice(-6)}</strong>{' '}
                <span className={`badge batch-${b.status}`}>{BATCH_STATUS_LABEL[b.status] ?? b.status}</span>
                <div className="muted">
                  {new Date(b.created_at).toLocaleString('zh-CN')} · {b.total_files} 个文件 · 完成 {b.done_files} · 失败{' '}
                  {b.failed_files}
                </div>
              </div>
              <a className="btn" href={`/batches/${b.id}`}>
                查看
              </a>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}

export interface AssetRow {
  id: string;
  filename: string;
  status: string;
  error: string | null;
  size: number;
}

const ASSET_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  processing: '识别中',
  done: '完成',
  failed: '识别失败',
  duplicate: '重复文件（已跳过）',
  unsupported: '不支持的格式',
  too_large: '超过大小限制',
  empty: '空文件',
};

export function BatchDetailPage(props: {
  role: Role;
  batch: BatchRow;
  assets: AssetRow[];
  items: ItemRow[];
  flash?: { ok?: string; err?: string };
}): ReactNode {
  const { batch, assets, items } = props;
  const reviewItems = items.filter((i) => i.status === 'needs_review');
  const pct = batch.total_files === 0 ? 0 : Math.round(((batch.done_files + batch.failed_files) / batch.total_files) * 100);
  return (
    <Layout title="批次详情" role={props.role} flash={props.flash}>
      <h1>
        批次 {batch.id.slice(-6)}{' '}
        <span className={`badge batch-${batch.status}`}>{BATCH_STATUS_LABEL[batch.status] ?? batch.status}</span>
      </h1>
      <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="progress-bar" style={{ width: `${pct}%` }} />
      </div>
      <p className="muted">
        {batch.done_files + batch.failed_files}/{batch.total_files} 个文件已处理
      </p>

      {batch.failed_files > 0 ? (
        <form method="post" action={`/batches/${batch.id}/retry`}>
          <button className="btn warn" type="submit">
            重试 {batch.failed_files} 个失败文件
          </button>
        </form>
      ) : null}

      {reviewItems.length > 0 ? (
        <p>
          <a className="btn primary" href={`/batches/${batch.id}/review`}>
            校正 {reviewItems.length} 道低置信度题目
          </a>
        </p>
      ) : null}

      <h2>文件</h2>
      <ul className="list">
        {assets.map((a) => (
          <li key={a.id} className="card row">
            <div>
              <strong>{a.filename}</strong> <span className="badge">{ASSET_STATUS_LABEL[a.status] ?? a.status}</span>
              {a.error ? <div className="muted">{a.error}</div> : null}
            </div>
            <span className="muted">{(a.size / 1024).toFixed(0)} KB</span>
          </li>
        ))}
      </ul>

      <h2>识别出的题目（{items.length}）</h2>
      {items.length === 0 ? (
        <p className="muted">尚无题目。处理完成或重试后会出现。</p>
      ) : (
        <ul className="list">
          {items.map((i) => (
            <li key={i.id} className="card row">
              <div>
                <strong>{i.short_id ?? '未编号'}</strong> <StatusBadge status={i.status} />{' '}
                <ConfidenceBadge confidence={i.confidence} />
                <div className="muted">
                  {i.subject ?? '学科未知'} · {(JSON.parse(i.knowledge_tags) as string[]).join('、') || '知识点未知'}
                </div>
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

export function BatchReviewPage(props: { role: Role; batchId: string; items: ItemRow[] }): ReactNode {
  const item = props.items[0];
  return (
    <Layout title="校正低置信度题目" role={props.role}>
      <h1>校正低置信度题目</h1>
      <p className="muted">
        AI 对这些题目不够确定，请你核对。剩余 {props.items.length} 道。AI 的建议仅供参考，可以直接修改。
      </p>
      {!item ? (
        <EmptyState
          title="本批次没有需要校正的题目"
          hint="全部识别置信度达标，可以去完成反思了。"
          actionHref="/reflect"
          actionText="去反思"
        />
      ) : (
        <form method="post" action={`/items/${item.id}/correct`} className="card form">
          <div className="row">
            <strong>{item.short_id ?? '未编号'}</strong> <ConfidenceBadge confidence={item.confidence} />
          </div>
          {item.text_excerpt ? <blockquote>{item.text_excerpt}</blockquote> : null}
          <p>
            <a href={`/media/asset/${item.asset_id}`} target="_blank" rel="noreferrer">
              查看原图
            </a>
          </p>
          <label htmlFor="subject">学科</label>
          <select id="subject" name="subject" defaultValue={item.subject ?? '数学'}>
            <option>数学</option>
            <option>物理</option>
            <option>化学</option>
          </select>
          <label htmlFor="chapter">章节</label>
          <input id="chapter" name="chapter" defaultValue={item.chapter ?? ''} />
          <label htmlFor="knowledge_tags">知识点（用逗号分隔）</label>
          <input
            id="knowledge_tags"
            name="knowledge_tags"
            defaultValue={(JSON.parse(item.knowledge_tags) as string[]).join('，')}
          />
          <label htmlFor="question_type">题型</label>
          <input id="question_type" name="question_type" defaultValue={item.question_type ?? ''} />
          <label className="check">
            <input type="checkbox" name="is_key_gap" value="1" defaultChecked={item.is_key_gap === 1} />
            这道题涉及关键方法或前置知识缺口
          </label>
          <button className="btn primary" type="submit">
            保存并继续下一题
          </button>
        </form>
      )}
    </Layout>
  );
}
