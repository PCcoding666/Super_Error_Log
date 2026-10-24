import {
  IonActionSheet, IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonList, IonModal, IonPage, IonPopover, IonSelect, IonSelectOption,
  IonSpinner, IonTextarea, IonTitle, IonToast, IonToolbar,
} from '@ionic/react';
import { chevronBack, ellipsisHorizontal } from 'ionicons/icons';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Problem } from '../components/Problem';
import type { ItemImage, ItemInsight, ItemTrace } from '../../../src/web/apiTypes';
import { StemText } from '../components/StemText';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';

const Markdown = lazy(() => import('../components/Markdown'));
/** 公式渲染器按需加载；加载前先显示原文。 */
function Md(props: { text: string; inline?: boolean }): ReactNode {
  return <Suspense fallback={<div className="md md-fallback">{props.text}</div>}><Markdown text={props.text} inline={props.inline} /></Suspense>;
}

const POLL_MS = 2500;
/** 模型最长要 90 秒，主通道失败还可能走备用：最多等 200 秒左右就不再问，免得一直转。 */
const MAX_POLLS = 80;
const REMARK_STATUS = { idle: '', saving: '保存中…', saved: '已保存', failed: '没保存上，检查网络后再改一下。' } as const;

/**
 * 题目详情：照片（点开是应用内大图，左上角返回）、题干，下面五块：
 * 你写的、批改痕迹（点开看转写）；章节与知识点（点按修改分类）；正确答案（AI 参考答案与 Markdown 解题过程）；错因（AI 推测 + 学生自己的备注）。
 * 右上角「…」里是修改分类、材料来源、移除。
 */
export function ItemPage(): ReactNode {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, error, reload } = useLoad(() => api.item(id), [id]);
  const [sheet, setSheet] = useState<'confirm' | null>(null);
  const [editing, setEditing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [values, setValues] = useState<{ grade: string; subject: string; chapter: string } | null>(null);
  // 正在编辑的学段 × 学科对应的章节候选；换了学段或学科，原来填的章节若不在新候选里就清空，免得把数学章节存成物理的。
  const chapters = values ? data?.category.chapterOptions.find(option => option.grade === values.grade && option.subject === values.subject)?.chapters ?? [] : [];
  const retarget = (next: { grade: string; subject: string; chapter: string }): void => {
    const options = data?.category.chapterOptions.find(option => option.grade === next.grade && option.subject === next.subject)?.chapters ?? [];
    setValues(options.includes(next.chapter) ? next : { ...next, chapter: '' });
  };
  const [traces, setTraces] = useState<{ title: string; entries: ItemTrace[] } | null>(null);
  const [solutionOpen, setSolutionOpen] = useState(false);
  const [menuEvent, setMenuEvent] = useState<Event | null>(null);
  // 大图：关闭时只收起弹层、保留 viewing，收起动画里图片不会先消失。
  const [viewing, setViewing] = useState<ItemImage | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);

  // AI 解答：打开详情页时还没有就请求一次（服务器有缓存，不会重复调用模型）；生成中定时问，离开页面就停。
  const [insight, setInsight] = useState<ItemInsight | null>(null);
  const requestedFor = useRef('');
  const polls = useRef(0);
  useEffect(() => { if (data) setInsight(data.insight); }, [data]);
  const startInsight = useCallback((): void => {
    polls.current = 0;
    setInsight({ state: 'generating' });
    api.requestInsight(id).then(setInsight, () => setInsight({ state: 'failed', message: '暂时连不上，稍后再试。', retryable: true }));
  }, [id]);
  useEffect(() => {
    if (insight?.state === 'none' && requestedFor.current !== id) { requestedFor.current = id; startInsight(); return; }
    if (insight?.state !== 'generating') return;
    if (polls.current >= MAX_POLLS) { setInsight({ state: 'failed', message: 'AI 还没解完，过一会儿再回来看。', retryable: true }); return; }
    const timer = setTimeout(() => {
      polls.current += 1;
      // 网络抖一下就换一个新对象，让这个 effect 再排下一轮。
      api.insight(id).then(setInsight, () => setInsight({ state: 'generating' }));
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [insight, id, startInsight]);

  // 备注：停笔 1 秒或离开输入框就存；一次只发一个请求，按顺序存，最后存下的就是最后写的。
  const [remark, setRemark] = useState('');
  const [remarkStatus, setRemarkStatus] = useState<keyof typeof REMARK_STATUS>('idle');
  const remarkFor = useRef('');
  const savedRemark = useRef('');
  const pendingRemark = useRef<string | null>(null);
  const remarkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remarkChain = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!data || remarkFor.current === id) return;
    remarkFor.current = id;
    setRemark(data.remark.text);
    savedRemark.current = data.remark.text;
  }, [data, id]);
  const saveRemark = useCallback((text: string): void => {
    if (remarkTimer.current) { clearTimeout(remarkTimer.current); remarkTimer.current = null; }
    pendingRemark.current = null;
    remarkChain.current = remarkChain.current.then(async () => {
      if (text === savedRemark.current) return;
      setRemarkStatus('saving');
      try { savedRemark.current = (await api.remark(id, text)).remark.text; setRemarkStatus('saved'); }
      catch { setRemarkStatus('failed'); }
    });
  }, [id]);
  const editRemark = (text: string): void => {
    setRemark(text);
    pendingRemark.current = text;
    if (remarkTimer.current) clearTimeout(remarkTimer.current);
    remarkTimer.current = setTimeout(() => saveRemark(text), 1000);
  };
  // 离开页面时还有没存的就补发一次。
  useEffect(() => () => { if (pendingRemark.current !== null) saveRemark(pendingRemark.current); }, [saveRemark]);

  const remove = async (): Promise<void> => {
    try { await api.discard([id]); navigate(-1); }
    catch (caught) { setToast(caught instanceof Error ? caught.message : '没有移除'); }
  };
  const save = async (): Promise<void> => {
    if (!values) return;
    try { await api.category(id, values); setEditing(false); setToast('分类已更新'); await reload(); }
    catch (caught) { setToast(caught instanceof Error ? caught.message : '没保存成功'); }
  };
  const editCategory = (): void => {
    setValues(data ? { grade: data.category.grade, subject: data.category.subject, chapter: data.category.chapter } : null);
    setEditing(true);
  };
  const item = data?.item;
  const working = !insight || insight.state === 'none' || insight.state === 'generating';
  const ready = insight?.state === 'ready' ? insight : null;
  const canOpenSolution = !!ready || !!data?.sourceAnswers.length;
  const traceRow = (title: string, entries: ItemTrace[], testId: string): ReactNode => entries.length
    ? <IonItem button detail onClick={() => setTraces({ title, entries })} data-testid={testId}><IonLabel>{title}</IonLabel></IonItem>
    : <IonItem data-testid={testId}><IonLabel>{title}</IonLabel><IonLabel slot="end" className="muted">没识别到</IonLabel></IonItem>;
  const insightStatus = (): ReactNode => working
    ? <span className="item-working"><IonSpinner name="dots" /> AI 正在解这道题…</span>
    : insight?.state === 'unavailable' || insight?.state === 'failed' ? <span className="muted">{insight.message}</span> : null;
  return <IonPage>
    <IonHeader className="plain-header ion-no-border">
      <IonToolbar>
        <IonButtons slot="start"><IonBackButton defaultHref="/" text="" data-testid="back-link" /></IonButtons>
        <IonButtons slot="end"><IonButton aria-label="更多" data-testid="item-more" onClick={event => setMenuEvent(event.nativeEvent)}><IonIcon icon={ellipsisHorizontal} slot="icon-only" /></IonButton></IonButtons>
      </IonToolbar>
    </IonHeader>
    <IonContent fullscreen className="item">
      <IonPopover isOpen={menuEvent !== null} event={menuEvent ?? undefined} onDidDismiss={() => setMenuEvent(null)} dismissOnSelect side="bottom" alignment="end">
        <IonList lines="none">
          <IonItem button detail={false} onClick={editCategory}><IonLabel>修改分类</IonLabel></IonItem>
          {data?.materialUrl ? <IonItem button detail={false} href={data.materialUrl}><IonLabel>查看材料与批改来源</IonLabel></IonItem> : null}
          {data?.canDiscard ? <IonItem button detail={false} onClick={() => setSheet('confirm')}><IonLabel color="danger">不是错题，移除</IonLabel></IonItem> : null}
        </IonList>
      </IonPopover>
      {error ? <Problem message={error.message} onRetry={() => void reload()} /> : null}
      {data && item ? <>
        <h1 className="item-title">{item.chapter}</h1>
        <p className="item-subtitle" data-testid="item-category">{[item.shortId, item.grade, item.subject].filter(Boolean).join(' · ')}</p>
        {data.images.map(image => <button key={image.url} type="button" className="item-photo" onClick={() => { setViewing(image); setViewerOpen(true); }} aria-label={`${image.title}，查看大图`} data-testid="item-photo"><img src={image.url} alt={image.title} /></button>)}
        <div className="item-stem" data-testid="question-text"><StemText text={data.questionText || '还没有可读的识别文字，请打开上方原图查看。'} /></div>
        {data.badge === 'low' ? <p className="item-hint tone-orange">字可能认错了，以照片为准。</p> : null}

        <IonList inset lines="full" className="item-rows">
          {traceRow('你写的', data.work, 'item-work')}
          {traceRow('批改痕迹', data.marking, 'item-marking')}
        </IonList>

        <h2 className="item-section-title">章节与知识点</h2>
        <IonList inset lines="none" className="item-section">
          <IonItem button detail onClick={editCategory} data-testid="item-chapter">
            <IonLabel className="ion-text-wrap">
              <div className="item-chapter-name">{data.category.chapter}</div>
              <div className="item-tags" data-testid="item-tags">
                {item.knowledgeTags.length ? item.knowledgeTags.map(tag => <span key={tag} className="item-tag">{tag}</span>) : <span className="muted">还没有知识点</span>}
              </div>
            </IonLabel>
          </IonItem>
        </IonList>

        <h2 className="item-section-title">正确答案</h2>
        <IonList inset lines="none" className="item-section">
          <IonItem button={canOpenSolution} detail={canOpenSolution} onClick={canOpenSolution ? () => setSolutionOpen(true) : undefined} data-testid="item-answer">
            <IonLabel className="ion-text-wrap">
              {ready ? <>查看答案和解题过程<p>AI 参考，未经老师核验</p></> : data.sourceAnswers.length ? <>查看照片里的参考答案<p>{insightStatus()}</p></> : insightStatus()}
            </IonLabel>
            {insight?.state === 'failed' && insight.retryable ? <IonButton slot="end" fill="clear" onClick={event => { event.stopPropagation(); startInsight(); }} data-testid="insight-retry">重试</IonButton> : null}
          </IonItem>
        </IonList>

        <h2 className="item-section-title">错因（备注）</h2>
        <IonList inset lines="full" className="item-section">
          <IonItem data-testid="item-mistake">
            <IonLabel className="ion-text-wrap">
              <p className="item-field-label">AI 推测{ready?.cause ? ` · ${ready.cause}` : ''}</p>
              {ready ? ready.mistake ? <Md text={ready.mistake} inline /> : <span className="muted">没识别到你的作答，推测不了；可以自己记在下面。</span> : insightStatus()}
            </IonLabel>
          </IonItem>
          <IonItem lines="none">
            <IonTextarea label="我的备注" labelPlacement="stacked" autoGrow rows={2} maxlength={1000} placeholder="自己记一下：错在哪、下次注意什么" value={remark}
              onIonInput={event => editRemark(String(event.detail.value ?? ''))} onIonBlur={() => saveRemark(remark)} data-testid="item-remark" />
          </IonItem>
        </IonList>
        <p className="item-remark-status muted" data-testid="remark-status" aria-live="polite">{REMARK_STATUS[remarkStatus]}</p>
        {data.canDiscard ? <IonButton fill="clear" color="danger" expand="block" className="item-remove" onClick={() => setSheet('confirm')} data-testid="discard">不是错题，移除</IonButton> : null}
      </> : null}
      <IonModal isOpen={viewerOpen} onDidDismiss={() => setViewerOpen(false)} className="photo-viewer" data-testid="photo-viewer">
        <IonHeader className="ion-no-border"><IonToolbar>
          <IonButtons slot="start"><IonButton aria-label="返回" data-testid="photo-back" onClick={() => setViewerOpen(false)}><IonIcon icon={chevronBack} slot="icon-only" /></IonButton></IonButtons>
          <IonTitle>{viewing?.title}</IonTitle>
        </IonToolbar></IonHeader>
        <IonContent>
          {viewing ? <div className="photo-viewer-body"><img src={viewing.fullUrl} alt={viewing.title} /></div> : null}
        </IonContent>
      </IonModal>
      <IonModal isOpen={traces !== null} onDidDismiss={() => setTraces(null)} initialBreakpoint={0.6} breakpoints={[0, 0.6, 1]} expandToScroll={false} data-testid="trace-sheet">
        <IonContent><div className="note-sheet">
          <h2>{traces?.title}</h2>
          {traces?.entries.map((entry, index) => <section key={index}>{entry.label ? <h3>{entry.label}</h3> : null}<pre>{entry.text}</pre></section>)}
        </div></IonContent>
      </IonModal>
      <IonModal isOpen={solutionOpen} onDidDismiss={() => setSolutionOpen(false)} data-testid="solution-sheet">
        <IonHeader><IonToolbar>
          <IonTitle>正确答案</IonTitle>
          <IonButtons slot="end"><IonButton strong onClick={() => setSolutionOpen(false)} data-testid="solution-close">完成</IonButton></IonButtons>
        </IonToolbar></IonHeader>
        <IonContent><div className="solution">
          {data?.sourceAnswers.length ? <section>
            <h3>照片里的参考答案</h3>
            {data.sourceAnswers.map((text, index) => <pre key={index}>{text}</pre>)}
          </section> : null}
          {ready ? <>
            <p className="solution-badge">AI 参考，未经老师核验</p>
            {ready.warnings.map(warning => <p key={warning} className="item-hint tone-orange">{warning}</p>)}
            <section data-testid="solution-answer"><h3>答案</h3><Md text={ready.answer} /></section>
            <section data-testid="solution-steps"><h3>解题过程</h3><Md text={ready.solution} /></section>
          </> : <p className="muted">{insightStatus()}</p>}
        </div></IonContent>
      </IonModal>
      <IonModal isOpen={editing} onDidDismiss={() => setEditing(false)}>
        <IonHeader><IonToolbar>
          <IonButtons slot="start"><IonButton onClick={() => setEditing(false)}>取消</IonButton></IonButtons>
          <IonTitle>修改分类</IonTitle>
          <IonButtons slot="end"><IonButton strong onClick={() => void save()}>保存</IonButton></IonButtons>
        </IonToolbar></IonHeader>
        <IonContent>
          {values ? <IonList inset>
            <IonItem><IonSelect label="学段" value={values.grade} interface="action-sheet" onIonChange={event => retarget({ ...values, grade: String(event.detail.value) })}>{data?.category.stages.map(stage => <IonSelectOption key={stage} value={stage}>{stage}</IonSelectOption>)}</IonSelect></IonItem>
            <IonItem><IonSelect label="学科" value={values.subject} interface="action-sheet" cancelText="取消" onIonChange={event => retarget({ ...values, subject: String(event.detail.value) })}>{(data?.category.subjects ?? []).map(name => <IonSelectOption key={name} value={name}>{name}</IonSelectOption>)}</IonSelect></IonItem>
            {/* 章节：从现有章节里选（候选随上面的学段、学科变；列表很长，用 modal 界面，action-sheet 超过 6 项会退化成 alert），或者自己填；选了就填进下面的输入框，保存时以输入框为准。 */}
            <IonItem><IonSelect label="从现有章节选" placeholder={chapters.length ? '选一个' : '这个学科还没有章节'} disabled={!chapters.length} value={chapters.includes(values.chapter) ? values.chapter : undefined} interface="modal" interfaceOptions={{ header: '章节' }} cancelText="取消" data-testid="chapter-picker"
              onIonChange={event => { const next = String(event.detail.value ?? ''); if (next) setValues({ ...values, chapter: next }); }}>
              {chapters.map(name => <IonSelectOption key={name} value={name}>{name}</IonSelectOption>)}
            </IonSelect></IonItem>
            <IonItem><IonInput label="章节" labelPlacement="fixed" value={values.chapter} maxlength={100} placeholder="也可以自己填" onIonInput={event => setValues({ ...values, chapter: String(event.detail.value ?? '') })} /></IonItem>
          </IonList> : null}
          {data?.item.knowledgeTags.length ? <p className="item-hint muted">知识点（AI 识别）：{data.item.knowledgeTags.join('、')}</p> : null}
        </IonContent>
      </IonModal>
      <IonActionSheet isOpen={sheet === 'confirm'} onDidDismiss={() => setSheet(null)} header="把这道题移出错题本？" subHeader="原图保留，移出后可以在错题本撤销。"
        buttons={[{ text: '移除', role: 'destructive', handler: () => { void remove(); } }, { text: '取消', role: 'cancel' }]} />
      <IonToast isOpen={!!toast} message={toast ?? ''} duration={3000} onDidDismiss={() => setToast(null)} />
    </IonContent>
  </IonPage>;
}
