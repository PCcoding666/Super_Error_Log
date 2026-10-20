import type { ReactNode } from 'react';
import { randomUUID } from 'node:crypto';
import type { CaptureHints, Fragment, QuestionBundle } from '../../materials/contracts.js';
import { Page } from './layout.js';
export interface MaterialAssetView {
    id: string;
    hints: CaptureHints;
    document_id: string | null;
    status: string;
    link_revision: number;
    fragments: Fragment[];
}
const roleNames = { question: '题目', diagram: '图形', student_work: '我的作答', correction: '订正', teacher_mark: '老师批改', reference_answer: '参考答案', unknown: '不确定' };
const Hidden = ({ namespace, revision }: {
    namespace: string;
    revision?: number;
}) => <><input type="hidden" name="namespace" value={namespace}/>{revision !== undefined ? <input type="hidden" name="expectedRevision" value={revision}/> : null}</>;
export function HintFields(): ReactNode { return <details><summary>加个提示（可跳过）</summary><fieldset><legend>这张拍了什么？可以多选</legend>{Object.entries(roleNames).map(([value, label]) => <label className="choice" key={value}><input type="checkbox" name="roles" value={value}/><span>{label}</span></label>)}</fieldset><label className="field-label">批改情况<select name="marking" defaultValue=""><option value="">不填写</option><option value="unmarked">未批改</option><option value="marked">已批改</option><option value="partial">部分批改</option></select></label><label className="field-label">备注（可不填）<input type="text" name="label" maxLength={120}/></label><p className="hint">提示只帮助整理；选“未批改”不会开始批改。清空选项后保存，就能去掉提示。</p></details>; }
export function MaterialConsentPage({ namespace, context = {} }: {
    namespace: string;
    context?: CaptureHints;
}): ReactNode { return <Page title="上传前看一下" bar={{ caption: '第一次上传前看一下', primary: { title: '同意，上传', key: 'consent', post: '/s/consent', fields: { namespace, ...(context.questionId ? { questionId: context.questionId } : {}), ...(context.attemptId ? { attemptId: context.attemptId } : {}) } }, secondary: [{ title: '先不传', key: 'home', href: '/s/' }] }}><h1>上传前看一下</h1><section className="card"><p>照片会传到广州的云服务器，再交给阿里云百炼的 AI 识别题目、作答和答案材料。照片可能有你的名字和字迹，介意的话先遮住。</p><p>待上传的照片会暂存在这个浏览器里。退出时可以删除待传照片；服务器已保存的材料会继续留在你的错题本。</p><p>网页会尽量在上传前去掉位置等拍摄信息。关闭脚本时原文件直接上传。相册原图仍留在相册。</p><p>只有看到“照片已保存”才表示服务器收到了；关页可能暂停上传，回来后可以继续。阿里云怎么处理数据，不由这个网页决定。</p></section></Page>; }
export function MaterialCapturePage({ namespace, count, uploadId, context = {} }: {
    namespace: string;
    count: number;
    uploadId: string;
    context?: CaptureHints;
}): ReactNode { return <Page title="拍学习材料" bar={{ caption: '关页可能暂停上传，回来后可以继续。', primary: { title: '拍完了，查看材料', key: 'materials', href: '/s/materials' }, secondary: [] }}><section data-material-capture="" data-draft-namespace={namespace} data-saved-count={count}><h1>{context.questionId ? '补充材料' : '拍学习材料'}</h1>{context.questionId ? <p className="hint">从这道题继续补拍；整页上其他题目会分别整理。</p> : null}<p className="lead">题目、答题卡、作答或答案都可以拍，顺序不限，之后还能补。</p><p className="hint">整页拍全，别裁边；一页拍一张。可以继续拍，不用等识别。</p><p data-testid="photo-count">已拍 {count} 张</p><form method="post" encType="multipart/form-data" action={`/s/materials/uploads?namespace=${namespace}&uploadId=${uploadId}`} data-material-upload="">{context.questionId ? <input type="hidden" name="questionId" value={context.questionId}/> : null}{context.attemptId ? <input type="hidden" name="attemptId" value={context.attemptId}/> : null}<label className="btn primary" htmlFor="camera-input">继续拍照</label><input className="visually-hidden" id="camera-input" name="photo" type="file" accept="image/*,.heic,.heif" capture="environment"/><label className="btn" htmlFor="library-input">从相册选（可多选）</label><input className="visually-hidden" id="library-input" name="photo" type="file" accept="image/*,.heic,.heif" multiple/><HintFields /><noscript><p>未开启脚本时，每次选一张照片，再点上传。HEIC 请先存为 JPEG。</p><button className="btn primary" type="submit">上传这张照片</button></noscript></form><p role="status" data-queue-message="">还没有待上传的照片。</p><p className="hint" data-queue-warning=""/><ul className="list" data-upload-queue=""/><a className="more" href="/s/materials">查看已经保存的材料</a></section></Page>; }
function summary(q: QuestionBundle): ReactNode { return <><p>找到：{[q.stem.length ? '题目 / 图形' : '', q.attempts.some(a => a.fragments.length) ? '作答' : '', q.teacherMarks.length ? '老师批改' : ''].filter(Boolean).join('、') || '一些材料'}</p><p>{q.missing.length ? '缺少：' + q.missing.map(x => ({ stem: '题目', diagram: '图形', work: '作答' }[x])).join('、') : '主要材料已找到'}</p>{q.unresolved.length ? <p className="tone-orange">待确定：这些材料是否属于同一题或同一次作答。可对照原图调整。</p> : null}<p className="hint">{q.stem.some(f => f.check !== 'passed') ? '识别还有不确定处，请对照原图。' : '识别结果仍可修正。'} 未进行自动批改。</p></>; }
export function MaterialsPage(props: {
    namespace: string;
    questions: QuestionBundle[];
    assets: MaterialAssetView[];
    page: number;
    hasMore: boolean;
    documents: {
        id: string;
        label: string | null;
    }[];
    changes: {
        id: string;
    }[];
    jobs: {
        id: string;
        state: string;
    }[];
    revision: number;
}): ReactNode { const { namespace } = props; return <Page title="我的材料" bar={{ caption: '还可以随时补拍。', primary: { title: '继续拍照', key: 'capture', href: '/s/capture' }, secondary: [] }}><div data-draft-namespace={namespace}><h1>我的材料</h1><p>按题整理，缺的材料以后再补。没有把握的关联会留在“待确定”。</p><a className="more" href="/s/materials">刷新整理结果</a>{props.questions.map(q => <section className="card" key={q.id}><h2 className="card-title"><a href={`/s/materials/questions/${q.id}`}>{q.number ? `第 ${q.number} 题` : '待确定题号'}</a></h2>{summary(q)}<a className="more" href={`/s/capture?questionId=${q.id}`}>补充材料</a></section>)}{!props.questions.length ? <p>照片保存后会继续整理，稍后刷新就能看到。</p> : null}<h2>原图和整页归属</h2><p className="hint">只有需要调整时才选；一次调整整页，不必逐题确认。</p>{props.assets.map((a, i) => <section className="card" key={a.id}><a href={`/s/materials/assets/${a.id}/image`}><img loading="lazy" className="crop" src={`/s/materials/assets/${a.id}/image`} alt={`照片 ${i + 1} 原图`}/></a><h3>照片 {i + 1}{a.hints.label ? ` · ${a.hints.label}` : ''}</h3><p>{a.fragments.length ? '找到 ' + a.fragments.length + ' 处材料' : '正在整理或等待重试'}</p><p className="hint">{a.fragments.map(f => [f.number ? `第${f.number}题` : '题号不清', f.subpart ?? '', roleNames[f.role]].filter(Boolean).join(' ')).join('；') || '还没有可用于区分的题号或内容'}</p><details><summary>调整这页属于哪份试卷</summary><form method="post" action={`/s/materials/assets/${a.id}/document`}><Hidden namespace={namespace} revision={a.link_revision}/><label className="field-label">已有试卷<select name="documentId" defaultValue={a.document_id ?? ''}><option value="">选择一份（可不选）</option>{props.documents.map((d, n) => <option key={d.id} value={d.id}>{d.label || `试卷 ${n + 1}`}</option>)}</select></label><button className="btn" type="submit">放入这份试卷</button><button className="btn" type="submit" name="newDocument" value="1">这是新的一份试卷</button></form><a className="more" href={`/s/materials/assets/${a.id}/match`}>对照另一张原图，确认同一份试卷</a></details><details><summary>修改提示 / 批量修改</summary><form method="post" action={`/s/materials/assets/${a.id}/hints`}><Hidden namespace={namespace}/>{props.assets.filter(b => b.id !== a.id).map((b, n) => <label className="choice" key={b.id}><input type="checkbox" name="assetIds" value={b.id}/><span>同时修改照片 {props.assets.indexOf(b) + 1}</span></label>)}<HintFields /><button className="btn" type="submit">保存提示</button></form></details></section>)}{props.page > 0 ? <a className="more" href={`/s/materials?page=${props.page - 1}`}>上一页原图</a> : null}{props.hasMore ? <a className="more" href={`/s/materials?page=${props.page + 1}`}>下一页原图</a> : null}{props.jobs.map(j => <form method="post" action={`/s/materials/jobs/${j.id}/retry`} key={j.id}><Hidden namespace={namespace}/><input type="hidden" name="requestId" value={randomUUID()}/><p>有照片还没整理完，原图已保留。</p><button className="btn" type="submit">重新整理</button></form>)}{props.changes.map((c, i) => <form method="post" action={`/s/materials/links/${c.id}/undo`} key={c.id}><Hidden namespace={namespace} revision={props.revision}/><button className="link-btn" type="submit">撤销关联调整 {i + 1}</button></form>)}</div></Page>; }
export function MaterialQuestionPage({ namespace, question: q, questions, revision, materials }: {
    namespace: string;
    question: QuestionBundle;
    questions: QuestionBundle[];
    revision: number;
    materials: Fragment[];
}): ReactNode { const fragments = materials; return <Page title="题目材料" bar={{ caption: '可以对照原图修正关联。', primary: { title: '返回材料', key: 'materials', href: '/s/materials' }, secondary: [] }}><div data-draft-namespace={namespace}><h1>{q.number ? `第 ${q.number} 题` : '题目材料'}</h1>{summary(q)}<a className="btn" href={`/s/capture?questionId=${q.id}`}>补充材料</a>{q.attempts.map((a, i) => <a className="more" key={a.id} href={`/s/capture?questionId=${q.id}&attemptId=${a.id}`}>补充第 {i + 1} 次作答</a>)}<form method="post" action="/s/materials/links"><Hidden namespace={namespace} revision={revision}/>{fragments.map(f => <section className="card" key={f.fragmentId}><a href={`/s/materials/assets/${f.assetId}/image`}><img loading="lazy" className="crop" src={`/s/materials/assets/${f.assetId}/image`} alt="材料原图"/></a><p>{roleNames[f.role]}{f.role === 'reference_answer' ? '材料 · 待核验' : ''}{q.attempts.find(a => a.fragments.some(x => x.fragmentId === f.fragmentId)) ? ' · 第 ' + (q.attempts.findIndex(a => a.fragments.some(x => x.fragmentId === f.fragmentId)) + 1) + ' 次作答' : ''}</p><p className="pre">{f.text}</p><label className="choice"><input type="checkbox" name="fragmentIds" value={f.fragmentId}/><span>调整这部分材料</span></label></section>)}<details><summary>手动调整关联或另记一次作答</summary><label className="field-label">放到哪道题<select name="questionId" defaultValue={q.id}>{questions.map((other, i) => <option key={other.id} value={other.id}>{other.number ? `第 ${other.number} 题` : '题号待定'} · 材料 {i + 1}</option>)}</select></label><label className="field-label">继续哪次作答<select name="attemptId" defaultValue=""><option value="">不指定作答</option>{q.attempts.map((a, i) => <option key={a.id} value={a.id}>第 {i + 1} 次作答</option>)}</select></label><button className="btn" type="submit">保存关联</button><button className="btn" type="submit" name="newAttempt" value="1">选中的作答另记为一次</button><p className="hint">另记一次时，只选“我的作答”或“订正”。原来的作答仍会保留。</p></details></form></div></Page>; }
export function MaterialMatchPage({ namespace, asset, candidates, page, hasMore }: {
    namespace: string;
    asset: MaterialAssetView;
    candidates: MaterialAssetView[];
    page: number;
    hasMore: boolean;
}): ReactNode {
    return <Page title="对照整页材料" bar={{ caption: '对照后一次确认整页归属。', primary: { title: '返回材料', key: 'materials', href: '/s/materials' }, secondary: [] }}><h1>对照整页材料</h1><p>这是要补充的这一页：</p><img loading="lazy" className="crop big" src={`/s/materials/assets/${asset.id}/image`} alt="要关联的原图"/>{candidates.map(candidate => <section className="card" key={candidate.id}><form method="post" action={`/s/materials/assets/${asset.id}/document`}><Hidden namespace={namespace} revision={asset.link_revision}/><input type="hidden" name="candidateAssetId" value={candidate.id}/><input type="hidden" name="candidateRevision" value={candidate.link_revision}/><img loading="lazy" className="crop big" src={`/s/materials/assets/${candidate.id}/image`} alt="候选整页原图"/><p>{candidate.hints.label || '对照这张原图'}</p><p className="hint">{candidate.fragments.map(f => f.number ? `第 ${f.number} 题 · ${roleNames[f.role]}` : roleNames[f.role]).join('；') || '尚未找到题号，请对照原图'}</p><button className="btn" type="submit">和这张属于同一份试卷</button></form></section>)}{page > 0 ? <a className="more" href={`/s/materials/assets/${asset.id}/match?page=${page - 1}`}>上一页候选</a> : null}{hasMore ? <a className="more" href={`/s/materials/assets/${asset.id}/match?page=${page + 1}`}>下一页候选</a> : null}</Page>;
}
