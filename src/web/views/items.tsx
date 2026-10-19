import { GRADES } from '../../classification/itemCategories.js';
import { JUNIOR_CATALOG } from '../../classification/juniorCatalog.js';
import type { ReactNode } from 'react';
import type { V2WeekItem } from '../../v2/weekService.js';
import type { EvidenceView } from '../../v2/correctionService.js';
export { ItemDetailPage } from './itemDetail.js';
import { Page, Phrased, Problem, VoiceBox, type BarModel } from './layout.js';

/** 卡片只显示对他有意义的状态（§4.5）。 */
export function cardStatus(status: string): string | null {
  if (status === 'scheduled' || status === 'packet_generated') return '已加入练习';
  if (status === 'temporarily_mastered' || status === 'stably_mastered') return '已多次做对';
  if (status === 'needs_recheck') return '下次再练';
  return null;
}

export function ItemCard(props: { item: V2WeekItem; href?: string; extra?: ReactNode }): ReactNode {
  const { item } = props;
  const meta = [item.grade, item.subject, item.chapter].filter(Boolean).join(' · ');
  const status = cardStatus(item.status);
  const body = (
    <span className="row-text">
      <img className="crop" src={`/s/img/item/${item.id}?s=list`} alt={item.shortId ?? '题目裁图'} loading="lazy" />
      <span className="excerpt">{item.questionExcerpt ?? ''}</span>
      <span className="meta-line muted">{[meta, item.shortId ? `练习纸编号 ${item.shortId}` : ''].filter(Boolean).join(' · ')}</span>
      {item.badge === 'low' ? <span className="meta-line tone-orange">字可能认错了 · 点开看看</span> : null}
      {status ? <span className="meta-line tone-green">{status}</span> : null}
      {props.extra}
    </span>
  );
  return props.href
    ? <a id={`item-${item.id}`} className="row" href={props.href} data-testid="item-card">{body}<span className="chev" aria-hidden="true">›</span></a>
    : <div className="row" data-testid="item-card">{body}</div>;
}

export function ItemsPage(props: { items: V2WeekItem[]; backlog: V2WeekItem[]; anyPhoto: boolean; finding: boolean; bar: BarModel; category: { grade: string; subject: string; subjects: string[] }; removed?: string | null; flash?: { ok?: string | null; err?: string | null } }): ReactNode {
    const { grade, subject, subjects } = props.category;
    const all = [...props.items, ...props.backlog];
    const chapters = [...new Set(all.map(item => item.chapter ?? '未分类'))];
    const subjectSwitch = <details className="subject-switch">
      <summary aria-label={`切换学科，当前${subject}`} data-testid="subject-switch"><span>{subject}</span><svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg></summary>
      <nav className="subject-options" aria-label="选择学科">{subjects.map(name => <a key={name} href={`/s/items?${new URLSearchParams({grade, subject:name})}`} aria-current={name === subject ? 'page' : undefined}><span>{name}</span>{name === subject ? <span aria-hidden="true">✓</span> : null}</a>)}</nav>
    </details>;
    return <Page title="错题本" tab="items" bar={props.bar} flash={props.flash} topLeading={subjectSwitch}>
      <h1>错题本</h1>
      <form method="get" action="/s/items" className="category-filter">
        <label htmlFor="library-grade">年级</label>
        <select id="library-grade" name="grade" defaultValue={grade}>{GRADES.map(value => <option key={value}>{value}</option>)}</select>
        <input type="hidden" name="subject" value={subject} />
        <button className="link-btn" type="submit">查看</button>
      </form>
      {props.removed ? <div className="flash flash-row" role="status" data-testid="removed"><span>已移出这道题</span><form method="post" action={`/s/items/${props.removed}/restore`}><button className="link-btn" type="submit">撤销</button></form></div> : null}
      <p className="lead muted">{grade} · {subject} · {all.length} 道</p>
      {all.length ? <form method="post" action="/s/items/select" id="chapter-form">
        <input type="hidden" name="grade" value={grade} /><input type="hidden" name="subject" value={subject} />
        <p className="hint">勾选章节，选中其中的全部错题；可以同时选多个章节，包含以前收录的题。</p>
        {chapters.map(chapter => {
          const items = all.filter(item => (item.chapter ?? '未分类') === chapter);
          return <section key={chapter} className="card chapter-group">
            <label className="choice"><input type="checkbox" name="chapters" value={chapter} /><span>{chapter} <span className="muted">（{items.length} 道）</span></span></label>
            <details><summary>查看这 {items.length} 道题</summary><ul className="list">{items.map(item => <li key={item.id}><ItemCard item={item} href={`/s/items/${item.id}`} /></li>)}</ul></details>
          </section>;
        })}
        <button className="btn" type="submit">查看已选题目</button>
        <p className="hint">下一步可逐题调整，再加入练习；每次练习最多 8 道。</p>
      </form> : <section className="card"><p>这个年级还没有{subject}错题</p>{props.finding ? <p>AI 还在找题，稍后可以再来看看</p> : null}<a className="btn" href={props.anyPhoto ? '/s/photos' : '/s/capture'}>{props.anyPhoto ? '去勾' : '录入第一道错题'}</a></section>}
    </Page>;
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
        <VoiceBox target="fix-instruction" />
      </form>
      <a className="more" href={`/s/items/${item.id}/edit`} data-key="fix-manual"><Phrased text="自己动手改" suffix={<span className="chev-i" aria-hidden="true">›</span>} /></a>
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

/** Direct classification edits never assert that the student has checked the question text. */
export function CategoryEditPage(props: { item: V2WeekItem; error?: string; values?: {grade:string;subject:string;chapter:string} }): ReactNode {
  const values = props.values ?? {grade:props.item.grade ?? '初三',subject:props.item.subject ?? '',chapter:props.item.chapter ?? ''};
  return <Page title="修改分类" back={{href:`/s/items/${props.item.id}`,label:'返回题目'}} bar={{caption:'只修改这道题的分类', primary:{title:'保存分类',key:'save-category',form:'category-form'},secondary:[]}}>
    <h1>修改分类</h1>
    {props.error ? <Problem title="分类未保存" detail={props.error} /> : null}
    <form id="category-form" method="post" action={`/s/items/${props.item.id}/category`}>
      <label className="field-label" htmlFor="category-grade">年级</label>
      <select id="category-grade" name="grade" defaultValue={values.grade}>{GRADES.map(grade => <option key={grade}>{grade}</option>)}</select>
      <label className="field-label" htmlFor="category-subject">学科</label>
      <input type="text" id="category-subject" name="subject" list="category-subjects" defaultValue={values.subject} required maxLength={100} />
      <datalist id="category-subjects">{JUNIOR_CATALOG.map(subject => <option key={subject.key} value={subject.name} />)}</datalist>
      <label className="field-label" htmlFor="category-chapter">章节或知识主题</label>
      <input type="text" id="category-chapter" name="chapter" defaultValue={values.chapter} required maxLength={100} placeholder="例如：一元二次方程" />
      <p className="hint">填写章节即可；“根的判别式”等细知识点保留在题目详情中。</p>
    </form>
  </Page>;
}
