import type { ReactNode } from 'react';
import type { V2WeekItem } from '../../v2/weekService.js';
import type { EvidenceView } from '../../v2/correctionService.js';
import { Page, Problem, quoted, type BarModel } from './layout.js';

/** 卡片只显示对他有意义的状态（§4.5）。 */
export function cardStatus(status: string): string | null {
  if (status === 'scheduled' || status === 'packet_generated') return '在这周的练习里';
  if (status === 'temporarily_mastered' || status === 'stably_mastered') return '真会了';
  if (status === 'needs_recheck') return '下次再练';
  return null;
}

export function ItemCard(props: { item: V2WeekItem; href?: string; extra?: ReactNode }): ReactNode {
  const { item } = props;
  const meta = [item.subject, ...item.knowledgeTags.slice(0, 2)].filter(Boolean).join(' · ');
  const status = cardStatus(item.status);
  const body = (
    <span className="row-text">
      <img className="crop" src={`/s/img/item/${item.id}`} alt={item.shortId ?? '题目裁图'} loading="lazy" />
      <span className="excerpt">{item.questionExcerpt ?? ''}</span>
      <span className="meta-line muted">{[meta, item.shortId ? `练习纸编号 ${item.shortId}` : ''].filter(Boolean).join(' · ')}</span>
      {item.badge === 'low' ? <span className="meta-line tone-orange">字可能认错了 · 点开看看</span> : null}
      {status ? <span className="meta-line tone-green">{status}</span> : null}
      {props.extra}
    </span>
  );
  return props.href
    ? <a className="row" href={props.href} data-testid="item-card">{body}<span className="chev" aria-hidden="true">›</span></a>
    : <div className="row" data-testid="item-card">{body}</div>;
}

export function ItemsPage(props: { items: V2WeekItem[]; backlog: V2WeekItem[]; anyPhoto: boolean; finding: boolean; bar: BarModel; removed?: string | null; flash?: { ok?: string | null; err?: string | null } }): ReactNode {
  const low = props.items.filter(item => item.badge === 'low').length;
  return (
    <Page title="这周的错题" tab="items" bar={props.bar} flash={props.flash}>
      <h1>这周的错题</h1>
      {props.removed ? (
        <div className="flash flash-row" role="status" data-testid="removed">
          <span>已移出这道题</span>
          <form method="post" action={`/s/items/${props.removed}/restore`} className="inline-form"><button className="link-btn" type="submit" data-key="item-restore">撤销</button></form>
        </div>
      ) : null}
      {props.items.length > 0 ? (
        <>
          <p className="lead muted">{props.items.length} 道{low > 0 ? ` · 其中 ${low} 道 AI 可能认错了字` : ''}</p>
          <section className="card"><ul className="list">{props.items.map(item => <li key={item.id}><ItemCard item={item} href={`/s/items/${item.id}`} /></li>)}</ul></section>
        </>
      ) : props.anyPhoto && props.finding ? (
        <section className="card"><p>AI 还在找题，找好了会出现在这里</p></section>
      ) : props.anyPhoto ? (
        <section className="card"><p>{quoted('这几张卷子里没找到做错的题。没批改的页可以去「勾出做错的题」自己勾。')}</p><a className="btn" href="/s/photos" data-key="empty-pick">去勾</a></section>
      ) : (
        <section className="card"><p>这周还没拍卷子</p><a className="btn" href="/s/capture" data-key="empty-capture">去拍</a></section>
      )}
      {props.backlog.length > 0 ? (
        <details>
          <summary data-key="items-backlog">以前没练完的（{props.backlog.length}）</summary>
          <section className="card"><ul className="list">{props.backlog.map(item => <li key={item.id}><ItemCard item={item} href={`/s/items/${item.id}`} /></li>)}</ul></section>
        </details>
      ) : null}
    </Page>
  );
}

const KIND_TITLE: Record<string, string> = { student_work: '你写的', correction: '订正', teacher_note: '老师批注', reference_answer: '参考答案', unknown: '其他笔迹' };

export function ItemDetailPage(props: { item: V2WeekItem; evidence: EvidenceView | null; canDiscard: boolean; reflected: boolean; error?: string | null }): ReactNode {
  const { item, evidence } = props;
  const bar: BarModel = {
    caption: '',
    primary: evidence ? { title: '字认错了？改一下', key: 'fix', href: `/s/items/${item.id}/fix` } : { title: '回到今天', key: 'goHome', href: '/s/' },
    secondary: props.canDiscard ? [{ title: '这不是错题', key: 'discard', post: `/s/items/${item.id}/discard` }] : [],
  };
  const groups = Object.entries(KIND_TITLE)
    .map(([kind, title]) => ({ title, notes: (evidence?.observations ?? []).filter(o => o.kind === kind) }))
    .filter(group => group.notes.length > 0);
  return (
    <Page title={item.shortId ?? '题目'} back={{ href: '/s/items', label: '这周的错题' }} bar={bar}>
      <p className="eyebrow">练习纸编号</p>
      <h1>{item.shortId ?? '题目'}</h1>
      {props.error ? <Problem title="没成功" detail={props.error} /> : null}
      <a href={`/s/img/item/${item.id}?scope=full`} target="_blank" rel="noreferrer" className="photo-link" data-key="item-full-photo"><img className="crop big" src={`/s/img/item/${item.id}?scope=full`} alt="整题照片" /></a>
      <p className="hint">整题照片 · 点开可以两指放大</p>
      {evidence?.badge === 'low' ? <p className="tone-orange" data-testid="low-hint">{quoted('字可能认错了：对照上面的照片看一眼，不对就点「改一下」。')}</p> : null}
      <section className="card">
        <h2 className="card-title">AI 认出的题目</h2>
        <p className="pre" data-testid="question-text">{evidence?.questionText ?? item.questionExcerpt ?? ''}</p>
        <p className="small muted">{[item.subject, ...item.knowledgeTags].filter(Boolean).join(' · ')}</p>
        {groups.map(group => (
          <div key={group.title}>
            <h2 className="card-title sub">{group.title}</h2>
            {group.notes.map(note => <p key={note.id} className="pre">{note.text}</p>)}
          </div>
        ))}
        <p className="small muted">{props.reflected ? '说过了' : '还没说为什么错'}</p>
      </section>
    </Page>
  );
}

export interface ProposalChange { field: string; before: string; after: string }

/** 改一下（§4.5）：说一句或写一句哪里不对 → 生成修改 → 改之前 / 改之后 → 就这样改。 */
export function FixPage(props: { item: V2WeekItem; revision: number; clientRequestId: string; instruction?: string; error?: string | null;
  proposal?: { proposalId: string; revision: number; changes: ProposalChange[]; clarify: string | null } | null }): ReactNode {
  const { item, proposal } = props;
  const bar: BarModel = proposal && proposal.changes.length > 0
    ? {
      caption: '看一眼改之后的样子',
      primary: { title: '就这样改', key: 'accept', post: `/s/items/${item.id}/fix/accept`, fields: { proposalId: proposal.proposalId, revision: String(proposal.revision) } },
      secondary: [{ title: '不改了', key: 'cancel', href: `/s/items/${item.id}` }],
    }
    : { caption: '', primary: { title: '生成修改', key: 'propose', form: 'fix-form' }, secondary: [{ title: '不改了', key: 'cancel', href: `/s/items/${item.id}` }] };
  const label: Record<string, string> = { questionText: '题目', observation: '笔迹', subject: '科目', knowledgeTags: '知识点' };
  return (
    <Page title="改一下" back={{ href: `/s/items/${item.id}`, label: '返回' }} bar={bar}>
      <h1>改一下</h1>
      {props.error ? <Problem title="没改成" detail={props.error} /> : null}
      {proposal ? (
        <section className="card" data-testid="proposal">
          {proposal.changes.length === 0 ? <p>这次没生成出可用的修改，换个说法再试，或者自己动手改。</p> : null}
          {proposal.changes.map((change, index) => (
            <div key={index} className="compare">
              <p className="small muted flush">{label[change.field] ?? change.field}</p>
              <div className="before"><span className="label">改之前</span><del>{change.before}</del></div>
              <div><span className="label">改之后</span>{change.after}</div>
            </div>
          ))}
          {proposal.clarify ? <p className="small muted">{proposal.clarify}</p> : null}
        </section>
      ) : null}
      <form method="post" action={`/s/items/${item.id}/fix`} id="fix-form" data-wait="正在生成修改…">
        <input type="hidden" name="revision" value={String(props.revision)} />
        <input type="hidden" name="clientRequestId" value={props.clientRequestId} />
        <input type="hidden" name="method" value="keyboard" />
        <label htmlFor="fix-instruction" className="field-label">哪里不对</label>
        <textarea id="fix-instruction" name="instruction" maxLength={200} required defaultValue={props.instruction ?? ''} placeholder="说一句或写一句哪里不对，比如：第二行的 16 应该是 13" />
        <div className="voice hidden" data-voice-for="fix-instruction" data-endpoint="/s/voice">
          <button type="button" data-key="voice">点一下开始说</button> <span className="small muted" data-voice-note="" />
          <span className="small muted">录音会发给通义千问转文字，本应用不保存录音；最多 60 秒，也可以直接打字</span>
        </div>
      </form>
      <a className="more" href={`/s/items/${item.id}/edit`} data-key="fix-manual">自己动手改<span aria-hidden="true">›</span></a>
    </Page>
  );
}

export function EditPage(props: { item: V2WeekItem; evidence: EvidenceView; error?: string | null }): ReactNode {
  const bar: BarModel = { caption: '只改题目的字；你写的错答案不要改对', primary: { title: '保存修改', key: 'save', form: 'edit-form' }, secondary: [{ title: '不改了', key: 'cancel', href: `/s/items/${props.item.id}` }] };
  return (
    <Page title="自己动手改" back={{ href: `/s/items/${props.item.id}`, label: '返回' }} bar={bar}>
      <h1>自己动手改</h1>
      {props.error ? <Problem title="没改成" detail={props.error} /> : null}
      <form method="post" action={`/s/items/${props.item.id}/edit`} id="edit-form">
        <input type="hidden" name="revision" value={String(props.evidence.revision)} />
        <label htmlFor="edit-text" className="field-label">AI 认出的题目</label>
        <textarea id="edit-text" name="questionText" defaultValue={props.evidence.questionText} maxLength={4000} />
      </form>
    </Page>
  );
}
