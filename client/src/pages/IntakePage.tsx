import { IonButton, IonCheckbox, IonContent, IonIcon, IonItem, IonItemOption, IonItemOptions, IonItemSliding, IonLabel, IonList, IonPage, IonSpinner, IonToast, IonToggle } from '@ionic/react';
import { checkmark } from 'ionicons/icons';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { initialUploadDayFilter, intakeListParams, intakeResponseMatches, intakeWaitsForUpload, reduceUploadDayFilter } from '../../../src/materials/dayFilter';
import type { IntakeCandidate, IntakeCandidateDetail, IntakePhoto } from '../../../src/web/apiTypes';
import { INTAKE_SELECT_LIMIT, intakePickKey, pagePickState, prunePhotoPicks, selectDisplayedPage, selectionCountText, selectionTotals } from '../../../src/web/intakeSelection';
import { CandidateDetailModal } from '../components/CandidateDetailModal';
import { CaptureDock } from '../components/CaptureDock';
import { useCaptureSession } from '../lib/captureSession';
import { Problem } from '../components/Problem';
import { api } from '../lib/api';
import { useLoad, useUploads } from '../lib/hooks';
import { uploader } from '../lib/uploader';

function timeLabel(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return sameDay ? `今天 ${time}` : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

const CANDIDATE_STATUS = { preliminary: '待识别 · 可先看图勾选', verifying: '校验中', verified: '已校验', needs_review: '识别仍有不确定处' };
const MATERIALS_CANDIDATE = /^([A-Za-z0-9_-]{1,80}):([0-9]{1,9})$/;

type DetailRequest = {
  photoId: string;
  candidateId: string;
  label: string;
  mode: 'legacy' | 'materials';
  crop: string | null;
  source: string | null;
};


/** 录入态：一次上传算一个批次，按照片分段；找到的题默认已在错题本，左滑删掉不相关的；没批改痕迹的页勾出做错的题。 */
export function IntakePage(): ReactNode {
  const navigate = useNavigate();
  const uploads = useUploads();
  const [filter, dispatchFilter] = useReducer(reduceUploadDayFilter, undefined, () => initialUploadDayFilter());
  const listParams = intakeListParams(filter);
  const { data, error, reload } = useLoad(() => api.intake(listParams), [listParams.date ?? '', listParams.page ?? '']);
  const [picked, setPicked] = useState<Record<string, Set<string>>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [detailRequest, setDetailRequest] = useState<DetailRequest | null>(null);
  const [detailBody, setDetailBody] = useState<IntakeCandidateDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const contentRef = useRef<HTMLIonContentElement>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const liveScroll = useRef(0);
  const savedScroll = useRef(0);
  // Freeze only while the sheet is open. A press that turns into a scroll must keep updating.
  const scrollFrozen = useRef(false);
  const detailToken = useRef(0);
  const setContent = useCallback((node: HTMLIonContentElement | null) => {
    contentRef.current = node;
    if (!node) return;
    let scroller: HTMLElement | undefined;
    let stop = false;
    const onScroll = (): void => { if (scroller && !scrollFrozen.current) liveScroll.current = scroller.scrollTop; };
    void node.getScrollElement().then(element => {
      if (stop || contentRef.current !== node) return;
      scroller = element;
      scrollerRef.current = element;
      liveScroll.current = element.scrollTop;
      element.addEventListener('scroll', onScroll, { passive: true });
    });
    return () => { stop = true; scroller?.removeEventListener('scroll', onScroll); };
  }, []);
  const uploading = uploads.some(entry => entry.state !== 'succeeded' && entry.state !== 'failed');
  const uploadedIds = useMemo(() => new Set(uploader.batchIds), [uploads]);

  useEffect(() => { if (data) uploader.setMode(data.mode === 'materials' && data.draftNamespace ? { kind: 'materials', namespace: data.draftNamespace } : { kind: 'legacy' }); }, [data]);
  // 还在找题、还在上传、或刚传完还没登记：每 3 秒取一次，只换数据不整页刷新。
  // 传完的照片会留在队列里直到点「完成」。只有全部列表或今天的第一页一定会收录它。
  const awaitingUpload = intakeWaitsForUpload(filter) && uploads.some(entry => entry.state === 'succeeded' && !!entry.photoId && !data?.photos.some(photo => photo.id === entry.photoId));
  const busy = !!data?.busy || uploading || awaitingUpload;
  useEffect(() => { if (!busy) return; const timer = setInterval(() => { void reload(); }, 3000); return () => clearInterval(timer); }, [busy, reload]);

  const batchSize = uploadedIds.size + uploads.filter(entry => !entry.photoId).length;
  // 筛选切换后，上一份结果（全部或另一天）先不要当成这一次的列表。
  const listReady = intakeResponseMatches(filter, data);
  const photos: IntakePhoto[] = (listReady ? data?.photos : []) ?? [];
  // 本批上传的照片在前，其余（历史）折在后面。
  // 本批按拍摄先后排（和学生选照片的顺序一致）；没有本批时只展开最近一张。
  // 按日筛选时服务器已经排好、并且只返回那一天的这一页，不再拆成「本批 / 更早」。
  const current = filter.enabled
    ? photos
    : (batchSize ? photos.filter(photo => uploadedIds.has(photo.id)) : photos.slice(0, 1)).slice().sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt) || a.number - b.number);
  const earlier = filter.enabled ? [] : photos.filter(photo => !current.includes(photo));
  const found = current.reduce((n, photo) => n + photo.questions.length, 0);
  const pendingUploads = uploads.filter(entry => !entry.photoId);
  const capture = useCaptureSession();
  const selectLimit = data?.mode === 'legacy' ? INTAKE_SELECT_LIMIT.legacy : INTAKE_SELECT_LIMIT.materials;
  const renderedPhotos = listReady ? (filter.enabled ? current : [...current, ...earlier]) : [];
  const visibleKeys = new Set(renderedPhotos.flatMap(photo => photo.candidates.map(candidate => intakePickKey(photo.id, candidate.id))));
  const countedPicks = Object.fromEntries(Object.entries(picked).map(([id, set]) => [id, [...set]]));
  for (const photo of renderedPhotos) countedPicks[photo.id] = [...new Set([...(countedPicks[photo.id] ?? []), ...photo.candidates.filter(c => c.submitted).map(c => c.id)])];
  const totals = selectionTotals(countedPicks, visibleKeys);
  const selectedText = selectionCountText(totals.total, listReady ? totals.hidden : 0);

  // 只丢掉这份列表里已经对不上的勾选。换筛选时看不见的照片留着，避免把别的页悄悄取消。
  useEffect(() => {
    if (!listReady || !data) return;
    setPicked(currentPicks => {
      const flat = Object.fromEntries(Object.entries(currentPicks).map(([id, set]) => [id, [...set]]));
      const result = prunePhotoPicks(flat, data.photos.map(photo => ({ id: photo.id, candidateIds: photo.candidates.map(candidate => candidate.id) })), !data.filter);
      if (!result.changed) return currentPicks;
      return Object.fromEntries(Object.entries(result.picks).map(([id, ids]) => [id, new Set(ids)]));
    });
  }, [data, listReady]);

  const remove = async (itemId: string): Promise<void> => {
    try { const result = await api.discard([itemId]); if (result.failed[0]) setToast(result.failed[0].message); }
    catch (caught) { setToast(caught instanceof Error ? caught.message : '没有移除'); }
    await reload();
  };
  const include = async (photo: IntakePhoto): Promise<void> => {
    const ids = [...(picked[photo.id] ?? [])];
    if (!ids.length) return;
    if (ids.length > selectLimit) {
      setToast(`一次最多加入 ${selectLimit} 道，多出来的请分批加入。`);
      return;
    }
    try {
      const result = await api.select(photo.id, ids);
      if (result.pending) setToast(photo.progress?.stage === 'done' || photo.state === 'failed' ? '已保存选择；未通过校验的题暂未收录，请重试或补拍清楚的照片。' : `已保存 ${result.pending} 道选择，校验通过后会加入错题本。`);
      else if (result.skipped) setToast(`${result.skipped} 道未加入，请查看更新后的题目再试。`);
      setPicked(currentPicks => ({ ...currentPicks, [photo.id]: new Set() }));
    }
    catch (caught) { setToast(caught instanceof Error ? caught.message : '没加进去'); }
    await reload();
  };
  const setPick = (photoId: string, id: string, selected: boolean): void => {
    const prev = picked[photoId] ?? new Set<string>();
    if (selected && !prev.has(id) && prev.size >= selectLimit) {
      setToast(`一次最多加入 ${selectLimit} 道，多出来的请分批加入。`);
      return;
    }
    setPicked(currentPicks => {
      const set = currentPicks[photoId] ?? new Set<string>();
      if (set.has(id) === selected) return currentPicks;
      if (selected && set.size >= selectLimit) return currentPicks;
      const next = new Set(set);
      if (selected) next.add(id); else next.delete(id);
      return { ...currentPicks, [photoId]: next };
    });
  };
  const togglePage = (photo: IntakePhoto): void => {
    const displayed = photo.candidates.filter(candidate => !candidate.submitted).map(candidate => candidate.id);
    const selected = [...(picked[photo.id] ?? [])];
    const result = selectDisplayedPage(selected, displayed, selectLimit, pagePickState(selected, displayed) === 'all' ? 'none' : 'all');
    if (result.truncated) setToast(`一次最多加入 ${selectLimit} 道，多出来的请分批加入。`);
    setPicked(currentPicks => ({ ...currentPicks, [photo.id]: new Set(result.ids) }));
  };
  const openDetail = (photo: IntakePhoto, candidate: IntakeCandidate): void => {
    if (scrollerRef.current) liveScroll.current = scrollerRef.current.scrollTop;
    savedScroll.current = liveScroll.current;
    scrollFrozen.current = true;
    const token = ++detailToken.current;
    const mode = data?.mode === 'legacy' ? 'legacy' : 'materials';
    setDetailRequest({ photoId: photo.id, candidateId: candidate.id, label: candidate.label, mode, crop: candidate.crop, source: photo.full });
    setDetailBody(null);
    setDetailError(null);
    if (mode === 'legacy') { setDetailLoading(false); return; }
    const parsed = MATERIALS_CANDIDATE.exec(candidate.id);
    if (!parsed) { setDetailLoading(false); setDetailError('这道题的识别信息不可用，请刷新后再试。'); return; }
    setDetailLoading(true);
      void (async () => {
        try {
          const body = await api.candidateDetail(parsed[1]!, Number(parsed[2]));
          if (token !== detailToken.current) return;
          setDetailBody(body);
          setDetailLoading(false);
        } catch (caught) {
          if (token !== detailToken.current) return;
          setDetailError(caught instanceof Error ? caught.message : '没有读到这道题。');
          setDetailLoading(false);
        }
      })();
  };
  const requestCloseDetail = (): void => {
    detailToken.current += 1;
    setDetailRequest(null);
    setDetailLoading(false);
  };
  const closeDetail = (): void => {
    requestCloseDetail();
    const top = savedScroll.current;
    scrollFrozen.current = false;
    const apply = (): void => { void contentRef.current?.getScrollElement().then(element => { element.scrollTop = top; }); };
    apply();
    window.setTimeout(apply, 50);
  };

  const renderPhoto = (photo: IntakePhoto, index: number): ReactNode => {
    const shownNumber = filter.enabled || current.length <= 1 ? photo.number : index + 1;
    const displayed = photo.candidates.filter(candidate => !candidate.submitted).map(candidate => candidate.id);
    const selected = [...(picked[photo.id] ?? [])];
    const pickState = pagePickState(selected, displayed);
    return <section key={photo.id} className="intake-photo" data-testid={`photo-row-${photo.number}`} data-state={photo.state}>
      <IonList inset lines="full">
        <IonItem lines="full" className="intake-head" detail={false}>
          <a slot="start" className="intake-thumb" href={photo.full} target="_blank" rel="noreferrer" aria-label="查看原图"><img src={photo.thumb} alt="" loading="lazy" /></a>
          <IonLabel><h2>第 {shownNumber} 张{photo.questions.length ? ` · ${photo.questions.length} 道` : ''}</h2><p>{timeLabel(photo.takenAt)} · {photo.statusText}</p></IonLabel>
          {displayed.length ? <button
            slot="end"
            type="button"
            className="intake-page-toggle"
            data-testid="pick-page"
            aria-pressed={pickState === 'all' ? 'true' : pickState === 'some' ? 'mixed' : 'false'}
            aria-label={pickState === 'all' ? `取消全选第 ${shownNumber} 张` : `全选第 ${shownNumber} 张`}
            onClick={() => togglePage(photo)}
          >{pickState === 'all' ? '取消全选' : '全选本页'}</button> : null}
          {['finding', 'located', 'enriching'].includes(photo.state) ? <IonSpinner slot="end" name="lines-small" /> : null}
        </IonItem>
        {photo.questions.map(question => <IonItemSliding key={question.id}>
          <IonItem routerLink={`/q/${question.id}`} detail={false} className="intake-row" data-testid="intake-question">
            <img slot="start" className="row-thumb" src={question.thumb} alt="" loading="lazy" />
            <IonLabel><h3>{question.excerpt || '题目文字暂不可用'}</h3><p>{question.chapter}</p></IonLabel>
          </IonItem>
          <IonItemOptions side="end"><IonItemOption color="danger" onClick={() => void remove(question.id)}>删除</IonItemOption></IonItemOptions>
        </IonItemSliding>)}
        {photo.candidates.length ? <>
          <IonItem lines="full" className="intake-note"><IonLabel className="ion-text-wrap"><p>{photo.progress ? '可以先看图勾出做错的题，校验通过后加入错题本。' : '这页没有批改痕迹，勾出做错的题'}</p></IonLabel></IonItem>
          <div className="intake-candidates">
            {photo.candidates.map(candidate => <div key={candidate.id} className="intake-candidate" data-testid="pick-candidate">
              <IonCheckbox
                className="intake-check"
                checked={candidate.submitted || (picked[photo.id]?.has(candidate.id) ?? false)}
                disabled={candidate.submitted}
                aria-label={`选择${candidate.label}`}
                data-testid="pick-checkbox"
                onIonChange={event => setPick(photo.id, candidate.id, event.detail.checked)}
              />
              {candidate.crop ? <img className="row-thumb" src={candidate.crop} alt="" loading="lazy" /> : null}
              <div className="intake-candidate-text">
                <h3>{candidate.excerpt || candidate.label}</h3>
                {candidate.excerpt ? <p>{candidate.label}</p> : null}
                {candidate.status ? <p>{CANDIDATE_STATUS[candidate.status]}</p> : null}
                {candidate.submitted ? <p>{(photo.progress?.stage === 'done' || photo.state === 'failed') && candidate.status !== 'verified' ? '已选，暂未收录；请重试或补拍清楚的照片。' : '已选，校验通过后加入'}</p> : null}
              </div>
              <button
                type="button"
                className="intake-detail-button"
                data-testid="candidate-detail"
                aria-label={`查看${candidate.label}的详情`}
                onClick={() => openDetail(photo, candidate)}
              >查看详情</button>
            </div>)}
          </div>
          <IonItem lines="none"><IonButton slot="end" size="default" disabled={!(picked[photo.id]?.size)} onClick={() => void include(photo)} data-testid="pick-submit">加入{picked[photo.id]?.size ? ` ${picked[photo.id]!.size} 道` : ''}</IonButton></IonItem>
        </> : null}
        {photo.failure ? <IonItem lines="none" className="intake-failure">
          <IonLabel className="ion-text-wrap"><p className="tone-red">{photo.failure.detail}</p></IonLabel>
          {photo.failure.retryable ? <IonButton slot="end" fill="clear" onClick={() => { void api.retry(photo.id).then(reload).catch(caught => setToast(caught instanceof Error ? caught.message : '没重试成功')); }}>重试</IonButton> : null}
          {data?.mode === 'legacy' ? <IonButton slot="end" fill="clear" color="medium" onClick={() => { void api.dismiss(photo.id).then(reload); }}>不要了</IonButton> : null}
        </IonItem> : null}
      </IonList>
    </section>;
  };

  return <IonPage>
    <IonContent fullscreen className="intake" ref={setContent}>
      <div className="intake-top">
        <h1>录入</h1>
        <p className="muted" role="status">{pendingUploads.length ? `正在上传 · 还剩 ${pendingUploads.filter(entry => entry.state !== 'failed').length} 张` : !listReady ? '正在查找…' : filter.enabled ? (busy ? 'AI 正在找题' : data?.total ? `这一天上传了 ${data.total} 张` : '这一天没有上传的材料') : busy ? 'AI 正在找题' : found ? `找到 ${found} 道，已加入错题本 · 不相关的左滑删掉` : current.length ? '这一批没有新增错题' : '还没有录入'}</p>
      </div>
      <IonList inset lines="full" className="intake-filter">
        <IonItem>
          <IonLabel>按日期筛选</IonLabel>
          <IonToggle slot="end" checked={filter.enabled} aria-label="按日期筛选" data-testid="day-filter-toggle"
            onIonChange={event => { if (event.detail.checked !== filter.enabled) dispatchFilter({ type: 'toggle', enabled: event.detail.checked }); }} />
        </IonItem>
        {filter.enabled ? <IonItem lines="none">
          <IonLabel>上传日</IonLabel>
          <input slot="end" type="date" value={filter.day} aria-label="上传日期" data-testid="day-filter-date"
            onChange={event => dispatchFilter({ type: 'day', day: event.target.value })} />
        </IonItem> : null}
      </IonList>
      {pendingUploads.length ? <IonList inset lines="full" className="upload-list">
        {pendingUploads.map(entry => <IonItem key={entry.key} className="intake-head" detail={false} data-upload-state={entry.state}>
          {entry.previewUrl ? <img slot="start" className="intake-thumb" src={entry.previewUrl} alt="" /> : null}
          <IonLabel><h2>{entry.name}</h2><p className={entry.state === 'failed' ? 'tone-red' : undefined}>{entry.message}</p></IonLabel>
          {entry.state === 'preparing' || entry.state === 'uploading' || entry.state === 'backoff' ? <IonSpinner slot="end" name="lines-small" /> : null}
        </IonItem>)}
        {pendingUploads.some(entry => entry.state === 'failed' && entry.retryable) ? <IonItem lines="none"><IonButton slot="end" fill="clear" onClick={() => uploader.retry()} data-testid="upload-retry">再试一次</IonButton></IonItem> : null}
      </IonList> : null}
      {error ? <Problem message={error.message} requestId={error.requestId} onRetry={() => void reload()} /> : null}
      {filter.enabled && listReady && !busy && !photos.length && !error ? <div className="intake-day-empty" data-testid="day-filter-empty">
        <b>这一天没有上传的材料</b>
        <p>换一天看看，或关掉筛选看全部。</p>
      </div> : null}
      {current.map(renderPhoto)}
      {filter.enabled && listReady && ((data?.page ?? 0) > 0 || data?.hasMore) ? <div className="intake-pager">
        <IonButton fill="clear" disabled={!filter.page} data-testid="day-filter-prev" onClick={() => dispatchFilter({ type: 'page', page: filter.page - 1 })}>上一页</IonButton>
        <IonButton fill="clear" disabled={!data?.hasMore} data-testid="day-filter-next" onClick={() => dispatchFilter({ type: 'page', page: filter.page + 1 })}>下一页</IonButton>
      </div> : null}
      {earlier.length ? <details className="intake-earlier"><summary>更早的 {earlier.length} 张</summary>{earlier.map(renderPhoto)}</details> : null}
      <div className={capture.pages.length ? 'bottom-space intake-space tall' : 'bottom-space intake-space'} />
      <div className="intake-bottom">
        <p className="intake-selected" role="status" data-testid="intake-selected">{selectedText}</p>
        <IonButton expand="block" shape="round" size="large" onClick={() => { uploader.finishBatch(); navigate('/', { replace: true }); }} data-testid="intake-done"><IonIcon icon={checkmark} slot="start" />完成</IonButton>
        <CaptureDock placement="inline" />
      </div>
      <IonToast isOpen={!!toast} message={toast ?? ''} duration={3000} onDidDismiss={() => setToast(null)} />
      <CandidateDetailModal
        open={!!detailRequest}
        title={detailRequest?.label ?? '题目'}
        loading={detailLoading}
        error={detailError}
        detail={detailBody}
        legacy={detailRequest?.mode === 'legacy' ? { crop: detailRequest.crop, source: detailRequest.source } : null}
        selected={detailRequest ? (picked[detailRequest.photoId]?.has(detailRequest.candidateId) || photos.some(p => p.id === detailRequest.photoId && p.candidates.some(c => c.id === detailRequest.candidateId && c.submitted))) : false}
        terminal={!!detailRequest && photos.some(p => p.id === detailRequest.photoId && (p.progress?.stage === 'done' || p.state === 'failed'))}
        submitted={!!detailRequest && photos.some(p => p.id === detailRequest.photoId && p.candidates.some(c => c.id === detailRequest.candidateId && c.submitted))}
        onToggleSelected={selected => { if (detailRequest) setPick(detailRequest.photoId, detailRequest.candidateId, selected); }}
        onRequestClose={requestCloseDetail}
        onClosed={closeDetail}
      />
    </IonContent>
  </IonPage>;
}
