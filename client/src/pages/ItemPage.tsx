import {
  IonActionSheet, IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonList, IonModal, IonPage, IonPopover, IonSelect, IonSelectOption,
  IonTextarea, IonTitle, IonToast, IonToolbar,
} from '@ionic/react';
import { cameraOutline, chevronBack, ellipsisHorizontal } from 'ionicons/icons';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Problem } from '../components/Problem';
import type { ItemAnswerPhoto, ItemImage, ItemInsight, ItemTrace } from '../../../src/web/apiTypes';
import { Md, SolutionModal } from '../components/SolutionModal';
import { StemText } from '../components/StemText';
import { TextEditModal, type TextEdit } from '../components/TextEditModal';
import { VoiceButton } from '../components/VoiceButton';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { prepare } from '../lib/uploader';

/** 解答在后台排队生成：打开着详情页就每 4 秒看一眼，最多看 10 分钟。 */
const POLL_MS = 4000;
const MAX_POLLS = 150;
const PENDING = new Set<ItemInsight['state']>(['none', 'queued', 'generating']);
const REMARK_STATUS = { idle: '', saving: '保存中…', saved: '已保存', failed: '没保存上，检查网络后再改一下。' } as const;
const WORK_HINT = '只能把认错的字改回纸上实际写的，不能改成正确答案。';
const TEXT_HINT = '对照照片，把认错的地方改过来。改完 AI 会按新的内容重新解。';

/**
 * 题目详情：照片（点开是应用内大图，左上角返回）、题干（识别错了可以改），下面五块：
 * 你写的、批改痕迹（点开看转写、逐段改）；章节与知识点（点按修改分类）；
 * 正确答案（AI 在后台解好的答案、Markdown 解题过程、交互图；也可以拍照录入答案）；错因（AI 推测 + 学生自己的备注，可以语音输入）。
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
  const [traceKind, setTraceKind] = useState<'work' | 'marking' | null>(null);
  const [solutionOpen, setSolutionOpen] = useState(false);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const [deleting, setDeleting] = useState<ItemAnswerPhoto | null>(null);
  const [menuEvent, setMenuEvent] = useState<Event | null>(null);
  // 大图：关闭时只收起弹层、保留 viewing，收起动画里图片不会先消失。
  const [viewing, setViewing] = useState<ItemImage | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const view = (image: ItemImage): void => { setViewing(image); setViewerOpen(true); };

  // AI 解答：服务器在后台排队做。打开时还没轮到就请它排到最前（不会马上调用模型）；还没好就隔一会儿看一眼，离开页面就停。
  const [insight, setInsight] = useState<ItemInsight | null>(null);
  const [tick, setTick] = useState(0);
  const requestedFor = useRef('');
  const polls = useRef(0);
  useEffect(() => { if (data) setInsight(data.insight); }, [data]);
  useEffect(() => {
    if (insight?.state !== 'none' || requestedFor.current === id) return;
    requestedFor.current = id;
    api.requestInsight(id).then(setInsight, () => undefined);
  }, [insight, id]);
  const readingPhotos = data?.answerPhotos.some(photo => photo.status === 'reading') ?? false;
  const pending = !!insight && PENDING.has(insight.state);
  useEffect(() => {
    if ((!pending && !readingPhotos) || polls.current >= MAX_POLLS) return;
    const timer = setTimeout(() => {
      polls.current += 1;
      // 拍的答案还在识别就整页刷新（识别完会影响解答）；否则只问解答。网络抖一下就下一轮再问。
      if (readingPhotos) void reload();
      else api.insight(id).then(setInsight, () => setTick(value => value + 1));
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [pending, readingPhotos, insight, data, id, reload, tick]);
  const retryInsight = (): void => {
    polls.current = 0;
    setInsight({ state: 'queued' });
    api.requestInsight(id, true).then(setInsight, () => setInsight({ state: 'failed', message: '暂时连不上，稍后再试。', retryable: true }));
  };

  // 备注：停笔 1 秒或离开输入框就存；一次只发一个请求，按顺序存，最后存下的就是最后写的。
  const [remark, setRemark] = useState('');
  const [remarkStatus, setRemarkStatus] = useState<keyof typeof REMARK_STATUS>('idle');
  const remarkFor = useRef('');
  const latestRemark = useRef('');
  const savedRemark = useRef('');
  const pendingRemark = useRef<string | null>(null);
  const remarkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remarkChain = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!data || remarkFor.current === id) return;
    remarkFor.current = id;
    setRemark(data.remark.text);
    latestRemark.current = data.remark.text;
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
    latestRemark.current = text;
    pendingRemark.current = text;
    if (remarkTimer.current) clearTimeout(remarkTimer.current);
    remarkTimer.current = setTimeout(() => saveRemark(text), 1000);
  };
  // 语音转出来的文字接在已有备注后面，马上存。
  const appendSpoken = (text: string): void => {
    const current = latestRemark.current;
    const next = (current.trim() ? `${current.replace(/\s+$/, '')}\n${text}` : text).slice(0, 1000);
    editRemark(next);
    saveRemark(next);
  };
  // 离开页面时还有没存的就补发一次。
  useEffect(() => () => { if (pendingRemark.current !== null) saveRemark(pendingRemark.current); }, [saveRemark]);

  // 改识别出的文字：题干或某一段笔迹。改完整页刷新，解答会按新内容重新排队。
  const editRecognized = (title: string, target: string, value: string, hint: string): void => setTextEdit({
    title, value, hint, maxLength: 4000,
    save: async text => {
      if (!data?.revision) return '这道题现在不能改。';
      try { await api.editText(id, data.revision, target, text); polls.current = 0; await reload(); setToast('改好了，AI 会按新的内容重新解'); return null; }
      catch (caught) { return caught instanceof Error ? caught.message : '没改成功，再试一次。'; }
    },
  });
  const editTrace = (trace: ItemTrace, title: string): void => editRecognized(title, trace.id, trace.text, traceKind === 'work' && trace.label === null ? WORK_HINT : TEXT_HINT);

  // 拍照录入答案：转成 JPEG 上传，后台找出这道题的答案转写。
  const answerInput = useRef<HTMLInputElement>(null);
  const [uploadingAnswer, setUploadingAnswer] = useState(false);
  const addAnswer = async (file: File): Promise<void> => {
    setUploadingAnswer(true);
    try { await api.addAnswerPhoto(id, await prepare(file)); polls.current = 0; await reload(); setToast('答案照片收到了，稍后识别好'); }
    catch (caught) { setToast(caught instanceof Error ? caught.message : '没传上去，再试一次。'); }
    finally { setUploadingAnswer(false); }
  };
  const photoAction = async (action: () => Promise<unknown>, done: string): Promise<void> => {
    try { await action(); polls.current = 0; await reload(); setToast(done); }
    catch (caught) { setToast(caught instanceof Error ? caught.message : '没成功，再试一次。'); }
  };
  const editPhoto = (photo: ItemAnswerPhoto): void => setTextEdit({
    title: '你拍的答案', value: photo.text ?? '', maxLength: 8000, hint: '对照照片改；照片里没认出来的话自己填上这道题的答案。',
    save: async text => {
      try { await api.editAnswerPhoto(id, photo.id, text); polls.current = 0; await reload(); return null; }
      catch (caught) { return caught instanceof Error ? caught.message : '没保存成功，再试一次。'; }
    },
  });

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
  const ready = insight?.state === 'ready' ? insight : null;
  const traceEntries = traceKind === 'work' ? data?.work ?? [] : traceKind === 'marking' ? data?.marking ?? [] : [];
  const traceTitle = traceKind === 'work' ? '你写的' : '批改痕迹';
  const traceRow = (title: string, kind: 'work' | 'marking', entries: ItemTrace[], testId: string): ReactNode => entries.length
    ? <IonItem button detail onClick={() => setTraceKind(kind)} data-testid={testId}><IonLabel>{title}</IonLabel></IonItem>
    : <IonItem data-testid={testId}><IonLabel>{title}</IonLabel><IonLabel slot="end" className="muted">没识别到</IonLabel></IonItem>;
  // 还没好只是淡淡一句，不强调；没解出来才给醒目的「重试」。
  const answerNote = ready ? 'AI 解答，仅供参考' : insight?.state === 'failed' || insight?.state === 'unavailable' ? insight.message : '稍后就好';
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
          {data?.editable ? <IonItem button detail={false} onClick={() => editRecognized('题目文字', 'question', data.questionText, TEXT_HINT)}><IonLabel>改题目文字</IonLabel></IonItem> : null}
          {data?.materialUrl ? <IonItem button detail={false} href={data.materialUrl}><IonLabel>查看材料与批改来源</IonLabel></IonItem> : null}
          {data?.canDiscard ? <IonItem button detail={false} onClick={() => setSheet('confirm')}><IonLabel color="danger">不是错题，移除</IonLabel></IonItem> : null}
        </IonList>
      </IonPopover>
      {error ? <Problem message={error.message} onRetry={() => void reload()} /> : null}
      {data && item ? <>
        <h1 className="item-title">{item.chapter}</h1>
        <p className="item-subtitle" data-testid="item-category">{[item.shortId, item.grade, item.subject].filter(Boolean).join(' · ')}</p>
        {data.images.map(image => <button key={image.url} type="button" className="item-photo" onClick={() => view(image)} aria-label={`${image.title}，查看大图`} data-testid="item-photo"><img src={image.url} alt={image.title} /></button>)}
        <div className="item-stem" data-testid="question-text">
          <StemText text={data.questionText || '还没有可读的识别文字，请打开上方原图查看。'} />
          {data.editable ? <div className="item-stem-actions"><IonButton size="small" fill="clear" onClick={() => editRecognized('题目文字', 'question', data.questionText, TEXT_HINT)} data-testid="stem-edit">识别错了？改</IonButton></div> : null}
        </div>
        {data.badge === 'low' ? <p className="item-hint tone-orange">字可能认错了，以照片为准。</p> : null}

        <IonList inset lines="full" className="item-rows">
          {traceRow('你写的', 'work', data.work, 'item-work')}
          {traceRow('批改痕迹', 'marking', data.marking, 'item-marking')}
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
        <IonList inset lines="full" className="item-section">
          <IonItem button detail onClick={() => setSolutionOpen(true)} data-testid="item-answer">
            <IonLabel className="ion-text-wrap">查看答案和解题过程<p>{answerNote}</p></IonLabel>
            {insight?.state === 'failed' && insight.retryable ? <IonButton slot="end" size="small" onClick={event => { event.stopPropagation(); retryInsight(); }} data-testid="insight-retry">重试</IonButton> : null}
          </IonItem>
          <IonItem button detail={false} disabled={uploadingAnswer} onClick={() => answerInput.current?.click()} data-testid="answer-photo-add">
            <IonIcon icon={cameraOutline} slot="start" color="primary" />
            <IonLabel color="primary">{uploadingAnswer ? '正在上传…' : '拍照录入答案'}</IonLabel>
            {data.answerPhotos.length ? <IonLabel slot="end" className="muted">已录 {data.answerPhotos.length} 张</IonLabel> : null}
          </IonItem>
        </IonList>
        <input ref={answerInput} type="file" accept="image/*" hidden data-testid="answer-photo-input"
          onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void addAnswer(file); }} />

        <h2 className="item-section-title">错因（备注）</h2>
        <IonList inset lines="full" className="item-section">
          <IonItem data-testid="item-mistake">
            <IonLabel className="ion-text-wrap">
              <p className="item-field-label">AI 推测{ready?.cause ? ` · ${ready.cause}` : ''}</p>
              {ready ? ready.mistake ? <Md text={ready.mistake} inline /> : <span className="muted">没识别到你的作答，推测不了；可以自己记在下面。</span>
                : <span className="muted">{insight?.state === 'failed' || insight?.state === 'unavailable' ? '暂时没有' : '稍后给出'}</span>}
            </IonLabel>
          </IonItem>
          <IonItem lines="none">
            <IonTextarea label="我的备注" labelPlacement="stacked" autoGrow rows={2} maxlength={1000} placeholder="自己记一下：错在哪、下次注意什么（可以直接说）" value={remark}
              onIonInput={event => editRemark(String(event.detail.value ?? ''))} onIonBlur={() => saveRemark(remark)} data-testid="item-remark" />
          </IonItem>
        </IonList>
        <div className="item-remark-actions">
          <VoiceButton onText={appendSpoken} onError={setToast} />
          <span className="muted" data-testid="remark-status" aria-live="polite">{REMARK_STATUS[remarkStatus]}</span>
        </div>
        {data.canDiscard ? <IonButton fill="clear" color="danger" expand="block" className="item-remove" onClick={() => setSheet('confirm')} data-testid="discard">不是错题，移除</IonButton> : null}
      </> : null}
      <IonModal isOpen={traceKind !== null} onDidDismiss={() => setTraceKind(null)} initialBreakpoint={0.6} breakpoints={[0, 0.6, 1]} expandToScroll={false} data-testid="trace-sheet">
        <IonContent><div className="note-sheet">
          <h2>{traceTitle}</h2>
          {traceEntries.map(entry => <section key={entry.id}>
            {entry.label ? <h3>{entry.label}</h3> : null}
            <div className="trace-entry">
              <pre>{entry.text}</pre>
              {data?.editable ? <IonButton size="small" fill="clear" onClick={() => editTrace(entry, entry.label ?? traceTitle)} data-testid="trace-edit">改</IonButton> : null}
            </div>
          </section>)}
        </div></IonContent>
      </IonModal>
      <SolutionModal open={solutionOpen} onClose={() => setSolutionOpen(false)} insight={insight} sourceAnswers={data?.sourceAnswers ?? []} answerPhotos={data?.answerPhotos ?? []}
        onEditSource={data?.editable ? trace => editRecognized('参考答案', trace.id, trace.text, TEXT_HINT) : undefined}
        onViewPhoto={photo => view({ url: photo.imageUrl, fullUrl: photo.imageUrl, title: '答案照片' })}
        onEditPhoto={editPhoto}
        onRetryPhoto={photo => void photoAction(() => api.retryAnswerPhoto(id, photo.id), '重新识别了，稍后就好')}
        onDeletePhoto={setDeleting}
        onRetryInsight={retryInsight} />
      <TextEditModal edit={textEdit} onClose={() => setTextEdit(null)} />
      <IonModal isOpen={viewerOpen} onDidDismiss={() => setViewerOpen(false)} className="photo-viewer" data-testid="photo-viewer">
        <IonHeader className="ion-no-border"><IonToolbar>
          <IonButtons slot="start"><IonButton aria-label="返回" data-testid="photo-back" onClick={() => setViewerOpen(false)}><IonIcon icon={chevronBack} slot="icon-only" /></IonButton></IonButtons>
          <IonTitle>{viewing?.title}</IonTitle>
        </IonToolbar></IonHeader>
        <IonContent>
          {viewing ? <div className="photo-viewer-body"><img src={viewing.fullUrl} alt={viewing.title} /></div> : null}
        </IonContent>
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
      <IonActionSheet isOpen={deleting !== null} onDidDismiss={() => setDeleting(null)} header="删掉这张答案照片？"
        buttons={[{ text: '删除', role: 'destructive', handler: () => { const photo = deleting; if (photo) void photoAction(() => api.deleteAnswerPhoto(id, photo.id), '删掉了'); } }, { text: '取消', role: 'cancel' }]} />
      <IonActionSheet isOpen={sheet === 'confirm'} onDidDismiss={() => setSheet(null)} header="把这道题移出错题本？" subHeader="原图保留，移出后可以在错题本撤销。"
        buttons={[{ text: '移除', role: 'destructive', handler: () => { void remove(); } }, { text: '取消', role: 'cancel' }]} />
      <IonToast isOpen={!!toast} message={toast ?? ''} duration={3000} onDidDismiss={() => setToast(null)} />
    </IonContent>
  </IonPage>;
}
