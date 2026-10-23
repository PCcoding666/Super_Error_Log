import { RedoReminder, type RedoOverviewView } from './redoDate.js';
import { itemContextUrl, itemNotebookReturn } from '../itemLearning.js';
import { NOTEBOOK_STATUS_GROUPS, notebookStatusGroup, notebookUrl, type NotebookFilters, type NotebookStatusGroup } from '../notebook.js';
import { stageChoices } from '../../classification/itemCategories.js';
import { ALL_STAGES } from '../../classification/stages.js';
import { JUNIOR_CATALOG } from '../../classification/juniorCatalog.js';
import type { ReactNode } from 'react';
import type { V2WeekItem as WeekCard } from '../../v2/weekService.js';
type V2WeekItem = Omit<WeekCard, 'jobId'>;
import type { EvidenceView } from '../../v2/correctionService.js';
export { ItemDetailPage } from './itemDetail.js';
import { Page, Phrased, Problem, SettingsButton, VoiceBox, type BarModel } from './layout.js';

/** 卡片只显示对他有意义的状态（§4.5）。 */
export function cardStatus(status: string): string | null {
  if (status === 'scheduled' || status === 'packet_generated') return '已加入练习';
  if (status === 'temporarily_mastered' || status === 'stably_mastered') return '已多次做对';
  if (status === 'needs_recheck') return '下次再练';
  return null;
}

const GROUP_TONE: Record<NotebookStatusGroup, string> = { todo: 'tone-orange', practicing: 'muted', mastered: 'tone-green', stable: 'tone-green' };

export function ItemCard(props: { item: V2WeekItem; href?: string; open?: boolean; extra?: ReactNode }): ReactNode {
  const { item } = props;
  const title = item.questionExcerpt || '题目文字暂不可用，可查看原图。';
  const subtitle = [item.knowledgeTags[0] || item.chapter || '未分类', item.shortId].filter(Boolean).join(' · ');
  const group = notebookStatusGroup(item.status) ?? 'todo';
  const body = <span className="notebook-line">
    <img className="notebook-thumb" src={`/s/img/item/${item.id}?s=thumb`} alt="" loading="lazy" />
    <span className="row-text">
      <span className="excerpt">{title}</span>
      <span className="meta-line muted">{subtitle}</span>
    </span>
    <span className={`notebook-status ${GROUP_TONE[group]}`}>{NOTEBOOK_STATUS_GROUPS[group]}</span>
    {props.href || props.open ? <span className="chev" aria-hidden="true">›</span> : null}
    {props.extra}
  </span>;
  // No aria-label: a name that is only the id would hide the visible title from VoiceOver.
  if (props.open) return <button type="submit" name="openItem" value={item.id} form="notebook-selection" id={`item-${item.id}`} className="row notebook-card" data-testid="item-card">{body}</button>;
  return props.href
    ? <a id={`item-${item.id}`} className="row notebook-card" href={props.href} data-testid="item-card">{body}</a>
    : <div id={`item-${item.id}`} className="row notebook-card" data-testid="item-card">{body}</div>;
}

function FilterMark(props: { on: boolean }): ReactNode {
  return <span className="mark" aria-hidden="true">{props.on ? '✓' : ''}</span>;
}

function FilterLinks(props: { filters: NotebookFilters; stages: string[]; chapters: string[]; which: 'all' | 'grade' | 'status' | 'chapter' }): ReactNode {
  const { filters, which } = props;
  const href = (patch: Partial<NotebookFilters>): string => notebookUrl({ ...filters, ...patch });
  const grade = props.stages.map(value => <a key={value} href={href({ grade: value })} data-filter="grade" data-value={value} aria-current={value === filters.grade ? 'true' : undefined}><FilterMark on={value === filters.grade} />{value}</a>);
  const status = [
    <a key="all" href={href({ status: '' })} data-filter="status" data-value="" aria-current={filters.status ? undefined : 'true'}><FilterMark on={!filters.status} />全部状态</a>,
    ...Object.entries(NOTEBOOK_STATUS_GROUPS).map(([value, label]) => <a key={value} href={href({ status: value })} data-filter="status" data-value={value} aria-current={filters.status === value ? 'true' : undefined}><FilterMark on={filters.status === value} />{label}</a>),
  ];
  const chapter = [
    <a key="all" href={href({ chapter: '' })} data-filter="chapter" data-value="" aria-current={filters.chapter ? undefined : 'true'}><FilterMark on={!filters.chapter} />全部章节</a>,
    ...props.chapters.map(value => <a key={value} href={href({ chapter: value })} data-filter="chapter" data-value={value} aria-current={filters.chapter === value ? 'true' : undefined}><FilterMark on={filters.chapter === value} />{value}</a>),
  ];
  return <div className="menu">
    {(which === 'all' && props.stages.length > 1) || which === 'grade' ? <div className="menu-section"><p className="menu-label">学段</p>{grade}</div> : null}
    {which === 'all' || which === 'status' ? <div className="menu-section"><p className="menu-label">状态</p>{status}</div> : null}
    {which === 'all' || which === 'chapter' ? <div className="menu-section"><p className="menu-label">章节</p>{chapter}</div> : null}
    {which === 'all' ? <div className="menu-section"><a href={notebookUrl({ grade: filters.grade, subject: filters.subject })}>清除筛选</a></div> : null}
  </div>;
}

export interface NotebookPageProps {
  items: V2WeekItem[]; backlog: V2WeekItem[]; anyPhoto: boolean; finding: boolean; bar: BarModel;
  category: { grade: string; subject: string; subjects: string[]; stages?: string[] };
  materials?: boolean;
  /** Material intake still needing the student: questions not yet added, failed photos, photos in progress. */
  materialIntake?: { pending: number; failed: number; processing: number };
  filters?: NotebookFilters; chapters?: string[]; total?: number; selection?: boolean; selectedIds?: string[];
  eligibleIds?: string[]; recoveryItems?: V2WeekItem[]; removed?: string | null; undoReturnTo?: string;
  flash?: { ok?: string | null; err?: string | null };
  /** 到了「再做」日子的题（P0-3 首页提醒）。 */
  redo?: RedoOverviewView;
  activePractice?: { id: string; left: number } | null;
}
export function ItemsPage(props: NotebookPageProps): ReactNode {
  const { grade, subject, subjects } = props.category;
  const filters = props.filters ?? {grade,subject,chapter:'',status:'',q:''};
  const all = [...props.items, ...props.backlog];
  const selected = new Set(props.selectedIds ?? []);
  const eligible = new Set(props.eligibleIds ?? []);
  const context = notebookUrl(filters);
  const selectionUrl = notebookUrl(filters,undefined,[]);
  const stages = props.category.stages ?? [grade];
  const chapters = props.chapters ?? [];
  const subjectSwitch = <details className="subject-switch pop-menu">
    <summary aria-label={`切换学科，当前${subject}`} data-testid="subject-switch"><span>{subject}</span><svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg></summary>
    {/* Leave the stage off the link. The next subject keeps it only when that subject still has questions in it. */}
    <nav className="subject-options" aria-label="选择学科">{subjects.map(name => <a key={name} href={notebookUrl({subject:name})} aria-current={name === subject ? 'page' : undefined}><span>{name}</span>{name === subject ? <span aria-hidden="true">✓</span> : null}</a>)}</nav>
  </details>;
  const toolbar = <div className="toolbar-group">
    <details className="pop-menu filter-pop" data-testid="notebook-filters">
      <summary aria-label="筛选" data-key="notebook-filter"><svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg></summary>
      <FilterLinks filters={filters} stages={stages} chapters={chapters} which="all" />
    </details>
    <SettingsButton />
  </div>;
  const card = (item: V2WeekItem) => <li key={item.id} className="notebook-entry">
    <ItemCard item={item} open={props.selection} href={props.selection ? undefined : `/s/items/${item.id}?${new URLSearchParams({returnTo:notebookUrl(filters,item.id)})}`} />
    {props.selection ? <label className="notebook-choice"><input type="checkbox" name="itemIds" value={item.id} defaultChecked={selected.has(item.id)} disabled={!eligible.has(item.id) && !selected.has(item.id)} /><span className="mark" aria-hidden="true">✓</span><span className="visually-hidden">选择 {item.shortId ?? '这道题'}</span></label> : null}
    {props.selection && !eligible.has(item.id) ? <span className="meta-line muted notebook-note">{selected.has(item.id) ? '当前不可加入，请取消选择后继续' : '已在练习中或暂不可练习'}</span> : null}
  </li>;
  const recovery = props.recoveryItems ?? [];
  const known = new Set([...all,...recovery].map(item=>item.id));
  const selectionBar: BarModel = {caption:`已选 ${selected.size} 道 / 最多 8 道`,captionStatusId:'notebook-selection-count',primary:{title:'加入练习',key:'notebook-create',form:'notebook-selection',describedBy:'notebook-selection-count notebook-selection-hint'},secondary:[]};
  const pending = all.filter(item => notebookStatusGroup(item.status) === 'todo').length;
  // 这个学科和学段一道题都没有时，「选题练习」无题可选，不显示。
  const nothingStored = !all.length && !props.total;
  const totalNote = props.total !== undefined && props.total !== all.length ? `（共 ${props.total} 道）` : '';
  const groups = (rows: V2WeekItem[], title: string) => rows.length ? <section key={title}><h2 className="group-label">{title}</h2><ul className="inset-group notebook-list">{rows.map(card)}</ul></section> : null;
  const library = <>
    {groups(props.items, '本周')}
    {groups(props.backlog, '更早')}
  </>;
  return <Page title="错题本" tab={props.selection ? undefined : 'items'} back={null} bodyClass={`notebook-page${props.selection ? ' notebook-selection-page' : ''}`} bar={props.selection ? selectionBar : props.bar} flash={props.flash} topTrailing={toolbar}
    barExtra={props.selection ? <p className="hint notebook-bar-hint" data-notebook-limit="" id="notebook-selection-hint">{selected.size > 8 ? '超过 8 道了，请取消几道后继续。' : selected.size === 0 ? '至少选 1 道题' : '可逐题取消'}</p> : undefined}>
    <div className="notebook-title"><h1>{subjectSwitch}</h1>{props.selection ? <a className="link-btn" href={context}>取消选题</a> : nothingStored ? null : <a className="btn primary practice-fab" href={selectionUrl}>选题练习</a>}</div>
    <p className="page-subtitle" role="status">{grade} · {all.length} 道错题 · {pending} 道待练习{totalNote}</p>
    {props.selection ? null : <RedoReminder overview={props.redo} active={props.activePractice} compact />}
    {!props.selection && props.materialIntake && (props.materialIntake.pending || props.materialIntake.failed || props.materialIntake.processing) ? <div className="material-surface"><div className="inset-group" data-testid="material-intake">
      {props.materialIntake.pending ? <a className="nav-row" href="/s/materials#material-pending"><span className="row-text">拍的材料里还有 {props.materialIntake.pending} 道题没收进错题本，去勾选</span><span className="chev" aria-hidden="true">›</span></a> : null}
      {props.materialIntake.failed ? <a className="nav-row" href="/s/materials"><span className="row-text tone-orange">{props.materialIntake.failed} 张照片没整理成功，去一键重新整理</span><span className="chev" aria-hidden="true">›</span></a> : null}
      {props.materialIntake.processing ? <a className="nav-row" href="/s/materials"><span className="row-text">还有 {props.materialIntake.processing} 张照片在整理，看看进度</span><span className="chev" aria-hidden="true">›</span></a> : null}
    </div></div> : null}
    {props.selection ? <p className="hint">选 1–8 道题加入练习。更改筛选或学科会结束本次选题；已建练习不受影响。</p> : null}
    <form method="get" action="/s/items" className="notebook-filters" role="search" aria-label="搜索错题">
      <input type="hidden" name="subject" value={subject} />
      <input type="hidden" name="grade" value={grade} />
      {filters.chapter ? <input type="hidden" name="chapter" value={filters.chapter} /> : null}
      {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
      <div className="search-field">
        <svg className="search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
        <label className="visually-hidden" htmlFor="library-search">搜索题目</label>
        <input id="library-search" name="q" type="search" enterKeyHint="search" maxLength={200} defaultValue={filters.q} placeholder="题干、编号、章节或知识点" />
      </div>
      <button className="visually-hidden" type="submit">搜索</button>
    </form>
    <div className="filter-chips">
      {stages.length > 1 ? <details className="filter-chip pop-menu"><summary>学段：{grade}<svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg></summary><FilterLinks filters={filters} stages={stages} chapters={chapters} which="grade" /></details> : null}
      <details className={`filter-chip pop-menu${filters.chapter ? ' chip-on' : ''}`}><summary>{filters.chapter || '章节'}<svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg></summary><FilterLinks filters={filters} stages={stages} chapters={chapters} which="chapter" /></details>
      <details className={`filter-chip pop-menu${filters.status ? ' chip-on' : ''}`}><summary>{filters.status ? NOTEBOOK_STATUS_GROUPS[filters.status as NotebookStatusGroup] : '状态'}<svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg></summary><FilterLinks filters={filters} stages={stages} chapters={chapters} which="status" /></details>
    </div>
    {props.removed ? <div className="flash flash-row" role="status" data-testid="removed"><span>已移出这道题</span><form method="post" action={`/s/items/${props.removed}/restore`}><input type="hidden" name="returnTo" value={props.undoReturnTo ?? notebookUrl(filters,props.removed,props.selection ? [...selected] : undefined)} /><button className="link-btn" type="submit">撤销</button></form></div> : null}
    {props.selection ? <form method="post" action="/s/items/select" id="notebook-selection" data-notebook-selection="">
      {Object.entries(filters).map(([name,value])=><input key={name} type="hidden" name={name} value={value} />)}
      <input type="hidden" name="mode" value="select" />
      <fieldset className="notebook-chapters"><legend>按章节添加当前结果</legend>{[...new Set(all.map(item=>item.chapter || '未分类'))].map(chapter=><button key={chapter} className="link-btn" type="submit" name="addChapter" value={chapter}>添加 {chapter}</button>)}</fieldset>
      {library}
      {recovery.length || [...selected].some(id=>!known.has(id)) ? <section aria-label="保留的选择"><h2>保留的选择</h2><p className="hint">这些题不在当前结果中或已不可用，请检查并取消后继续。</p><ul className="inset-group notebook-list">{recovery.map(card)}</ul>{[...selected].filter(id=>!known.has(id)).map(id=><label key={id} className="choice"><input type="checkbox" name="itemIds" value={id} defaultChecked /><span>不可用的题目：{id} · 取消后重试</span></label>)}</section> : null}
      <noscript><p className="hint">勾选后点“加入练习”提交；添加章节也会更新已选题数。超过 8 道时会保留选择，取消几道再提交。</p></noscript>
    </form> : library}
    {!all.length ? <section className="card"><h2 className="card-title">{props.total ? '没有符合筛选的题目' : grade === ALL_STAGES ? `还没有${subject}错题` : `这个学段还没有${subject}错题`}</h2><p>以前收录和未分类的题目也会出现在这里。</p>{props.finding ? <p>AI 还在找题，稍后可以再来看看</p> : null}{props.total ? <a className="more" href={notebookUrl({grade,subject})}>清除筛选</a> : grade !== ALL_STAGES && stages.includes(ALL_STAGES) ? <a className="more" href={notebookUrl({grade:ALL_STAGES,subject})}>看看全部学段</a> : null}<a className="more" href={props.anyPhoto ? '/s/photos' : '/s/capture'}>{props.anyPhoto ? '查看已上传照片' : '录入第一道错题'}</a>{props.materials ? <a className="more" href="/s/materials">查看学习材料</a> : null}</section> : null}
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
