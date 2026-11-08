import { IonButton, IonButtons, IonCheckbox, IonContent, IonHeader, IonModal, IonSpinner, IonTitle, IonToolbar } from '@ionic/react';
import type { ReactNode } from 'react';
import type { IntakeCandidateDetail, IntakeCandidateFragment } from '../../../src/web/apiTypes';
import { StemText } from './StemText';

const GRADE_RESULT: Record<IntakeCandidateDetail['grades'][number]['result'], string> = {
  correct: '正确', partial: '部分正确', incorrect: '错误', uncertain: '无法确定',
};

function answerLabel(answer: IntakeCandidateDetail['answers'][number]): string {
  if (answer.source === 'manual') return '你手填的';
  if (answer.source === 'ai') return 'AI 给的';
  return answer.fromPhoto ? '照片里的' : '粘贴的';
}

/** Machine codes stay in the API response. The page only shows words a student can read. */
function readableUncertainties(stem: IntakeCandidateFragment[]): string[] {
  const notes: string[] = [];
  for (const fragment of stem) {
    for (const item of fragment.uncertainties) {
      const text = item.trim();
      if (!text || /^[a-z0-9_]+$/i.test(text) || notes.includes(text)) continue;
      notes.push(text);
    }
  }
  return notes;
}

function questionText(stem: IntakeCandidateFragment[]): string {
  return stem.filter(fragment => fragment.role === 'question').map(fragment => fragment.text.trim()).filter(Boolean).join('\n\n');
}

/** List crops are small (`?s=list`). The review image uses the same crop without that size cap. */
function reviewImage(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, 'http://local');
    parsed.searchParams.delete('s');
    const query = parsed.searchParams.toString();
    return `${parsed.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return url;
  }
}

function Images(props: { crop: string | null; source: string | null }): ReactNode {
  const crop = reviewImage(props.crop);
  const source = reviewImage(props.source);
  if (!crop && !source) return <p className="muted">没有可看的题目图片。</p>;
  return <div className="candidate-images">
    {crop ? <figure><figcaption>题目裁图</figcaption><img src={crop} alt="题目裁图" /></figure> : <p className="muted">没有题目裁图。</p>}
    {source ? <figure><figcaption>来源页</figcaption><img src={source} alt="来源页" /></figure> : null}
  </div>;
}

function Recognized(props: { detail: IntakeCandidateDetail }): ReactNode {
  const text = questionText(props.detail.stem);
  const notes = readableUncertainties(props.detail.stem);
  const unsure = props.detail.stem.some(fragment => fragment.check !== 'passed' || fragment.uncertainties.length > 0);
  const diagram = props.detail.stem.some(fragment => fragment.role === 'diagram' || fragment.requiresDiagram);
  return <>
    {props.detail.status && props.detail.status !== 'verified' ? <p className="item-hint tone-orange">{props.detail.status === 'needs_review' ? '识别仍有不确定处，请以原图为准。' : '题目仍在识别和校验，可以先看图勾选。'}</p> : null}
    <h3>识别出的题目</h3>
    {text ? <div className="item-stem candidate-stem" data-testid="candidate-stem"><StemText text={text} /></div> : <p className="muted" data-testid="candidate-stem-empty">还没有识别出题目文字。</p>}
    {diagram ? <p className="muted">这道题有图，请对照上面的裁图和来源页。</p> : null}
    {unsure ? <p className="item-hint tone-orange" data-testid="candidate-uncertain">识别还有不确定处，请对照原图。</p> : null}
    {notes.map(note => <p key={note} className="muted">{note}</p>)}
    {props.detail.work.length ? <section data-testid="candidate-work"><h3>你写的</h3>{props.detail.work.map((line, index) => <p key={`${line.label ?? ''}-${index}`}>{line.label ? `${line.label}：` : ''}{line.text}</p>)}</section> : null}
    {props.detail.marks.length ? <section data-testid="candidate-mark"><h3>批改痕迹</h3>{props.detail.marks.map((line, index) => <p key={index}>{line.text}</p>)}</section> : null}
    {!props.detail.work.length && !props.detail.marks.length ? <p className="muted" data-testid="candidate-traces-empty">还没有作答或批改记录。</p> : null}
    <h3>已有的答案和判断</h3>
    {props.detail.answers.map((answer, index) => <section key={`${answer.source}-${index}`} data-testid="candidate-answer">
      <p>{answerLabel(answer)}{answer.stale ? <span className="candidate-stale"> · 依据已过期</span> : null}</p>
      <div className="candidate-stem"><StemText text={answer.text} /></div>
      {answer.claimedSource ? <p className="muted">来源：{answer.claimedSource}</p> : null}
    </section>)}
    {props.detail.grades.map((grade, index) => <section key={index} data-testid="candidate-grade">
      <p>判断：{GRADE_RESULT[grade.result]}{grade.stale ? <span className="candidate-stale"> · 依据已过期</span> : null}{grade.score ? ` · ${grade.score.earned} / ${grade.score.total} 分` : ''}</p>
      {grade.findings.map(finding => <p key={finding}>{finding}</p>)}
    </section>)}
    {!props.detail.answers.length && !props.detail.grades.length ? <p className="muted" data-testid="candidate-judgment-empty">还没有答案或判断。</p> : null}
  </>;
}

/** Review one intake candidate. Opening this does not select or save it. */
export function CandidateDetailModal(props: {
  open: boolean;
  title: string;
  loading: boolean;
  error: string | null;
  detail: IntakeCandidateDetail | null;
  legacy: { crop: string | null; source: string | null } | null;
  selected: boolean;
  submitted?: boolean;
  terminal?: boolean;
  onToggleSelected: (selected: boolean) => void;
  /** Hide the sheet. Scroll is restored from `onClosed`, after the sheet has finished leaving. */
  onRequestClose: () => void;
  onClosed: () => void;
}): ReactNode {
  const showLegacy = props.legacy !== null;
  return <IonModal isOpen={props.open} onDidDismiss={props.onClosed} data-testid="candidate-detail-sheet">
    <IonHeader><IonToolbar>
      <IonTitle>查看详情</IonTitle>
      <IonButtons slot="end"><IonButton strong onClick={props.onRequestClose} data-testid="candidate-detail-close">完成</IonButton></IonButtons>
    </IonToolbar></IonHeader>
    <IonContent><div className="candidate-detail">
      <h2>{props.title}</h2>
      {showLegacy ? <>
        <Images crop={props.legacy!.crop} source={props.legacy!.source} />
        <h3>识别出的题目</h3>
        <p className="muted" data-testid="candidate-stem-empty">还没有识别出题目文字。</p>
        <p className="muted" data-testid="candidate-traces-empty">还没有作答或批改记录。</p>
        <h3>已有的答案和判断</h3>
        <p className="muted" data-testid="candidate-judgment-empty">还没有答案或判断。</p>
      </> : props.loading ? <p className="muted" role="status"><IonSpinner name="lines-small" /> 正在读取这道题…</p>
        : props.error ? <p className="tone-red" role="alert" data-testid="candidate-detail-error">{props.error}</p>
          : props.detail ? <>
            <Images crop={props.detail.crop} source={props.detail.source} />
            <Recognized detail={props.detail} />
          </> : null}
      <div className="candidate-select">
        <IonCheckbox
          checked={props.selected}
          disabled={props.submitted}
          aria-label="勾选这道题"
          data-testid="detail-select"
          onIonChange={event => { if (event.detail.checked !== props.selected) props.onToggleSelected(event.detail.checked); }}
        />
        <div>
          <b>勾选这道题</b>
          <p className="muted">{props.submitted ? (props.terminal && props.detail?.status !== 'verified' ? '已保存选择，但暂未收录。请重试或补拍清楚的照片。' : '已保存选择，校验通过后会加入错题本。') : '只是勾选，还不会加入错题本。'}</p>
        </div>
      </div>
    </div></IonContent>
  </IonModal>;
}
