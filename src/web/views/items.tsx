import { itemContextUrl, itemNotebookReturn } from '../itemLearning.js';
import { NOTEBOOK_STATUSES, notebookUrl, type NotebookFilters } from '../notebook.js';
import { stageChoices } from '../../classification/itemCategories.js';
import { ALL_STAGES } from '../../classification/stages.js';
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

export function ItemCard(props: { item: V2WeekItem; href?: string; open?: boolean; extra?: ReactNode }): ReactNode {
  const { item } = props;
  const meta = [item.grade, item.subject || '未分类', item.chapter || '未分类'].filter(Boolean).join(' · ');
  const body = <span className="row-text">
    <span className="notebook-card-heading">{item.shortId ?? '题目'}{props.href || props.open ? <span className="notebook-open">查看题目 ›</span> : null}</span>
    <img className="crop big notebook-crop" src={`/s/img/item/${item.id}?scope=full&s=big`} alt={`${item.shortId ?? '题目'} · 整题照片`} loading="lazy" />
    <span className="excerpt">{item.questionExcerpt || '题目文字暂不可用，可查看原图。'}</span>
    <span className="meta-line muted">{[meta,item.shortId ? `练习纸编号 ${item.shortId}` : null].filter(Boolean).join(' · ')}</span>
    <span className="meta-line muted">{NOTEBOOK_STATUSES[item.status] ?? '待练习'}</span>
    {props.extra}
  </span>;
  if (props.open) return <button type="submit" name="openItem" value={item.id} form="notebook-selection" id={`item-${item.id}`} className="row notebook-card" data-testid="item-card" aria-label={`查看题目 ${item.shortId ?? '这道题'}`}>{body}</button>;
  return props.href
    ? <a id={`item-${item.id}`} className="row notebook-card" href={props.href} data-testid="item-card">{body}</a>
    : <div id={`item-${item.id}`} className="row notebook-card" data-testid="item-card">{body}</div>;
}

export interface NotebookPageProps {
  items: V2WeekItem[]; backlog: V2WeekItem[]; anyPhoto: boolean; finding: boolean; bar: BarModel;
  category: { grade: string; subject: string; subjects: string[]; stages?: string[] };
  filters?: NotebookFilters; chapters?: string[]; total?: number; selection?: boolean; selectedIds?: string[];
  eligibleIds?: string[]; recoveryItems?: V2WeekItem[]; removed?: string | null; undoReturnTo?: string;
  flash?: { ok?: string | null; err?: string | null };
}
export function ItemsPage(props: NotebookPageProps): ReactNode {
  const { grade, subject, subjects } = props.category;
  const filters = props.filters ?? {grade,subject,chapter:'',status:'',q:''};
  const all = [...props.items, ...props.backlog];
  const selected = new Set(props.selectedIds ?? []);
  const eligible = new Set(props.eligibleIds ?? []);
  const context = notebookUrl(filters);
  const selectionUrl = notebookUrl(filters,undefined,[]);
  const subjectSwitch = <details className="subject-switch">
    <summary aria-label={`切换学科，当前${subject}`} data-testid="subject-switch"><span>{subject}</span><svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg></summary>
    <nav className="subject-options" aria-label="选择学科">{subjects.map(name => <a key={name} href={notebookUrl({grade,subject:name})} aria-current={name === subject ? 'page' : undefined}><span>{name}</span>{name === subject ? <span aria-hidden="true">✓</span> : null}</a>)}</nav>
  </details>;
  const card = (item: V2WeekItem) => <li key={item.id} className="notebook-entry">
    {props.selection ? <label className="choice notebook-choice"><input type="checkbox" name="itemIds" value={item.id} defaultChecked={selected.has(item.id)} disabled={!eligible.has(item.id) && !selected.has(item.id)} /><span>选择 {item.shortId ?? '这道题'}{!eligible.has(item.id) ? <span className="meta-line muted">{selected.has(item.id) ? '当前不可加入，请取消选择后继续' : '已在练习中或暂不可练习'}</span> : null}</span></label> : null}
    <ItemCard item={item} open={props.selection} href={props.selection ? undefined : `/s/items/${item.id}?${new URLSearchParams({returnTo:notebookUrl(filters,item.id)})}`} />
    <a className="notebook-original" href={`/s/img/item/${item.id}?scope=full`} target="_blank" rel="noreferrer">查看原图<span className="visually-hidden"> {item.shortId ?? '这道题'}（新窗口）</span></a>
  </li>;
  const recovery = props.recoveryItems ?? [];
  const known = new Set([...all,...recovery].map(item=>item.id));
  const selectionBar: BarModel = {caption:`已选 ${selected.size} 道 / 最多 8 道`,captionStatusId:'notebook-selection-count',primary:{title:'加入练习',key:'notebook-create',form:'notebook-selection',describedBy:'notebook-selection-count notebook-selection-hint'},secondary:[]};
  return <Page title="错题本" tab={props.selection ? undefined : 'items'} back={null} bodyClass={`notebook-page${props.selection ? ' notebook-selection-page' : ''}`} bar={props.selection ? selectionBar : props.bar} flash={props.flash} topLeading={subjectSwitch}
    barExtra={props.selection ? <p className="hint notebook-bar-hint" data-notebook-limit="" id="notebook-selection-hint">{selected.size > 8 ? '超过 8 道了，请取消几道后继续。' : selected.size === 0 ? '至少选 1 道题' : '可逐题取消'}</p> : undefined}>
    <div className="notebook-title"><h1>错题本</h1>{props.selection ? <a className="link-btn" href={context}>取消选题</a> : <a className="link-btn" href={selectionUrl}>选题练习</a>}</div>
    {props.selection ? <p className="hint">选 1–8 道题加入练习。更改筛选或学科会结束本次选题；已建练习不受影响。</p> : null}
    <form method="get" action="/s/items" className="notebook-filters" role="search" aria-label="搜索错题">
      <input type="hidden" name="subject" value={subject} />
      <div className="notebook-search"><label className="visually-hidden" htmlFor="library-search">搜索题目</label><input id="library-search" name="q" type="search" maxLength={200} defaultValue={filters.q} placeholder="题干、编号、章节或知识点" /><button className="link-btn" type="submit">查看</button></div>
      <details className="notebook-filter-details" data-testid="notebook-filters">
        <summary>筛选 · {grade} · {filters.chapter || '全部章节'} · {filters.status ? NOTEBOOK_STATUSES[filters.status] : '全部状态'}</summary>
        <div className="notebook-filter-row">
          <div><label htmlFor="library-grade">学段</label><select id="library-grade" name="grade" defaultValue={grade}>{(props.category.stages ?? [grade]).map(value=><option key={value}>{value}</option>)}</select></div>
          <div><label htmlFor="library-chapter">章节</label><select id="library-chapter" name="chapter" defaultValue={filters.chapter}><option value="">全部章节</option>{(props.chapters ?? []).map(value=><option key={value}>{value}</option>)}</select></div>
          <div><label htmlFor="library-status">学习状态</label><select id="library-status" name="status" defaultValue={filters.status}><option value="">全部状态</option>{Object.entries(NOTEBOOK_STATUSES).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div>
          <button className="link-btn" type="submit">应用筛选</button>
          <a className="link-btn" href={notebookUrl({grade,subject})}>清除筛选</a>
        </div>
      </details>
    </form>
    {props.removed ? <div className="flash flash-row" role="status" data-testid="removed"><span>已移出这道题</span><form method="post" action={`/s/items/${props.removed}/restore`}><input type="hidden" name="returnTo" value={props.undoReturnTo ?? notebookUrl(filters,props.removed,props.selection ? [...selected] : undefined)} /><button className="link-btn" type="submit">撤销</button></form></div> : null}
    <p className="small muted" role="status">{grade} · {subject} · {all.length} 道{props.total !== undefined && props.total !== all.length ? `（共 ${props.total} 道）` : ''}</p>
    {props.selection ? <form method="post" action="/s/items/select" id="notebook-selection" data-notebook-selection="">
      {Object.entries(filters).map(([name,value])=><input key={name} type="hidden" name={name} value={value} />)}
      <input type="hidden" name="mode" value="select" />
      <fieldset className="notebook-chapters"><legend>按章节添加当前结果</legend>{[...new Set(all.map(item=>item.chapter || '未分类'))].map(chapter=><button key={chapter} className="link-btn" type="submit" name="addChapter" value={chapter}>添加 {chapter}</button>)}</fieldset>

      <ul className="list notebook-list">{all.map(card)}</ul>
      {recovery.length || [...selected].some(id=>!known.has(id)) ? <section aria-label="保留的选择"><h2>保留的选择</h2><p className="hint">这些题不在当前结果中或已不可用，请检查并取消后继续。</p><ul className="list notebook-list">{recovery.map(card)}</ul>{[...selected].filter(id=>!known.has(id)).map(id=><label key={id} className="choice"><input type="checkbox" name="itemIds" value={id} defaultChecked /><span>不可用的题目：{id} · 取消后重试</span></label>)}</section> : null}
      <noscript><p className="hint">勾选后点“加入练习”提交；添加章节也会更新已选题数。超过 8 道时会保留选择，取消几道再提交。</p></noscript>
    </form> : <ul className="list notebook-list">{all.map(card)}</ul>}
    {!all.length ? <section className="card"><h2 className="card-title">{props.total ? '没有符合筛选的题目' : grade === ALL_STAGES ? `还没有${subject}错题` : `这个学段还没有${subject}错题`}</h2><p>以前收录和未分类的题目也会出现在这里。</p>{props.finding ? <p>AI 还在找题，稍后可以再来看看</p> : null}<a className="more" href={notebookUrl({grade,subject})}>查看全部{subject}错题</a><a className="more" href={props.anyPhoto ? '/s/photos' : '/s/capture'}>{props.anyPhoto ? '查看已上传照片' : '录入第一道错题'}</a></section> : null}
  </Page>;
}

export interface ProposalChange { field: string; before: string; after: string }

/** 改一下（§4.5）：说一句或写一句哪里不对 → 生成修改 → 改之前 / 改之后 → 就这样改。 */
export function FixPage(props: { item: V2WeekItem; revision: number; clientRequestId: string; instruction?: string; error?: string | null; returnTo?: string;
  proposal?: { proposalId: string; revision: number; changes: ProposalChange[]; clarify: string | null } | null }): ReactNode {
  const { item, proposal } = props;
  const returnTo = itemNotebookReturn(props.returnTo,item), detailHref = itemContextUrl(item,returnTo);
  const bar: BarModel = proposal && proposal.changes.length > 0
    ? {
      caption: '看一眼改之后的样子',
      primary: { title: '就这样改', key: 'accept', post: `/s/items/${item.id}/fix/accept`, fields: { proposalId: proposal.proposalId, revision: String(proposal.revision), returnTo } },
      secondary: [{ title: '不改了', key: 'cancel', href: detailHref }],
    }
    : { caption: '', primary: { title: '生成修改', key: 'propose', form: 'fix-form' }, secondary: [{ title: '不改了', key: 'cancel', href: detailHref }] };
  const label: Record<string, string> = { questionText: '题目', observation: '笔迹', subject: '科目', knowledgeTags: '知识点' };
  return (
    <Page title="改一下" back={{ href: detailHref, label: '返回' }} bar={bar}>
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
        <input type="hidden" name="revision" value={String(props.revision)} /><input type="hidden" name="returnTo" value={returnTo} />
        <input type="hidden" name="clientRequestId" value={props.clientRequestId} />
        <input type="hidden" name="method" value="keyboard" />
        <label htmlFor="fix-instruction" className="field-label">哪里不对</label>
        <textarea id="fix-instruction" name="instruction" maxLength={200} required defaultValue={props.instruction ?? ''} placeholder="说一句或写一句哪里不对，比如：第二行的 16 应该是 13" />
        <VoiceBox target="fix-instruction" />
      </form>
      <a className="more" href={itemContextUrl(item,returnTo,'/edit')} data-key="fix-manual"><Phrased text="自己动手改" suffix={<span className="chev-i" aria-hidden="true">›</span>} /></a>
    </Page>
  );
}

export function EditPage(props: { item: V2WeekItem; evidence: EvidenceView; error?: string | null; returnTo?: string }): ReactNode {
  const returnTo = itemNotebookReturn(props.returnTo,props.item), detailHref = itemContextUrl(props.item,returnTo);
  const bar: BarModel = { caption: '只改题目的字；你写的错答案不要改对', primary: { title: '保存修改', key: 'save', form: 'edit-form' }, secondary: [{ title: '不改了', key: 'cancel', href: detailHref }] };
  return (
    <Page title="自己动手改" back={{ href: detailHref, label: '返回' }} bar={bar}>
      <h1>自己动手改</h1>
      {props.error ? <Problem title="没改成" detail={props.error} /> : null}
      <form method="post" action={`/s/items/${props.item.id}/edit`} id="edit-form">
        <input type="hidden" name="revision" value={String(props.evidence.revision)} /><input type="hidden" name="returnTo" value={returnTo} />
        <label htmlFor="edit-text" className="field-label">AI 认出的题目</label>
        <textarea id="edit-text" name="questionText" defaultValue={props.evidence.questionText} maxLength={4000} />
      </form>
    </Page>
  );
}

/** Direct classification edits never assert that the student has checked the question text. */
export function CategoryEditPage(props: { item: V2WeekItem; error?: string; values?: {grade:string;subject:string;chapter:string}; returnTo?: string }): ReactNode {
  const returnTo = itemNotebookReturn(props.returnTo,props.item), detailHref = itemContextUrl(props.item,returnTo);
  const values = props.values ?? {grade:props.item.grade ?? '初中',subject:props.item.subject ?? '',chapter:props.item.chapter ?? ''};
  return <Page title="修改分类" back={{href:detailHref,label:'返回题目'}} bar={{caption:'只修改这道题的分类', primary:{title:'保存分类',key:'save-category',form:'category-form'},secondary:[]}}>
    <h1>修改分类</h1>
    {props.error ? <Problem title="分类未保存" detail={props.error} /> : null}
    <form id="category-form" method="post" action={`/s/items/${props.item.id}/category`}><input type="hidden" name="returnTo" value={returnTo} />
      <label className="field-label" htmlFor="category-grade">学段</label>
      <select id="category-grade" name="grade" defaultValue={values.grade}>{stageChoices(values.grade).map(grade => <option key={grade}>{grade}</option>)}</select>
      <label className="field-label" htmlFor="category-subject">学科</label>
      <input type="text" id="category-subject" name="subject" list="category-subjects" defaultValue={values.subject} required maxLength={100} />
      <datalist id="category-subjects">{JUNIOR_CATALOG.map(subject => <option key={subject.key} value={subject.name} />)}</datalist>
      <label className="field-label" htmlFor="category-chapter">章节或知识主题</label>
      <input type="text" id="category-chapter" name="chapter" defaultValue={values.chapter} required maxLength={100} placeholder={values.grade === '高中' ? '按题目填写章节' : '例如：一元二次方程'} />
      <p className="hint">填写章节即可；“根的判别式”等细知识点保留在题目详情中。</p>
    </form>
  </Page>;
}
