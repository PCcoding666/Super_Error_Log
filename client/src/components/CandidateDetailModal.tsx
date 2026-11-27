import { IonButton, IonButtons, IonCheckbox, IonContent, IonHeader, IonModal, IonSpinner, IonTitle, IonToolbar } from '@ionic/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { IntakeCandidateDetail, IntakeCandidateFragment } from '../../../src/web/apiTypes';
import { originalImageUrl, withDisplaySize } from '../../../src/web/materialImageUrls';
import { detailLead } from '../lib/intakeVerdict';
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
      if (!text || text.includes('不确定') || /^[a-z0-9_]+$/i.test(text) || notes.includes(text)) continue;
      notes.push(text);
    }
  }
  return notes;
}

function questionText(stem: IntakeCandidateFragment[]): string {
  return stem.filter(fragment => fragment.role === 'question').map(fragment => fragment.text.trim()).filter(Boolean).join('\n\n');
}

/** The list already painted `preview`. The detail URL is the same crop at `s=big`, swapped in after it loads. */
function QuestionCrop(props: { preview: string | null; detail: string | null; pending: boolean }): ReactNode {
  const detail = withDisplaySize(props.detail, 'big');
  const [src, setSrc] = useState(props.preview ?? detail);
  useEffect(() => { setSrc(props.preview ?? detail); }, [props.preview, detail]);
  useEffect(() => {
    if (!detail || !props.preview || detail === props.preview) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => { if (!cancelled) setSrc(detail); };
    image.src = detail;
    return () => { cancelled = true; };
  }, [detail, props.preview]);
  if (!src) return props.pending ? null : <p className="muted">没有题目裁图。</p>;
  return <figure><figcaption>题目裁图</figcaption><img src={src} alt="题目裁图" /></figure>;
}

/** The source page stays in the sheet at display size. It is fetched on tap, or after the sheet is scrolled. */
function SourceFigure(props: { url: string; defer: boolean }): ReactNode {
  const display = withDisplaySize(props.url, 'big');
  const original = originalImageUrl(display);
  const [open, setOpen] = useState(!props.defer);
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => { setOpen(!props.defer); }, [display, props.defer]);
  useEffect(() => {
    if (!props.defer || open) return;
    const content = ref.current?.closest('ion-content') as (HTMLElement & { getScrollElement?: () => Promise<HTMLElement> }) | null;
    if (!content?.getScrollElement) return;
    let scrollEl: HTMLElement | null = null;
    let initial = 0;
    let disposed = false;
    const onScroll = () => { if (scrollEl && scrollEl.scrollTop > initial + 24) setOpen(true); };
    void content.getScrollElement().then(element => {
      if (disposed) return;
      scrollEl = element;
      initial = element.scrollTop;
      element.addEventListener('scroll', onScroll, { passive: true });
    }).catch(() => undefined);
    return () => { disposed = true; scrollEl?.removeEventListener('scroll', onScroll); };
  }, [props.defer, open, display]);
  if (!display) return null;
  return <figure ref={ref}>
    <figcaption>来源页</figcaption>
    {open ? <img src={display} alt="来源页" /> : <button type="button" className="candidate-source-toggle" data-testid="candidate-source-toggle" onClick={() => setOpen(true)}>查看来源页</button>}
    {original ? <a className="candidate-source-link" href={original} target="_blank" rel="noreferrer">查看原图</a> : null}
  </figure>;
}

function Images(props: { preview?: string | null; crop: string | null; source: string | null; figures?: { crop: string }[]; deferSource?: boolean; pending?: boolean }): ReactNode {
  const figures = (props.figures ?? []).map(figure => withDisplaySize(figure.crop, 'big')).filter((url): url is string => !!url);
  const crop = withDisplaySize(props.crop, 'big');
  const preview = props.preview ?? null;
  if (!preview && !crop && !props.source && !figures.length && !props.pending) return <p className="muted">没有可看的题目图片。</p>;
  return <div className="candidate-images">
    <QuestionCrop preview={preview} detail={props.crop} pending={props.pending === true && !preview && !crop} />
    {figures.map(url => <figure key={url}><figcaption>题目图形</figcaption><img src={url} alt="题目图形" data-testid="candidate-figure" /></figure>)}
    {props.source ? <SourceFigure url={props.source} defer={props.deferSource === true} /> : null}
  </div>;
}

function Recognized(props: { detail: IntakeCandidateDetail }): ReactNode {
  const text = questionText(props.detail.stem);
  const notes = readableUncertainties(props.detail.stem);
  const lead = detailLead(props.detail.status);
  const diagram = props.detail.figures.length > 0 || props.detail.stem.some(fragment => fragment.role === 'diagram' || fragment.requiresDiagram);
  return <>
    {lead ? <p className="item-hint">{lead}</p> : null}
    <h3>题目</h3>
    {text ? <div className="item-stem candidate-stem" data-testid="candidate-stem"><StemText text={text} /></div> : <p className="muted" data-testid="candidate-stem-empty">还没有读出题目文字。</p>}
    {diagram ? <p className="muted">{props.detail.figures.length ? '这道题有图，请对照上面的题目裁图、题目图形和来源页。' : '这道题有图，请对照上面的裁图和来源页。'}</p> : null}
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
  /** Already-loaded list crop. Materials details paint this before the detail JSON returns. */
  previewCrop?: string | null;
  legacy: { crop: string | null; source: string | null } | null;
  selected: boolean;
  submitted?: boolean;
  terminal?: boolean;
  /** Right answers stay visible and are not offered for the notebook. */
  addable?: boolean;
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
        <h3>题目</h3>
        <p className="muted" data-testid="candidate-stem-empty">还没有读出题目文字。</p>
        <p className="muted" data-testid="candidate-traces-empty">还没有作答或批改记录。</p>
        <h3>已有的答案和判断</h3>
        <p className="muted" data-testid="candidate-judgment-empty">还没有答案或判断。</p>
      </> : <>
        <Images preview={props.previewCrop} crop={props.detail?.crop ?? null} source={props.detail?.source ?? null} figures={props.detail?.figures} deferSource pending={props.loading && !props.detail} />
        {props.loading && !props.detail ? <p className="muted" role="status"><IonSpinner name="lines-small" /> 正在读取这道题…</p>
          : props.error ? <p className="tone-red" role="alert" data-testid="candidate-detail-error">{props.error}</p>
            : props.detail ? <Recognized detail={props.detail} /> : null}
      </>}
      {props.addable === false ? null : <div className="candidate-select">
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
      </div>}
    </div></IonContent>
  </IonModal>;
}
