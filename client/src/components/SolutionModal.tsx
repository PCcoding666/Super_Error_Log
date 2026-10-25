import { IonButton, IonButtons, IonContent, IonHeader, IonModal, IonTitle, IonToolbar } from '@ionic/react';
import { lazy, Suspense, type ReactNode } from 'react';
import type { ItemAnswerPhoto, ItemInsight, ItemTrace } from '../../../src/web/apiTypes';
import { FigureFrame } from './FigureFrame';

const Markdown = lazy(() => import('./Markdown'));
/** 公式渲染器按需加载；加载前先显示原文。 */
export function Md(props: { text: string; inline?: boolean }): ReactNode {
  return <Suspense fallback={<div className="md md-fallback">{props.text}</div>}><Markdown text={props.text} inline={props.inline} /></Suspense>;
}

const PHOTO_STATUS: Record<ItemAnswerPhoto['status'], string> = { reading: '正在找这道题的答案…', done: '', not_found: '照片里没找到这道题的答案，可以自己填。', failed: '没认出来，可以重新识别或自己填。' };

/** 正确答案：照片里资料自带的答案、学生拍照录入的答案，再是 AI 的答案、解题过程和交互图。 */
export function SolutionModal(props: {
  open: boolean;
  onClose: () => void;
  insight: ItemInsight | null;
  sourceAnswers: ItemTrace[];
  answerPhotos: ItemAnswerPhoto[];
  /** 识别结果能改时才有。 */
  onEditSource?: (trace: ItemTrace) => void;
  onViewPhoto: (photo: ItemAnswerPhoto) => void;
  onEditPhoto: (photo: ItemAnswerPhoto) => void;
  onRetryPhoto: (photo: ItemAnswerPhoto) => void;
  onDeletePhoto: (photo: ItemAnswerPhoto) => void;
  onRetryInsight: () => void;
}): ReactNode {
  const { insight } = props;
  const ready = insight?.state === 'ready' ? insight : null;
  return <IonModal isOpen={props.open} onDidDismiss={props.onClose} data-testid="solution-sheet">
    <IonHeader><IonToolbar>
      <IonTitle>正确答案</IonTitle>
      <IonButtons slot="end"><IonButton strong onClick={props.onClose} data-testid="solution-close">完成</IonButton></IonButtons>
    </IonToolbar></IonHeader>
    <IonContent><div className="solution">
      {props.sourceAnswers.length ? <section>
        <h3>照片里的参考答案</h3>
        {props.sourceAnswers.map(trace => <div key={trace.id} className="trace-entry">
          <pre>{trace.text}</pre>
          {props.onEditSource ? <IonButton size="small" fill="clear" onClick={() => props.onEditSource!(trace)}>改</IonButton> : null}
        </div>)}
      </section> : null}
      {props.answerPhotos.length ? <section data-testid="answer-photos">
        <h3>你拍的答案</h3>
        {props.answerPhotos.map(photo => <div key={photo.id} className="answer-photo" data-testid="answer-photo">
          <button type="button" className="answer-photo-thumb" onClick={() => props.onViewPhoto(photo)} aria-label="查看答案照片"><img src={photo.imageUrl} alt="答案照片" /></button>
          <div className="answer-photo-body">
            {photo.status === 'done' && photo.text ? <Md text={photo.text} /> : <p className="muted">{PHOTO_STATUS[photo.status]}</p>}
            <div>
              {photo.status !== 'reading' ? <IonButton size="small" fill="clear" onClick={() => props.onEditPhoto(photo)}>{photo.status === 'done' ? '改' : '自己填'}</IonButton> : null}
              {photo.status === 'failed' || photo.status === 'not_found' ? <IonButton size="small" fill="clear" onClick={() => props.onRetryPhoto(photo)}>重新识别</IonButton> : null}
              <IonButton size="small" fill="clear" color="danger" onClick={() => props.onDeletePhoto(photo)}>删除</IonButton>
            </div>
          </div>
        </div>)}
      </section> : null}
      {ready ? <>
        <p className="solution-badge">AI 解答，仅供参考</p>
        {ready.warnings.map(warning => <p key={warning} className="item-hint tone-orange">{warning}</p>)}
        <section data-testid="solution-answer"><h3>答案</h3><Md text={ready.answer} /></section>
        {ready.figureUrl ? <section><h3>看图理解</h3><FigureFrame src={ready.figureUrl} /></section> : null}
        <section data-testid="solution-steps"><h3>解题过程</h3><Md text={ready.solution} /></section>
      </> : insight?.state === 'failed' ? <div className="insight-failed">
        <p>{insight.message}</p>
        {insight.retryable ? <IonButton size="small" onClick={props.onRetryInsight} data-testid="insight-retry-sheet">重试</IonButton> : null}
      </div> : insight?.state === 'unavailable' ? <p className="muted">{insight.message}</p> : <p className="muted">AI 解答稍后就好。</p>}
    </div></IonContent>
  </IonModal>;
}
