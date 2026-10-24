import type { ReactNode } from 'react';
import { randomUUID } from 'node:crypto';
import type { BatchAction, CaptureHints, Fragment, MaterialRole, QuestionBundle, ReferenceAnswer } from '../../materials/contracts.js';
import { Page, type BarButton } from './layout.js';
import { CaptureExamples } from './photos.js';
import { UNSUPPORTED_SUBJECT_MESSAGE, unsupportedSubject } from '../../materials/subjects.js';
import { withoutTableRows } from '../stemText.js';

export interface MaterialAssetView {
  id: string;
  hints: CaptureHints;
  document_id: string | null;
  status: string;
  link_revision: number;
  fragments: Fragment[];
}

const roleNames: Record<MaterialRole, string> = {
  question: '题目', diagram: '图形', student_work: '我的作答', correction: '订正',
  teacher_mark: '老师批改', reference_answer: '参考答案', unknown: '不确定',
};
/** Short names for counts such as「作答 3 · 老师批改 3 · 订正 1」. */
const shortRoleNames: Record<MaterialRole, string> = {
  question: '题目', diagram: '图形', student_work: '作答', correction: '订正',
  teacher_mark: '老师批改', reference_answer: '参考答案', unknown: '其他',
};

const Hidden = ({ namespace, revision }: { namespace: string; revision?: number }) => <>
  <input type="hidden" name="namespace" value={namespace} />
  {revision !== undefined ? <input type="hidden" name="expectedRevision" value={revision} /> : null}
</>;

function Chevron(): ReactNode {
  return <span className="chev" aria-hidden="true">›</span>;
}

/** 打开下一屏的控件：内嵌列表行 + 尾部 chevron，文字用正文色。 */
function NavRow(props: { href: string; children: ReactNode }): ReactNode {
  return <a className="nav-row" href={props.href}><span className="row-text">{props.children}</span><Chevron /></a>;
}

/** 就地展开：披露行，收起时 chevron 朝右，展开后朝下。 */
function Disclosure(props: { title: string; children: ReactNode; open?: boolean; id?: string; testId?: string }): ReactNode {
  return <details className="disclosure" open={props.open || undefined} id={props.id} data-testid={props.testId}><summary>{props.title}</summary><div className="disclosure-body">{props.children}</div></details>;
}

/** One folded tool group on a task page: closed by default, opened when it holds something in progress. */
function ToolGroup(props: { title: string; children: ReactNode; open?: boolean; id?: string; testId?: string }): ReactNode {
  return <div className="inset-group"><Disclosure {...props} /></div>;
}

export function HintFields(): ReactNode {
  return (
    <Disclosure title="加个提示（可跳过）">
      <fieldset>
        <legend>这张拍了什么？可以多选</legend>
        {Object.entries(roleNames).map(([value, label]) => <label className="choice" key={value}><input type="checkbox" name="roles" value={value} /><span>{label}</span></label>)}
      </fieldset>
      <label className="field-label">批改情况
        <select name="marking" defaultValue="">
          <option value="">不填写</option>
          <option value="unmarked">未批改</option>
          <option value="marked">已批改</option>
          <option value="partial">部分批改</option>
        </select>
      </label>
      <label className="field-label">备注（可不填）<input type="text" name="label" maxLength={120} /></label>
      <p className="hint">提示只帮助整理；选“未批改”不会开始批改。清空选项后保存，就能去掉提示。</p>
    </Disclosure>
  );
}

/** Capture tab. One filled button (「拍照」, then「继续拍照」); the way out and the upload status appear
 * only after something was taken. The upload queue script keeps these in step without a reload. */
export function MaterialCapturePage({ namespace, count, uploadId, context = {} }: {
  namespace: string;
  count: number;
  uploadId: string;
  context?: CaptureHints;
}): ReactNode {
  const supplement = !!context.questionId;
  const hidden = count ? undefined : 'hidden';
  return (
    <Page title={supplement ? '补充材料' : '拍学习材料'} tab={supplement ? undefined : 'capture'} bodyClass="capture-page"
      back={supplement ? { href: `/s/materials/questions/${context.questionId}`, label: '返回题目' } : undefined}>
      <section className="material-surface" data-material-capture="" data-draft-namespace={namespace} data-saved-count={count}>
        <h1>{supplement ? '补充材料' : '拍学习材料'}</h1>
        {supplement ? <p className="hint">从这道题继续补拍；整页上其他题目会分别整理。</p> : null}
        <p className="lead">题目、答题卡、作答或答案都可以拍，顺序不限，之后还能补。</p>
        <p className="hint" data-testid="capture-subjects">{UNSUPPORTED_SUBJECT_MESSAGE.replace('。', '')}的卷子，其他科目先不用拍。</p>
        {count ? null : <CaptureExamples />}
        <form method="post" encType="multipart/form-data" action={`/s/materials/uploads?namespace=${namespace}&uploadId=${uploadId}`} id="material-upload-form" data-material-upload="">
          {context.questionId ? <input type="hidden" name="questionId" value={context.questionId} /> : null}
          {context.attemptId ? <input type="hidden" name="attemptId" value={context.attemptId} /> : null}
          <input className="visually-hidden" id="camera-input" name="photo" type="file" accept="image/*,.heic,.heif" capture="environment" />
          <input className="visually-hidden" id="library-input" name="photo" type="file" accept="image/*,.heic,.heif" multiple />
          <div className="inset-group"><HintFields /></div>
          <noscript><p>未开启脚本时，每次选一张照片，再点下面的“上传这张照片”。HEIC 请先存为 JPEG。</p></noscript>
        </form>
        <div className={hidden} data-capture-progress="">
          <p className="capture-count" data-testid="photo-count">已拍 {count} 张</p>
          <ul className="capture-thumbs hidden" data-capture-thumbs="" aria-label="这次拍的照片" />
          <p role="status" data-queue-message="" />
        </div>
        <p className="hint" data-queue-warning="" />
        <ul className="list" data-upload-queue="" />
        <div className={`inset-group${count ? '' : ' hidden'}`} data-capture-done="">
          <a className="nav-row" href="/s/materials" data-key="materials" data-testid="capture-done" aria-label="拍完了，查看材料"><span className="row-text" data-done-text="">拍完了，查看材料</span><Chevron /></a>
        </div>
        <nav className="capture-actions" aria-label="拍照">
          <label className="btn primary" htmlFor="camera-input" data-key="capture" data-capture-label="">{count ? '继续拍照' : '拍照'}</label>
          <label className="btn" htmlFor="library-input">从相册选（可多选）</label>
          <noscript><button className="btn" type="submit" form="material-upload-form">上传这张照片</button></noscript>
        </nav>
      </section>
    </Page>
  );
}

function questionTitle(q: QuestionBundle): string {
  return q.number ? `第 ${q.number} 题` : '题号不清';
}

function fragmentLine(fragments: Fragment[]): string {
  return fragments.map(f => [f.number ? `第${f.number}题` : '题号不清', f.subpart ?? '', roleNames[f.role]].filter(Boolean).join(' ')).join('；') || '还没有可用于区分的题号或内容';
}

/** First sentence of the stem, short enough for one list line. */
export function stemFirstSentence(q: QuestionBundle, max = 28): string {
  const text = q.stem.filter(f => f.role === 'question').map(f => withoutTableRows(f.text)).join(' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:第\s*)?[0-9０-９]+\s*(?:题|[.．、)）])\s*/u, '');
  if (!text) return '';
  const first = /^.+?[。？！?!；;]/u.exec(text)?.[0] ?? text;
  return first.length > max ? first.slice(0, max) + '…' : first;
}

function shortText(text: string, max = 24): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

/** 'correct' = every certain teacher mark is a tick: not offered for inclusion, still includable by hand. */
export type MaterialInclusionMark = 'included' | 'removed' | 'pending' | 'correct';
const inclusionNames: Record<MaterialInclusionMark, string> = { included: '已收录', removed: '已移出错题本', pending: '未收录', correct: '老师判对' };
const missingNames = { stem: '题目', diagram: '图形', work: '作答' } as const;

/** The one status line under each question: subject · first stem sentence · inclusion, plus anything missing. */
function QuestionMeta({ q, mark }: { q: QuestionBundle; mark: MaterialInclusionMark }): ReactNode {
  const other = unsupportedSubject(q.subject);
  const parts = [q.subject?.trim() || '学科待定', stemFirstSentence(q)].filter(Boolean).join(' · ');
  const issues = [q.missing.length ? '缺' + q.missing.map(x => missingNames[x]).join('、') : '', q.unresolved.length ? '归属待确定' : ''].filter(Boolean).join(' · ');
  return <p className="row-detail meta-line" data-testid="material-question-meta">
    <span>{parts}</span>{' · '}
    {other ? <span className="tone-orange">{UNSUPPORTED_SUBJECT_MESSAGE}</span>
      : <span className={mark === 'included' ? 'tone-green' : 'muted'} data-testid="material-inclusion">{inclusionNames[mark]}</span>}
    {issues ? <>{' · '}<span className="tone-orange">{issues}</span></> : null}
  </p>;
}

export type MaterialJobView = { id: string; state: string; assetId?: string | null; retryable?: boolean };
export type MaterialPendingGroup = { assetId: string; photo: number; questions: QuestionBundle[] };
/** Material on one photo the model could not place under a printed number (see unplacedMaterial). */
export type MaterialUnplacedGroup = { assetId: string; photo: number; items: { questionId: string; fragment: Fragment }[] };

/** Top-of-page status: in progress, failed (one tap retries all), other subjects. Polled while processing. */
function MaterialStatus(props: { namespace: string; processing: number; failed: MaterialJobView[]; unsupported: { photo: number; subject: string }[]; assetCount: number; questionCount: number }): ReactNode {
  const retryable = props.failed.filter(j => j.retryable !== false);
  const broken = props.failed.length - retryable.length;
  return <div data-live="material-status" data-testid="material-status">
    {props.processing ? <p className="inset-group group-pad" role="status" data-row="processing">正在整理 {props.processing} 张照片，整理好的题会自动出现在下面，不用一直刷新。</p>
      : props.assetCount && !props.failed.length ? <p className="inset-group group-pad tone-green" role="status" data-row="done" data-testid="material-done">照片都整理好了，共找到 {props.questionCount} 道题。</p> : null}
    {props.failed.length ? (
      <form className="inset-group retry-card group-pad" method="post" action="/s/materials/jobs/retry-all" data-testid="material-failed">
        <Hidden namespace={props.namespace} />
        <input type="hidden" name="requestId" value={randomUUID()} />
        <p className="row-detail" data-row="failed">{props.failed.length} 张照片没整理成功，原图已保留。</p>
        {broken ? <p className="hint">其中 {broken} 张看不清或格式不对，请重拍这几张。</p> : null}
        {retryable.length ? <div className="btn-stack"><button className="btn" type="submit">一键重新整理</button></div> : null}
      </form>
    ) : null}
    {props.unsupported.length ? (
      <section className="inset-group group-pad" data-testid="material-unsupported">
        <p className="tone-orange">{UNSUPPORTED_SUBJECT_MESSAGE}</p>
        <p className="row-detail">{props.unsupported.map(u => `照片 ${u.photo}（${u.subject}）`).join('、')}不会整理成错题，原图仍保留。</p>
      </section>
    ) : null}
  </div>;
}

/** Every form stays well under the form parsers' 200-field limit: one checkbox per question plus a few fields. */
export const PENDING_FORM_MAX = 120;
function pendingChunks(questions: QuestionBundle[]): QuestionBundle[][] {
  const chunks: QuestionBundle[][] = [];
  for (let i = 0; i < questions.length; i += PENDING_FORM_MAX) chunks.push(questions.slice(i, i + PENDING_FORM_MAX));
  return chunks;
}
export const PENDING_FORM_ID = 'material-pending-form';
/** One form, submitted by the page's bottom button, unless the whole submission would not fit the same budget:
 * a checkbox per question, a hidden page field per photo, the namespace and the pressed button. */
export const pendingInOneForm = (groups: MaterialPendingGroup[]): boolean => {
  const total = groups.reduce((n, g) => n + g.questions.length, 0);
  return total > 0 && total + groups.length + 2 <= PENDING_FORM_MAX;
};

function PendingFieldset({ g, questions, legend }: { g: MaterialPendingGroup; questions: QuestionBundle[]; legend: string }): ReactNode {
  return <>
    <input type="hidden" name={`page_${g.assetId}`} value={questions.map(q => `${q.id}:${q.revision}`).join(',')} />
    <fieldset>
      <legend>{legend}</legend>
      {questions.map(q => (
        <label className="choice" key={q.id}>
          <input type="checkbox" name="pick" value={`${q.id}:${q.revision}`} />
          <span>{questionTitle(q)}{stemFirstSentence(q) ? ` · ${stemFirstSentence(q)}` : ''}</span>
        </label>
      ))}
    </fieldset>
  </>;
}

/** 「本页还有 N 道没收录」：一页全收，或逐个勾选。题不多时合成一个表单，由底部主按钮「收录勾选的题」提交；
 * 待收录的题很多时，每张照片（再按上限切分）单独一个表单，一次提交的字段数有上限。勾选值带上看到时的版本，变了的题会跳过。 */
function PendingInclusion({ namespace, groups }: { namespace: string; groups: MaterialPendingGroup[] }): ReactNode {
  const total = groups.reduce((n, g) => n + g.questions.length, 0);
  const one = pendingInOneForm(groups);
  return <div data-live="material-pending">
    {total ? (
      <section id="material-pending" data-testid="material-pending">
        <h2 className="group-label">还没收进错题本的题</h2>
        <p className="group-footer">老师打了叉（包括叉加评语）的题已经自动收好，打 √ 的题不用收。做错、扣了分或没把握的题，勾上收进错题本。</p>
        {one ? (
          <form method="post" action="/s/materials/inclusions" id={PENDING_FORM_ID} className="inset-group group-pad" data-testid="material-pending-page">
            <Hidden namespace={namespace} />
            {groups.map(g => (
              <div key={g.assetId}>
                <PendingFieldset g={g} questions={g.questions} legend={`照片 ${g.photo}：本页还有 ${g.questions.length} 道没收录`} />
                <div className="btn-stack"><button className="btn" type="submit" name="allOf" value={g.assetId}>本页 {g.questions.length} 道全部收录</button></div>
              </div>
            ))}
          </form>
        ) : groups.flatMap(g => pendingChunks(g.questions).map((questions, part, all) => (
          <form method="post" action="/s/materials/inclusions" key={`${g.assetId}:${part}`} className="inset-group group-pad" data-testid="material-pending-page">
            <Hidden namespace={namespace} />
            <PendingFieldset g={g} questions={questions} legend={`照片 ${g.photo}${all.length > 1 ? `（第 ${part + 1} 部分）` : ''}：本页还有 ${questions.length} 道没收录`} />
            <div className="btn-stack">
              <button className="btn" type="submit" name="allOf" value={g.assetId}>本页 {questions.length} 道全部收录</button>
              <button className="btn" type="submit">收录勾选的题</button>
            </div>
          </form>
        )))}
      </section>
    ) : null}
  </div>;
}

/** 「这张照片还有 7 段内容没对上题号（作答 3 · 老师批改 3 · 订正 1）」：只汇总，不猜它们属于哪道题。
 * 展开后逐段链到它现有的手动关联入口。 */
function UnplacedMaterial({ groups, single }: { groups: MaterialUnplacedGroup[]; single: boolean }): ReactNode {
  return <>{groups.filter(g => g.items.length).map(g => {
    const counts = new Map<MaterialRole, number>();
    for (const { fragment } of g.items) counts.set(fragment.role, (counts.get(fragment.role) ?? 0) + 1);
    const breakdown = [...counts].map(([role, n]) => `${shortRoleNames[role]} ${n}`).join(' · ');
    return (
      <div className="inset-group" key={g.assetId} data-testid="material-unplaced">
        <Disclosure title={`${single ? '这张照片' : `照片 ${g.photo} `}还有 ${g.items.length} 段内容没对上题号（${breakdown}）`}>
          <p className="hint">没认出题号的内容不会自动归到题上，也不算在题目里。需要时对照原图，把它归到对应的题。</p>
          <NavRow href={`/s/materials/assets/${g.assetId}/image`}>查看原图</NavRow>
          {g.items.map(({ questionId, fragment: f }) => (
            <NavRow key={f.fragmentId} href={`/s/materials/questions/${questionId}#adjust`}>{shortRoleNames[f.role]}{f.text.trim() ? ` · ${shortText(f.text, 18)}` : ''} · 对照原图归到题上</NavRow>
          ))}
        </Disclosure>
      </div>
    );
  })}</>;
}

export function MaterialsPage(props: {
  namespace: string;
  /** Questions in paper and number order, without unplaced material. */
  questions: QuestionBundle[];
  assets: MaterialAssetView[];
  page: number;
  hasMore: boolean;
  documents: { id: string; label: string | null }[];
  changes: { id: string }[];
  jobs: MaterialJobView[];
  revision: number;
  processing?: number;
  assetCount?: number;
  /** Photo number (1-based, all pages) per asset id. */
  photoNumbers?: Record<string, number>;
  unsupported?: { assetId: string; subject: string }[];
  pending?: MaterialPendingGroup[];
  unplaced?: MaterialUnplacedGroup[];
  marks?: Record<string, MaterialInclusionMark>;
  notice?: { included: number; skipped: number; retried?: number } | null;
}): ReactNode {
  const { namespace } = props;
  const processing = props.processing ?? 0;
  const photoNumbers = props.photoNumbers ?? Object.fromEntries(props.assets.map((a, i) => [a.id, props.page * 8 + i + 1]));
  const unsupported = props.unsupported ?? [];
  const assetCount = props.assetCount ?? props.assets.length;
  const failedAssets = new Set(props.jobs.map(j => j.assetId).filter((id): id is string => !!id));
  const notice = props.notice;
  const pending = props.pending ?? [];
  const mark = (q: QuestionBundle) => props.marks?.[q.id] ?? (q.itemId ? 'included' : 'pending');
  // The bottom button is the task on this page: include the ticked questions, else go practise what is in.
  const primary: BarButton | null = pendingInOneForm(pending) ? { title: '收录勾选的题', key: 'include', form: PENDING_FORM_ID }
    : props.questions.some(q => mark(q) === 'included') && !processing ? { title: '去练习', key: 'practice', href: '/s/practices' } : null;
  return (
    <Page title="我的材料" back={{ href: '/s/items', label: '错题本' }} pollSeconds={processing ? 4 : undefined}
      bar={{ caption: '材料已保存，可以先结束；以后随时补拍。', primary, secondary: [{ title: '继续拍照', key: 'capture', href: '/s/capture' }] }}>
      <div className="material-surface" data-draft-namespace={namespace}>
        <h1>我的材料</h1>
        <p className="lead">按题整理，缺的材料以后再补。</p>
        {notice ? <div className="flash" role="status" data-testid="include-done">
          {notice.retried !== undefined ? `已重新开始整理 ${notice.retried} 张照片。` : notice.included ? `已收进错题本 ${notice.included} 道。` : '这次没有收进新的题。'}
          {notice.skipped ? ` 有 ${notice.skipped} 道刚刚有变化，没收进去，请再勾一次。` : ''}
          {notice.included ? <> <a href="/s/items">去错题本看看 ›</a></> : null}
        </div> : null}
        <MaterialStatus namespace={namespace} processing={processing} failed={props.jobs} assetCount={assetCount} questionCount={props.questions.length}
          unsupported={unsupported.map(u => ({ photo: photoNumbers[u.assetId] ?? 0, subject: u.subject }))} />
        <PendingInclusion namespace={namespace} groups={pending} />
        <div data-live="material-questions">
          {!props.questions.length ? <p className="group-footer">照片保存后会继续整理，整理好的题会出现在这里。</p> : null}
          {props.questions.length ? <h2 className="group-label">题目</h2> : null}
          {props.questions.map(q => (
            <section className="inset-group" key={q.id}>
              <h2 className="nav-title"><NavRow href={`/s/materials/questions/${q.id}`}>{questionTitle(q)}</NavRow></h2>
              <QuestionMeta q={q} mark={mark(q)} />
            </section>
          ))}
          <UnplacedMaterial groups={props.unplaced ?? []} single={assetCount === 1} />
        </div>
        <details className="disclosure tools" data-testid="material-tools">
          <summary><span className="row-text">整理工具<span className="summary-detail">刷新、批量批改、参考答案、原图归属</span></span></summary>
          <div className="inset-group">
            <NavRow href="/s/materials">刷新整理结果</NavRow>
            <BatchGradeForms namespace={namespace} documents={props.documents} questions={props.questions} />
            <BatchAnswerForms namespace={namespace} documents={props.documents} questions={props.questions} />
          </div>
          <h2 className="group-label">原图和整页归属</h2>
          <p className="group-footer">只有需要调整时才选；一次调整整页，不必逐题确认。</p>
          {props.assets.map((a, i) => <AssetCard key={a.id} namespace={namespace} asset={a} index={(photoNumbers[a.id] ?? i + 1) - 1} assets={props.assets} documents={props.documents}
            state={unsupported.find(u => u.assetId === a.id) ? `${unsupported.find(u => u.assetId === a.id)!.subject} · ${UNSUPPORTED_SUBJECT_MESSAGE}` : failedAssets.has(a.id) ? '没整理成功，可在页首重新整理' : undefined} />)}
          {props.page > 0 || props.hasMore ? (
            <div className="inset-group">
              {props.page > 0 ? <NavRow href={`/s/materials?page=${props.page - 1}`}>上一页原图</NavRow> : null}
              {props.hasMore ? <NavRow href={`/s/materials?page=${props.page + 1}`}>下一页原图</NavRow> : null}
            </div>
          ) : null}
          {props.changes.length ? (
            <div className="inset-group">
              {props.changes.map((c, i) => (
                <form method="post" action={`/s/materials/links/${c.id}/undo`} key={c.id}>
                  <Hidden namespace={namespace} revision={props.revision} />
                  <button className="btn" type="submit">撤销关联调整 {i + 1}</button>
                </form>
              ))}
            </div>
          ) : null}
        </details>
      </div>
    </Page>
  );
}

function AssetCard(props: {
  namespace: string;
  asset: MaterialAssetView;
  index: number;
  assets: MaterialAssetView[];
  documents: { id: string; label: string | null }[];
  state?: string;
}): ReactNode {
  const { namespace, asset: a, index: i, assets, documents } = props;
  const title = `照片 ${i + 1}${a.hints.label ? ` · ${a.hints.label}` : ''}`;
  return (
    <section className="inset-group">
      <a className="asset-row" href={`/s/materials/assets/${a.id}/image`}>
        <img loading="lazy" className="asset-thumb" src={`/s/materials/assets/${a.id}/image`} alt={`照片 ${i + 1} 原图`} />
        <span className="row-text">
          <h3>{title}</h3>
          <span className="meta-line">{props.state ?? (a.fragments.length ? `找到 ${a.fragments.length} 处材料` : '正在整理')}</span>
          <span className="meta-line muted break-anywhere">{fragmentLine(a.fragments)}</span>
        </span>
        <Chevron />
      </a>
      <Disclosure title="调整这页属于哪份试卷">
        <form method="post" action={`/s/materials/assets/${a.id}/document`}>
          <Hidden namespace={namespace} revision={a.link_revision} />
          <label className="field-label">已有试卷
            <select name="documentId" defaultValue={a.document_id ?? ''}>
              <option value="">选择一份（可不选）</option>
              {documents.map((d, n) => <option key={d.id} value={d.id}>{d.label || `试卷 ${n + 1}`}</option>)}
            </select>
          </label>
          <div className="btn-stack">
            <button className="btn" type="submit">放入这份试卷</button>
            <button className="btn" type="submit" name="newDocument" value="1">这是新的一份试卷</button>
          </div>
        </form>
        <NavRow href={`/s/materials/assets/${a.id}/match`}>对照另一张原图，确认同一份试卷</NavRow>
      </Disclosure>
      <Disclosure title="修改提示 / 批量修改">
        <form method="post" action={`/s/materials/assets/${a.id}/hints`}>
          <Hidden namespace={namespace} />
          {assets.filter(b => b.id !== a.id).map(b => (
            <label className="choice" key={b.id}>
              <input type="checkbox" name="assetIds" value={b.id} />
              <span>同时修改照片 {assets.indexOf(b) + 1}</span>
            </label>
          ))}
          <HintFields />
          <button className="btn" type="submit">保存提示</button>
        </form>
      </Disclosure>
    </section>
  );
}

/** Photo crops first: what the question is, what I wrote, what the teacher marked. Empty blocks are not shown. */
function MaterialBlock({ title, fragments, note }: { title: string; fragments: Fragment[]; note?: (f: Fragment) => string }): ReactNode {
  if (!fragments.length) return null;
  return (
    <section className="card material-block">
      <h2>{title}</h2>
      {fragments.map(f => (
        <figure key={f.fragmentId}>
          <a href={`/s/materials/assets/${f.assetId}/image`}><img loading="lazy" className="crop" src={`/s/materials/fragments/${f.fragmentId}/crop?revision=${f.revision}`} alt={`${roleNames[f.role]}原图`} /></a>
          {f.text.trim() ? <figcaption className="pre">{f.text}</figcaption> : null}
          {note?.(f) ? <p className="hint">{note(f)}</p> : null}
        </figure>
      ))}
    </section>
  );
}

/** Where a reference answer came from, in the student's words. */
function answerSource(a: ReferenceAnswer): string {
  return a.source === 'manual' ? '你手填的' : a.source === 'ai' ? 'AI 给的' : a.fragmentIds.length ? '照片里的' : '粘贴的';
}
function answerSaid(a: ReferenceAnswer): string {
  const where = a.source === 'manual' ? '你手填的是' : a.source === 'ai' ? 'AI 给的是' : a.fragmentIds.length ? '照片里是' : '粘贴的是';
  return `${a.subpart ? `（${a.subpart}）` : ''}${where} ${shortText(a.text, 30)}`;
}
const countWord = (n: number) => n === 2 ? '两' : ` ${n} `;

function AnswerChoices({ namespace, question: q, selected }: { namespace: string; question: QuestionBundle; selected: string[] }): ReactNode {
  return (
    <form method="post" action="/s/materials/answers/basis">
      <Hidden namespace={namespace} revision={q.revision} />
      <input type="hidden" name="questionId" value={q.id} />
      {q.answers.filter(a => !a.stale).map(a => (
        <label className="choice" key={a.id}>
          <input type="checkbox" name="answerIds" value={a.id} defaultChecked={selected.includes(a.id)} />
          <span>{answerSource(a)}{a.subpart ? `（${a.subpart}）` : ''}：{shortText(a.text, 80)}</span>
        </label>
      ))}
      <button className="btn" type="submit">用选中的答案</button>
    </form>
  );
}

/** The reference answer in plain words. Two disagreeing versions are asked about directly; the choice
 * itself is the same basis selection as before (several can be chosen, e.g. one per subpart). */
function AnswerSummary({ namespace, question: q, selected, references }: { namespace: string; question: QuestionBundle; selected: string[]; references: Fragment[] }): ReactNode {
  const valid = q.answers.filter(a => !a.stale);
  if (!valid.length && !references.length) return null;
  const chosen = valid.filter(a => selected.includes(a.id));
  const shown = q.answerConflict ? chosen : valid;
  return (
    <section className="card material-block" data-testid="material-answer">
      <h2>参考答案</h2>
      {q.answerConflict && !chosen.length ? <>
        <p className="tone-orange" data-testid="answer-conflict">答案有{countWord(valid.length)}个版本：{valid.map(answerSaid).join('，')}，用哪个？</p>
        <AnswerChoices namespace={namespace} question={q} selected={selected} />
      </> : null}
      {q.answerConflict && chosen.length ? <p className="hint" data-testid="answer-conflict">答案有{countWord(valid.length)}个版本，这次用你选的：{chosen.map(a => `${shortText(a.text, 30)}（${answerSource(a)}）`).join('、')}。可以在下面“参考答案”里改选。</p> : null}
      {shown.map(a => (
        <div key={a.id}>
          <p className="pre">{a.subpart ? `（${a.subpart}）` : ''}{a.text}</p>
          <p className="hint">{answerSource(a)}{a.source === 'manual' ? '' : ' · 待核验'}{a.claimedSource ? ` · 填写者说明：${a.claimedSource}（未经核验）` : ''}</p>
        </div>
      ))}
      {references.map(f => (
        <figure key={f.fragmentId}>
          <a href={`/s/materials/assets/${f.assetId}/image`}><img loading="lazy" className="crop" src={`/s/materials/fragments/${f.fragmentId}/crop?revision=${f.revision}`} alt="参考答案原图" /></a>
          {valid.some(a => a.fragmentIds.includes(f.fragmentId)) ? null : <><figcaption className="pre">{f.text}</figcaption><p className="hint">照片里的参考答案 · 待核验</p></>}
        </figure>
      ))}
    </section>
  );
}

const answerJobStates: Record<string, string> = { queued: '等待处理', running: '正在生成', succeeded: '已生成', failed: '未完成', interrupted: '已中断', stale: '依据已过期' };
const active = (state: string) => ['queued', 'running', 'failed', 'interrupted'].includes(state);

export function MaterialQuestionPage({ namespace, question: q, questions, revision, materials, selectedAnswerIds = [], answerJobs = [], gradeJobs = [], included = null, legacy = false, notice = null, unplaced = false }: {
  namespace: string;
  notice?: string | null;
  included?: boolean | null;
  legacy?: boolean;
  question: QuestionBundle;
  /** Where material can be moved: other questions in paper and number order. */
  questions: QuestionBundle[];
  revision: number;
  materials: Fragment[];
  selectedAnswerIds?: string[];
  answerJobs?: { id: string; state: string; error: string | null }[];
  gradeJobs?: { id: string; state: string; error: string | null }[];
  /** No printed number and no stem: the only useful thing here is to place it under a question. */
  unplaced?: boolean;
}): ReactNode {
  const other = unsupportedSubject(q.subject);
  const offerInclusion = !(other && !q.itemId && included !== false);
  const stemMissing = q.missing.includes('stem');
  const inclusion = (title: string, value: boolean): BarButton => ({ title, key: 'include', form: 'inclusion-form', name: 'included', value: String(value) });
  const primary: BarButton | null = unplaced ? null
    : included === false ? inclusion('恢复收录', true)
    : q.itemId ? { title: '去练习', key: 'practice', href: '/s/practices' }
    : !offerInclusion ? null
    : included === true ? { title: '补拍题目', key: 'capture', href: `/s/capture?questionId=${q.id}` }
    : inclusion('收录到错题本', true);
  const caption = unplaced ? '没认出题号。对照原图，在下面把它归到对应的题。'
    : included === false ? '已取消后续推荐，原材料和练习历史仍保留。'
    : q.itemId ? '已收录，可以先结束，也可以安排练习。'
    : included === true ? '收录意愿已保存，题干补齐后会进入错题本。'
    : other ? `这道是${other}题。${UNSUPPORTED_SUBJECT_MESSAGE}`
    : '做错、扣了分或没把握的题，收进错题本。';
  const work = q.attempts.flatMap(a => a.fragments);
  const attemptOf = (f: Fragment) => q.attempts.findIndex(a => a.fragments.some(x => x.fragmentId === f.fragmentId));
  const references = materials.filter(f => f.role === 'reference_answer');
  const others = materials.filter(f => f.role === 'unknown' || ((f.role === 'student_work' || f.role === 'correction') && attemptOf(f) < 0));
  const status = [q.subject?.trim() || '学科待定', q.itemId && included !== false ? '已收录' : included === false ? '已移出错题本' : '未收录',
    q.missing.length ? '缺' + q.missing.map(x => missingNames[x]).join('、') : '', q.unresolved.length ? '归属待确定' : ''].filter(Boolean).join(' · ');
  const conflictInContent = q.answerConflict && !selectedAnswerIds.some(id => q.answers.some(a => a.id === id && !a.stale));
  return (
    <Page title="题目材料" back={{ href: '/s/materials', label: '我的材料' }} flash={{ ok: notice }} bar={{ caption, primary, secondary: [] }}>
      <div className="material-surface" data-draft-namespace={namespace}>
        <h1>{unplaced ? '没对上题号的内容' : q.number ? `第 ${q.number} 题` : '题号不清'}</h1>
        {unplaced ? null : <p className="meta-line muted" data-testid="material-question-status">{status}</p>}
        {legacy ? <p className="hint">这道旧题的学习转写沿用原识别版本；后来补充的页在这里独立保留。原题文字修正会同步到原材料转写。</p> : null}
        {offerInclusion ? <form id="inclusion-form" method="post" action={`/s/materials/questions/${q.id}/inclusion`}><Hidden namespace={namespace} revision={q.revision} /></form> : null}
        {stemMissing && !unplaced && primary?.key !== 'capture' ? (
          <div className="inset-group">
            <p className="group-pad">还没找到这道题的题目，拍到题目后才能练习。</p>
            <NavRow href={`/s/capture?questionId=${q.id}`}>补拍题目</NavRow>
          </div>
        ) : null}
        <MaterialBlock title="题目" fragments={q.stem} note={f => f.check !== 'passed' ? '识别还有不确定处，请对照原图。' : ''} />
        <MaterialBlock title="我的作答" fragments={work} note={f => [q.attempts.length > 1 ? `第 ${attemptOf(f) + 1} 次作答` : '', f.role === 'correction' ? '订正' : ''].filter(Boolean).join(' · ')} />
        <MaterialBlock title="老师批改" fragments={q.teacherMarks} />
        <AnswerSummary namespace={namespace} question={q} selected={selectedAnswerIds} references={references} />
        <MaterialBlock title={unplaced ? '这段内容' : '其他材料'} fragments={others} note={f => roleNames[f.role]} />

        <ToolGroup title="补充或调整材料" id="adjust" open={unplaced}>
          <NavRow href={`/s/capture?questionId=${q.id}`}>补充材料</NavRow>
          {q.attempts.map((a, i) => <NavRow key={a.id} href={`/s/capture?questionId=${q.id}&attemptId=${a.id}`}>补充第 {i + 1} 次作答</NavRow>)}
          {materials.length ? (
            <form method="post" action="/s/materials/links">
              <Hidden namespace={namespace} revision={revision} />
              <fieldset>
                <legend>选要调整的内容</legend>
                {materials.map(f => (
                  <label className="choice" key={f.fragmentId}>
                    <input type="checkbox" name="fragmentIds" value={f.fragmentId} defaultChecked={unplaced && materials.length === 1} />
                    <span>调整这部分材料：{roleNames[f.role]}{attemptOf(f) >= 0 && q.attempts.length > 1 ? ` · 第 ${attemptOf(f) + 1} 次作答` : ''}{f.text.trim() ? ` · ${shortText(f.text, 20)}` : ''}</span>
                  </label>
                ))}
              </fieldset>
              <label className="field-label">放到哪道题
                <select name="questionId" defaultValue={q.id}>{[q, ...questions.filter(o => o.id !== q.id)].map(o => <option key={o.id} value={o.id}>{o.id === q.id ? `${unplaced ? '先不动' : '不改，还是这道题'}` : `${questionTitle(o)}${stemFirstSentence(o, 16) ? ` · ${stemFirstSentence(o, 16)}` : ''}`}</option>)}</select>
              </label>
              <label className="field-label">继续哪次作答
                <select name="attemptId" defaultValue="">
                  <option value="">不指定作答</option>
                  {q.attempts.map((a, i) => <option key={a.id} value={a.id}>第 {i + 1} 次作答</option>)}
                </select>
              </label>
              <div className="btn-stack">
                <button className="btn" type="submit">保存关联</button>
                <button className="btn" type="submit" name="newAttempt" value="1">选中的作答另记为一次</button>
              </div>
              <p className="hint">作答或订正放到别的题时，用“另记为一次”。原来的作答仍会保留。</p>
            </form>
          ) : null}
        </ToolGroup>
        {unplaced ? null : <>
          <ToolGroup title="参考答案" open={answerJobs.some(j => active(j.state))}>
            <p className="hint">保留各自来源，不代表已经核验；输入或生成答案不会自动批改。</p>
            <NavRow href={`/s/materials/questions/${q.id}/answers`}>查看所有版本与录入时间</NavRow>
            {[['provided', '提供的参考答案'], ['ai', 'AI 参考答案']].map(([group, title]) => {
              const list = q.answers.filter(a => group === 'ai' ? a.source === 'ai' : a.source !== 'ai');
              return list.length ? (
                <div key={group}>
                  <h3>{title}</h3>
                  {list.map(a => (
                    <div key={a.id}>
                      <p>{a.source === 'manual' ? '手工输入' : a.source === 'ai' ? 'AI 生成' : a.fragmentIds.length ? '照片导入' : '粘贴导入'} · 版本 {a.revision}{a.subpart ? ` · 小问 ${a.subpart}` : ''}{a.stale ? ' · 已过期' : ''}{selectedAnswerIds.includes(a.id) ? ' · 已采用' : ''}</p>
                      <p className="pre">{a.text}</p>
                      {a.run ? <p className="hint">模型：{a.run.model} · 耗时 {a.run.durationMs} 毫秒</p> : null}
                    </div>
                  ))}
                </div>
              ) : null;
            })}
            {!conflictInContent && q.answers.some(a => !a.stale) ? <AnswerChoices namespace={namespace} question={q} selected={selectedAnswerIds} /> : null}
            <ManualAnswerForm namespace={namespace} question={q} />
            <form method="post" action="/s/materials/answers/generate">
              <Hidden namespace={namespace} />
              <input type="hidden" name="requestId" value={randomUUID()} />
              <input type="hidden" name="questionIds" value={q.id} />
              <button className="btn" type="submit">生成 AI 参考答案</button>
            </form>
            {answerJobs.map(job => (
              <div key={job.id}>
                <p>AI 参考答案：{answerJobStates[job.state]}</p>
                {['failed', 'interrupted'].includes(job.state) && (!job.error || JSON.parse(job.error).retryable) ? (
                  <form method="post" action={`/s/materials/jobs/${job.id}/retry`}>
                    <Hidden namespace={namespace} />
                    <input type="hidden" name="requestId" value={randomUUID()} />
                    <button className="btn" type="submit">重试生成参考答案</button>
                  </form>
                ) : null}
              </div>
            ))}
          </ToolGroup>
          <ToolGroup title={stemMissing ? 'AI 批改（补齐题目后可用）' : 'AI 批改'} open={gradeJobs.some(j => active(j.state))}>
            <GradePanel namespace={namespace} question={q} jobs={gradeJobs} />
          </ToolGroup>
          {q.itemId && included !== false ? (
            <ToolGroup title="错题本">
              <NavRow href={`/s/items/${q.itemId}`}>查看错题与修改转写</NavRow>
              <form method="post" action={`/s/materials/questions/${q.id}/inclusion`}>
                <Hidden namespace={namespace} revision={q.revision} />
                <button className="btn" name="included" value="false" type="submit">取消后续推荐</button>
              </form>
              <p className="hint">取消后不再推荐练习，原材料和练习历史仍保留，随时可以恢复。</p>
            </ToolGroup>
          ) : null}
        </>}
      </div>
    </Page>
  );
}

export function MaterialMatchPage({ namespace, asset, candidates, page, hasMore }: {
  namespace: string;
  asset: MaterialAssetView;
  candidates: MaterialAssetView[];
  page: number;
  hasMore: boolean;
}): ReactNode {
  return (
    <Page title="对照整页材料" back={{ href: '/s/materials', label: '我的材料' }}>
      <div className="material-surface">
        <h1>对照整页材料</h1>
        <p className="lead">这是要补充的这一页。对照下面的原图，找到同一份试卷，一次确认整页归属。</p>
        <img loading="lazy" className="crop big" src={`/s/materials/assets/${asset.id}/image`} alt="要关联的原图" />
        {candidates.map(candidate => (
          <section className="card" key={candidate.id}>
            <form method="post" action={`/s/materials/assets/${asset.id}/document`}>
              <Hidden namespace={namespace} revision={asset.link_revision} />
              <input type="hidden" name="candidateAssetId" value={candidate.id} />
              <input type="hidden" name="candidateRevision" value={candidate.link_revision} />
              <img loading="lazy" className="crop big" src={`/s/materials/assets/${candidate.id}/image`} alt="候选整页原图" />
              <p>{candidate.hints.label || '对照这张原图'}</p>
              <p className="hint break-anywhere">{candidate.fragments.map(f => f.number ? `第 ${f.number} 题 · ${roleNames[f.role]}` : roleNames[f.role]).join('；') || '尚未找到题号，请对照原图'}</p>
              <button className="btn" type="submit">和这张属于同一份试卷</button>
            </form>
          </section>
        ))}
        {page > 0 || hasMore ? (
          <div className="inset-group">
            {page > 0 ? <NavRow href={`/s/materials/assets/${asset.id}/match?page=${page - 1}`}>上一页候选</NavRow> : null}
            {hasMore ? <NavRow href={`/s/materials/assets/${asset.id}/match?page=${page + 1}`}>下一页候选</NavRow> : null}
          </div>
        ) : null}
      </div>
    </Page>
  );
}

function ManualAnswerForm({ namespace, question: q }: { namespace: string; question: QuestionBundle }): ReactNode {
  return (
    <Disclosure title="输入正确答案 / 修改手工答案">
      <form method="post" action="/s/materials/answers/manual">
        <Hidden namespace={namespace} revision={q.revision} />
        <input type="hidden" name="questionId" value={q.id} />
        <label className="field-label">小问（整题留空）<input type="text" name="subpart" maxLength={64} /></label>
        <label className="field-label">答案<textarea name="text" required maxLength={40000} /></label>
        <label className="field-label">来源说明（可不填）<input type="text" name="claimedSource" maxLength={200} /></label>
        <button className="btn" type="submit">保存手工答案</button>
      </form>
    </Disclosure>
  );
}

function BatchAnswerForms({ namespace, documents, questions }: { namespace: string; documents: { id: string; label: string | null }[]; questions: QuestionBundle[] }): ReactNode {
  return (
    <Disclosure title="批量参考答案">
      <NavRow href="/s/materials/answers/imports">查看粘贴原文与待确定条目</NavRow>
      <form method="post" action="/s/materials/answers/generate">
        <Hidden namespace={namespace} />
        <input type="hidden" name="requestId" value={randomUUID()} />
        {questions.map(q => <label className="choice" key={q.id}><input type="checkbox" name="questionIds" value={q.id} /><span>{questionTitle(q)}</span></label>)}
        <button className="btn" type="submit">为所选题生成 AI 参考答案</button>
      </form>
      {documents.length ? <>
        <form method="post" action="/s/materials/answers/generate">
          <Hidden namespace={namespace} />
          <input type="hidden" name="requestId" value={randomUUID()} />
          <select name="documentId">{documents.map((d, i) => <option key={d.id} value={d.id}>{d.label || `试卷 ${i + 1}`}</option>)}</select>
          <button className="btn" type="submit">为这份试卷生成 AI 参考答案</button>
        </form>
        <form method="post" action="/s/materials/answers/import">
          <Hidden namespace={namespace} />
          <label className="field-label">答案属于哪份试卷
            <select name="documentId">{documents.map((d, i) => <option key={d.id} value={d.id}>{d.label || `试卷 ${i + 1}`}</option>)}</select>
          </label>
          <label className="field-label">按行粘贴，例如 12(a): 答案<textarea name="text" required maxLength={40000} /></label>
          <p className="hint">只按完整题号和小问匹配；无法确定的保留原文，不会猜配。</p>
          <button className="btn" type="submit">导入文字答案</button>
        </form>
      </> : <p>批量粘贴前，请先在下方确认答案所属试卷；单题可直接输入。</p>}
    </Disclosure>
  );
}

/** After a request from one question, the task is to look at that question again; otherwise just go back. */
function backToQuestion(questionId: string | undefined, title: string): BarButton | null {
  return questionId ? { title, key: 'question', href: `/s/materials/questions/${questionId}` } : null;
}

export function MaterialAnswerActionPage({ namespace, action, imported, questionId }: { namespace: string; action?: BatchAction; imported?: { saved: ReferenceAnswer[]; pending: { number: string; text: string }[] }; questionId?: string }): ReactNode {
  const primary = backToQuestion(questionId, '查看这道题的参考答案');
  return (
    <Page title="参考答案处理" back={{ href: '/s/materials', label: '我的材料' }} bar={primary ? { caption: '没有自动批改。', primary, secondary: [] } : null}>
      <div className="material-surface" data-draft-namespace={namespace}>
        <h1>参考答案处理</h1>
        {action ? <>
          <p>已接收或复用 {action.jobs.length} 道题。</p>
          {action.jobs.map(j => <p key={j.id}>任务状态：{answerJobStates[j.state] ?? j.state}</p>)}
          {action.skipped.map(s => (
            <section key={s.questionId}>
              <div className="inset-group"><NavRow href={`/s/materials/questions/${s.questionId}`}>查看未处理题目</NavRow></div>
              <p className="group-footer">{s.reason}</p>
            </section>
          ))}
        </> : null}
        {imported ? <>
          <p>已保存 {imported.saved.length} 条粘贴导入答案。</p>
          <h2 className="group-label">待确定的原文</h2>
          {imported.pending.map((p, i) => <p className="pre" key={i}>{p.text}</p>)}
        </> : null}
        {primary ? null : <p className="hint">没有自动批改。生成好的答案会出现在各题的“参考答案”里。</p>}
      </div>
    </Page>
  );
}

export function MaterialAnswerHistoryPage({ questionId, history, page }: { questionId: string; history: { answer: ReferenceAnswer; createdAt: string }[]; page: number }): ReactNode {
  return (
    <Page title="答案版本记录" back={{ href: `/s/materials/questions/${questionId}`, label: '返回题目' }}>
      <div className="material-surface">
        <h1>答案版本记录</h1>
        <p className="hint">历史版本和真实来源会保留。</p>
        {history.map(({ answer: a, createdAt }) => (
          <section className="card" key={`${a.id}:${a.revision}`}>
            <p>{a.source === 'ai' ? 'AI 参考答案' : a.source === 'manual' ? '手工输入' : a.fragmentIds.length ? '照片导入' : '粘贴导入'} · 版本 {a.revision}{a.stale ? ' · 已过期' : ''}</p>
            <p className="hint">{createdAt} UTC{a.run ? ` · 模型 ${a.run.model}` : ''}</p>
            {a.claimedSource ? <p>填写者说明：{a.claimedSource}（未经核验）</p> : null}
            <p className="pre">{a.text}</p>
          </section>
        ))}
        {page > 0 || history.length === 20 ? (
          <div className="inset-group">
            {page > 0 ? <NavRow href={`?page=${page - 1}`}>上一页</NavRow> : null}
            {history.length === 20 ? <NavRow href={`?page=${page + 1}`}>下一页</NavRow> : null}
          </div>
        ) : null}
      </div>
    </Page>
  );
}

export function MaterialImportHistoryPage({ imports, page }: { imports: { original_text: string; pending_json: string; created_at: string }[]; page: number }): ReactNode {
  return (
    <Page title="粘贴导入记录" back={{ href: '/s/materials', label: '我的材料' }}>
      <div className="material-surface">
        <h1>粘贴导入记录</h1>
        <p className="hint">未确定的答案保留原文，可按题单独填写。</p>
        {imports.map((record, i) => (
          <section className="card" key={i}>
            <p>{record.created_at} UTC · 粘贴导入，未经核验</p>
            <h2>待确定</h2>
            {(JSON.parse(record.pending_json) as { text: string }[]).map((p, n) => <p className="pre" key={n}>{p.text}</p>)}
            <Disclosure title="完整原文"><p className="pre">{record.original_text}</p></Disclosure>
          </section>
        ))}
        {page > 0 || imports.length === 20 ? (
          <div className="inset-group">
            {page > 0 ? <NavRow href={`?page=${page - 1}`}>上一页</NavRow> : null}
            {imports.length === 20 ? <NavRow href={`?page=${page + 1}`}>下一页</NavRow> : null}
          </div>
        ) : null}
      </div>
    </Page>
  );
}

const gradeStates: Record<string, string> = { queued: '等待批改', running: '正在批改', succeeded: '批改建议已保存', failed: '批改未完成', interrupted: '批改已中断', stale: '批改依据已过期' };

function GradePanel({ namespace, question: q, jobs }: { namespace: string; question: QuestionBundle; jobs: { id: string; state: string; error: string | null }[] }): ReactNode {
  return (
    <>
      <p className="hint">只在你点击后批改。没有参考答案时，本次会先生成并单独保存 AI 参考答案。不会修改原作、反思或掌握状态。</p>
      <p className="hint">只有题干中明确的评分条件与分值才支持计分；老师批改痕迹单独保留。</p>
      {!q.grades.length ? <p>未批改</p> : null}
      {q.grades.map(g => (
        <div key={g.id}>
          <p>第 {q.attempts.findIndex(a => a.id === g.attemptId) + 1} 次作答 · AI 建议：{({ correct: '正确', partial: '部分正确', incorrect: '错误', uncertain: '无法确定' })[g.result]}{g.stale ? ' · 依据已过期' : ''}</p>
          {g.findings.map((f, i) => <p key={i}>{f.text}</p>)}
          <p>{g.score ? `得分建议 ${g.score.earned} / ${g.score.total}` : '未提供精确分数'}</p>
          <p className="hint">依据：{g.answerIds.map(id => q.answers.find(a => a.id === id)?.source === 'ai' ? 'AI 参考答案' : '提供的参考答案').join('、')} · 模型 {g.run.model}</p>
        </div>
      ))}
      {jobs.map(j => (
        <div key={j.id}>
          <p>{gradeStates[j.state]}</p>
          {['failed', 'interrupted'].includes(j.state) && (!j.error || JSON.parse(j.error).retryable) ? (
            <form method="post" action={`/s/materials/jobs/${j.id}/retry`}>
              <Hidden namespace={namespace} />
              <input type="hidden" name="requestId" value={randomUUID()} />
              <button className="btn" type="submit">重试本次批改</button>
            </form>
          ) : null}
        </div>
      ))}
      <form method="post" action="/s/materials/grades">
        <Hidden namespace={namespace} />
        <input type="hidden" name="requestId" value={randomUUID()} />
        <input type="hidden" name="questionIds" value={q.id} />
        <label className="field-label">批改哪次作答
          <select name="attemptId" defaultValue={q.attempts.length === 1 ? q.attempts[0]!.id : ''}>
            <option value="">请选择一次作答</option>
            {q.attempts.map((a, i) => <option key={a.id} value={a.id}>第 {i + 1} 次作答</option>)}
          </select>
        </label>
        <button className="btn" type="submit">帮我批改</button>
      </form>
      <NavRow href={`/s/materials/questions/${q.id}`}>刷新批改状态</NavRow>
    </>
  );
}

function BatchGradeForms({ namespace, documents, questions }: { namespace: string; documents: { id: string; label: string | null }[]; questions: QuestionBundle[] }): ReactNode {
  return (
    <Disclosure title="批量帮我批改">
      <p>只处理材料完整且作答、答案依据明确的题；多次作答请到题目页选择。</p>
      <form method="post" action="/s/materials/grades">
        <Hidden namespace={namespace} />
        <input type="hidden" name="requestId" value={randomUUID()} />
        {questions.map(q => <label className="choice" key={q.id}><input type="checkbox" name="questionIds" value={q.id} /><span>{questionTitle(q)}</span></label>)}
        <button className="btn" type="submit">批改所选题</button>
      </form>
      {documents.length ? (
        <form method="post" action="/s/materials/grades">
          <Hidden namespace={namespace} />
          <input type="hidden" name="requestId" value={randomUUID()} />
          <select name="documentId">{documents.map((d, i) => <option key={d.id} value={d.id}>{d.label || `试卷 ${i + 1}`}</option>)}</select>
          <button className="btn" type="submit">批改这份试卷</button>
        </form>
      ) : null}
    </Disclosure>
  );
}

export function MaterialGradeActionPage({ namespace, action, questionId }: { namespace: string; action: BatchAction; questionId?: string }): ReactNode {
  const primary = backToQuestion(questionId, '查看这道题的批改');
  return (
    <Page title="批改请求" back={{ href: '/s/materials', label: '我的材料' }} bar={primary ? { caption: 'AI 建议单独保存，刷新不会发起新批改。', primary, secondary: [] } : null}>
      <div className="material-surface" data-draft-namespace={namespace}>
        <h1>批改请求</h1>
        <p>已接收或复用 {action.jobs.length} 道题。</p>
        {action.jobs.map(j => <p key={j.id}>{gradeStates[j.state]}</p>)}
        {action.skipped.map(s => (
          <section key={s.questionId}>
            <div className="inset-group"><NavRow href={`/s/materials/questions/${s.questionId}`}>查看未批改题目</NavRow></div>
            <p className="group-footer">{s.reason}</p>
          </section>
        ))}
        {primary ? null : <p className="hint">AI 建议单独保存，刷新不会发起新批改。结果会出现在各题的“AI 批改”里。</p>}
      </div>
    </Page>
  );
}
