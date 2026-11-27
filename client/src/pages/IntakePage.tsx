import { IonButton, IonCheckbox, IonContent, IonIcon, IonItem, IonItemOption, IonItemOptions, IonItemSliding, IonLabel, IonList, IonPage, IonSpinner, IonToast, IonToggle } from '@ionic/react';
import { checkmark } from 'ionicons/icons';
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { initialUploadDayFilter, intakeListParams, intakeResponseMatches, intakeWaitsForUpload, reduceUploadDayFilter } from '../../../src/materials/dayFilter';
import type { IntakeCandidate, IntakeCandidateDetail, IntakeGroup, IntakePhoto, IntakeResponse } from '../../../src/web/apiTypes';
import { INTAKE_SELECT_LIMIT, intakePickKey, pagePickState, prunePhotoPicks, selectDisplayedPage, selectionCountText, selectionTotals } from '../../../src/web/intakeSelection';
import { applyCandidateHide, createDeleteQueue, deleteFailureMessage, matchDismissResult, reconcileHidden, restoreCandidateHide, type CandidateDeleteBatch } from '../lib/intakeDelete';
import { canAddCandidate, failedGroupPhotos, focusScrollPlan, groupNote, orderCandidates, pageNote, processLabel, shouldPreselect } from '../lib/intakeVerdict';
import { CandidateDetailModal } from '../components/CandidateDetailModal';
import { CaptureDock } from '../components/CaptureDock';
import { useCaptureSession } from '../lib/captureSession';
import { Problem } from '../components/Problem';
import { api, RequestError } from '../lib/api';
import { presentActionSheet } from '../lib/sheets';
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

const MATERIALS_CANDIDATE = /^([A-Za-z0-9_-]{1,80}):([0-9]{1,9})$/;

type DetailRequest = {
  photoId: string;
  candidateId: string;
  label: string;
  mode: 'legacy' | 'materials';
  crop: string | null;
  source: string | null;
  addable?: boolean;
};


/** 录入态：一次上传算一个批次，按照片分段；找到的题默认已在错题本，可以点删除或左滑去掉；没批改痕迹的页勾出做错的题再加入，没勾的也可以单独删掉。 */

type PendingDelete =
  | { kind: 'question'; id: string }
  | { kind: 'candidates'; batches: CandidateDeleteBatch[] };

/** One dismiss request is photo-scoped. A grouped card can select rows from several photos. */
function batchesByPhoto(selected: readonly { id: string; photoId?: string }[]): CandidateDeleteBatch[] {
  const byPhoto = new Map<string, string[]>();
  for (const candidate of selected) {
    const photoId = candidate.photoId ?? '';
    if (!photoId) continue;
    const ids = byPhoto.get(photoId);
    if (ids) ids.push(candidate.id);
    else byPhoto.set(photoId, [candidate.id]);
  }
  return [...byPhoto].map(([photoId, ids]) => ({ photoId, ids }));
}

/** After a 409, the candidate id may carry a newer revision. Keep the same question on the same photo. */
function refreshedCandidateId(photoId: string, id: string, fresh: IntakeResponse): string {
  const parsed = MATERIALS_CANDIDATE.exec(id);
  if (!parsed) return id;
  const prefix = `${parsed[1]}:`;
  const onPhoto = fresh.photos.find(photo => photo.id === photoId)?.candidates.find(candidate => candidate.id.startsWith(prefix));
  if (onPhoto) return onPhoto.id;
  const onGroup = fresh.groups?.flatMap(group => group.candidates).find(candidate => (candidate.photoId ?? '') === photoId && candidate.id.startsWith(prefix));
  return onGroup?.id ?? id;
}

export function IntakePage(): ReactNode {
  const navigate = useNavigate();
  const uploads = useUploads();
  const [filter, dispatchFilter] = useReducer(reduceUploadDayFilter, undefined, () => initialUploadDayFilter());
  const listParams = intakeListParams(filter);
  const { data, error, reload } = useLoad(() => api.intake(listParams), [listParams.date ?? '', listParams.page ?? '']);
  const [picked, setPicked] = useState<Record<string, Set<string>>>({});
  const [hiddenCandidates, setHiddenCandidates] = useState<Set<string>>(() => new Set());
  const [hiddenQuestions, setHiddenQuestions] = useState<Set<string>>(() => new Set());
  const [deletePending, setDeletePending] = useState(0);
  const hiddenCandidatesRef = useRef(hiddenCandidates);
  const hiddenQuestionsRef = useRef(hiddenQuestions);
  const picksRef = useRef(picked);
  hiddenCandidatesRef.current = hiddenCandidates;
  hiddenQuestionsRef.current = hiddenQuestions;
  picksRef.current = picked;
  const inFlightCandidateIds = useRef(new Set<string>());
  const inFlightQuestionIds = useRef(new Set<string>());
  const deleteQueue = useRef(createDeleteQueue());
  const [toast, setToast] = useState<string | null>(null);
  const [toastMs, setToastMs] = useState(3000);
  const notify = (message: string, duration = 3000): void => {
    setToastMs(duration);
    setToast(message);
  };
  const [detailRequest, setDetailRequest] = useState<DetailRequest | null>(null);
  const [detailBody, setDetailBody] = useState<IntakeCandidateDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const contentRef = useRef<HTMLIonContentElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [dockPad, setDockPad] = useState(0);
  const touched = useRef(new Set<string>());
  const seenFocus = useRef(new Set<string>());
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
  const sourcePhotos: IntakePhoto[] = (listReady ? data?.photos : []) ?? [];
  const photos: IntakePhoto[] = hiddenCandidates.size || hiddenQuestions.size
    ? sourcePhotos.map(photo => {
      const candidates = hiddenCandidates.size ? photo.candidates.filter(candidate => !hiddenCandidates.has(candidate.id)) : photo.candidates;
      const questions = hiddenQuestions.size ? photo.questions.filter(question => !hiddenQuestions.has(question.id)) : photo.questions;
      return candidates.length === photo.candidates.length && questions.length === photo.questions.length ? photo : { ...photo, candidates, questions };
    })
    : sourcePhotos;
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
  for (const photo of renderedPhotos) {
    const blocked = new Set(orderCandidates(photo.candidates).filter(row => !canAddCandidate(row.verdict)).map(row => row.candidate.id));
    countedPicks[photo.id] = [...new Set([...(countedPicks[photo.id] ?? []), ...photo.candidates.filter(candidate => candidate.submitted).map(candidate => candidate.id)])].filter(id => !blocked.has(id));
  }
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

  useEffect(() => {
    if (!listReady || !data) return;
    setPicked(currentPicks => {
      let changed = false;
      const next: Record<string, Set<string>> = { ...currentPicks };
      for (const photo of data.photos) {
        const set = new Set(next[photo.id] ?? []);
        let photoChanged = false;
        for (const row of orderCandidates(photo.candidates)) {
          if (hiddenCandidates.has(row.candidate.id)) continue;
          if (!shouldPreselect(row.candidate, touched.current.has(intakePickKey(photo.id, row.candidate.id)))) continue;
          if (set.has(row.candidate.id) || set.size >= selectLimit) continue;
          set.add(row.candidate.id);
          photoChanged = true;
        }
        if (photoChanged) {
          next[photo.id] = set;
          changed = true;
        }
      }
      return changed ? next : currentPicks;
    });
  }, [data, hiddenCandidates, listReady, selectLimit]);

  // A reload that still lists an id shows it again, except while that id's delete is in flight.
  // Ids the server dropped stay hidden so a slow list cannot paint them back.
  useEffect(() => {
    if (!data) return;
    const presentCandidates = new Set<string>();
    const presentQuestions = new Set<string>();
    for (const photo of data.photos) {
      for (const candidate of photo.candidates) presentCandidates.add(candidate.id);
      for (const question of photo.questions) presentQuestions.add(question.id);
    }
    for (const group of data.groups ?? []) {
      for (const candidate of group.candidates) presentCandidates.add(candidate.id);
      for (const question of group.questions) presentQuestions.add(question.id);
    }
    setHiddenCandidates(current => {
      const next = reconcileHidden(current, presentCandidates, inFlightCandidateIds.current);
      if (!next) return current;
      hiddenCandidatesRef.current = next;
      return next;
    });
    setHiddenQuestions(current => {
      const next = reconcileHidden(current, presentQuestions, inFlightQuestionIds.current);
      if (!next) return current;
      hiddenQuestionsRef.current = next;
      return next;
    });
  }, [data]);

  useLayoutEffect(() => {
    const node = bottomRef.current;
    if (!node) return;
    const apply = (): void => {
      const height = Math.ceil(node.getBoundingClientRect().height);
      const pad = height > 0 ? height + 12 : 0;
      setDockPad(current => current === pad ? current : pad);
      contentRef.current?.style.setProperty('--intake-dock', `${Math.max(pad, 320)}px`);
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(apply);
    // Border box includes padding, so safe-area changes are measured. Content-box would miss them.
    try { observer.observe(node, { box: 'border-box' }); }
    catch { observer.observe(node); }
    return () => observer.disconnect();
  }, [capture.pages.length, deletePending, selectedText, listReady]);

  useEffect(() => {
    if (!listReady) return;
    const rows = [...document.querySelectorAll<HTMLElement>('[data-intake-focus="wrong"]')];
    const plan = focusScrollPlan(rows.map(row => row.dataset.candidateId ?? ''), seenFocus.current);
    for (const id of plan.remember) seenFocus.current.add(id);
    const row = plan.target ? rows.find(item => item.dataset.candidateId === plan.target) : undefined;
    if (!row) return;
    const bar = document.querySelector('.intake-bottom');
    const barTop = bar?.getBoundingClientRect().top ?? window.innerHeight;
    const box = row.getBoundingClientRect();
    const visible = box.height > 0 && box.top >= 0 && box.bottom <= barTop - 4;
    if (!visible) row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [data, listReady, dockPad]);

  const dismissBatch = async (photoId: string, ids: string[]): Promise<{ removed: string[]; failed: { id: string; message: string }[]; sent: string[] }> => {
    try {
      const result = await api.dismissCandidates(photoId, ids);
      return { ...result, sent: ids };
    } catch (caught) {
      // A busy list often bumps the revision. Retry once with the id the server now lists.
      if (!(caught instanceof RequestError) || caught.status !== 409 || caught.code !== 'revision_conflict' || !busy) throw caught;
      const fresh = await api.intake(listParams);
      const sent = ids.map(id => refreshedCandidateId(photoId, id, fresh));
      const result = await api.dismissCandidates(photoId, sent);
      return { ...result, sent };
    }
  };
  const enqueueDelete = (task: () => Promise<void>): void => {
    setDeletePending(count => count + 1);
    void deleteQueue.current.enqueue(task).finally(() => setDeletePending(count => Math.max(0, count - 1)));
  };
  const beginQuestionDelete = (id: string): void => {
    if (!id || inFlightQuestionIds.current.has(id)) return;
    inFlightQuestionIds.current.add(id);
    const next = new Set(hiddenQuestionsRef.current);
    next.add(id);
    hiddenQuestionsRef.current = next;
    setHiddenQuestions(next);
    enqueueDelete(async () => {
      let removed = false;
      try {
        const result = await api.discard([id]);
        if (result.failed[0]) notify(result.failed[0].message);
        removed = result.removed.includes(id);
      } catch (caught) {
        notify(caught instanceof Error ? caught.message : '没有移除');
      } finally {
        if (!removed) {
          setHiddenQuestions(current => {
            if (!current.has(id)) return current;
            const restored = new Set(current);
            restored.delete(id);
            hiddenQuestionsRef.current = restored;
            return restored;
          });
        }
        inFlightQuestionIds.current.delete(id);
      }
      await reload();
    });
  };
  const beginCandidateDelete = (requested: readonly CandidateDeleteBatch[]): void => {
    const batches = requested
      .map(batch => ({ photoId: batch.photoId, ids: batch.ids.filter(id => id && !inFlightCandidateIds.current.has(id)) }))
      .filter(batch => batch.photoId && batch.ids.length);
    if (!batches.length) return;
    const applied = applyCandidateHide(hiddenCandidatesRef.current, picksRef.current, batches);
    hiddenCandidatesRef.current = applied.hidden;
    picksRef.current = applied.picks;
    for (const batch of batches) for (const id of batch.ids) inFlightCandidateIds.current.add(id);
    setHiddenCandidates(applied.hidden);
    setPicked(applied.picks);
    const restorePicks = applied.restorePicks;
    enqueueDelete(async () => {
      const removed = new Set<string>();
      const failed = new Set<string>();
      const hideAlso: string[] = [];
      const failures: string[] = [];
      try {
        for (const batch of batches) {
          try {
            const result = await dismissBatch(batch.photoId, batch.ids);
            const matched = matchDismissResult(batch.ids, result.sent, result.removed);
            for (const id of matched.kept) removed.add(id);
            for (const id of matched.failed) failed.add(id);
            hideAlso.push(...matched.hideAlso);
            // HTTP 200 with nothing removed is the usual miss. Do not treat it as success.
            if (result.failed.length) failures.push(result.failed[0]?.message || '没有去掉');
          } catch (caught) {
            for (const id of batch.ids) failed.add(id);
            failures.push(caught instanceof Error ? caught.message : '没有去掉');
          }
        }
        if (failed.size || hideAlso.length) {
          setHiddenCandidates(current => {
            const next = new Set(current);
            for (const id of failed) next.delete(id);
            for (const id of hideAlso) next.add(id);
            hiddenCandidatesRef.current = next;
            return next;
          });
        }
        if (failed.size) {
          setPicked(current => {
            const next = restoreCandidateHide(new Set(), current, restorePicks, failed).picks;
            picksRef.current = next;
            return next;
          });
        }
        if (failures.length) notify(deleteFailureMessage(removed.size, failures), 8000);
      } finally {
        for (const batch of batches) for (const id of batch.ids) inFlightCandidateIds.current.delete(id);
      }
      await reload();
    });
  };
  const confirmDelete = (pending: PendingDelete): void => {
    const count = pending.kind === 'candidates' ? pending.batches.reduce((sum, batch) => sum + batch.ids.length, 0) : 0;
    if (pending.kind === 'candidates' && !count) return;
    const several = count > 1;
    void presentActionSheet({
      header: pending.kind === 'question' ? '把这道题移出错题本？' : several ? `去掉这 ${count} 道还没加入的题？` : '去掉这道还没加入的题？',
      subHeader: pending.kind === 'question' ? '原图保留，移出后可以在错题本撤销。' : '只从录入列表移除，不会加入错题本。',
      buttons: [
        {
          text: '删除',
          role: 'destructive',
          handler: () => {
            if (pending.kind === 'question') beginQuestionDelete(pending.id);
            else beginCandidateDelete(pending.batches);
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  };
  const include = async (photo: IntakePhoto): Promise<void> => {
    const addable = new Set(orderCandidates(photo.candidates).filter(row => canAddCandidate(row.verdict)).map(row => row.candidate.id));
    const ids = [...(picked[photo.id] ?? [])].filter(id => addable.has(id));
    if (!ids.length) return;
    if (ids.length > selectLimit) {
      notify(`一次最多加入 ${selectLimit} 道，多出来的请分批加入。`);
      return;
    }
    try {
      const result = await api.select(photo.id, ids);
      if (result.pending) notify(photo.progress?.stage === 'done' || photo.state === 'failed' ? '已保存选择；未通过校验的题暂未收录，请重试或补拍清楚的照片。' : `已保存 ${result.pending} 道选择，校验通过后会加入错题本。`);
      else if (result.skipped) notify(`${result.skipped} 道未加入，请查看更新后的题目再试。`);
      setPicked(currentPicks => ({ ...currentPicks, [photo.id]: new Set() }));
    }
    catch (caught) { notify(caught instanceof Error ? caught.message : '没加进去'); }
    await reload();
  };
  const setPick = (photoId: string, id: string, selected: boolean): void => {
    touched.current.add(intakePickKey(photoId, id));
    const prev = picked[photoId] ?? new Set<string>();
    if (selected && !prev.has(id) && prev.size >= selectLimit) {
      notify(`一次最多加入 ${selectLimit} 道，多出来的请分批加入。`);
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
    const displayed = orderCandidates(photo.candidates).filter(row => canAddCandidate(row.verdict) && !row.candidate.submitted).map(row => row.candidate.id);
    for (const id of displayed) touched.current.add(intakePickKey(photo.id, id));
    const selected = [...(picked[photo.id] ?? [])];
    const result = selectDisplayedPage(selected, displayed, selectLimit, pagePickState(selected, displayed) === 'all' ? 'none' : 'all');
    if (result.truncated) notify(`一次最多加入 ${selectLimit} 道，多出来的请分批加入。`);
    setPicked(currentPicks => ({ ...currentPicks, [photo.id]: new Set(result.ids) }));
  };
  const openDetail = (photo: IntakePhoto, candidate: IntakeCandidate, addable = true): void => {
    if (scrollerRef.current) liveScroll.current = scrollerRef.current.scrollTop;
    savedScroll.current = liveScroll.current;
    scrollFrozen.current = true;
    const token = ++detailToken.current;
    const mode = data?.mode === 'legacy' ? 'legacy' : 'materials';
    setDetailRequest({ photoId: photo.id, candidateId: candidate.id, label: candidate.label, mode, crop: candidate.crop, source: photo.full, addable });
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
    const ordered = orderCandidates(photo.candidates);
    const displayed = ordered.filter(row => canAddCandidate(row.verdict) && !row.candidate.submitted).map(row => row.candidate.id);
    const addable = new Set(ordered.filter(row => canAddCandidate(row.verdict)).map(row => row.candidate.id));
    const selected = [...(picked[photo.id] ?? [])].filter(id => addable.has(id));
    const pickState = pagePickState(selected, displayed);
    const hasFocus = ordered.some(row => row.focus);
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
          <IonItem button detail={false} className="intake-row" data-testid="intake-question" onClick={() => navigate(`/q/${question.id}`)}>
            <img slot="start" className="row-thumb" src={question.thumb} alt="" loading="lazy" />
            <IonLabel><h3>{question.excerpt || '题目文字暂不可用'}</h3><p>{question.chapter}</p></IonLabel>
            <button slot="end" type="button" className="intake-delete-button" data-testid="question-delete" aria-label={`删除${question.excerpt || '这道题'}`}
              onClick={event => { event.preventDefault(); event.stopPropagation(); confirmDelete({ kind: 'question', id: question.id }); }}>删除</button>
          </IonItem>
          <IonItemOptions side="end"><IonItemOption color="danger" data-testid="question-swipe-delete" onClick={() => beginQuestionDelete(question.id)}>删除</IonItemOption></IonItemOptions>
        </IonItemSliding>)}
        {photo.candidates.length ? <>
          <IonItem lines="full" className="intake-note"><IonLabel className="ion-text-wrap"><p data-testid="intake-page-note">{pageNote(!!photo.progress, hasFocus)}</p></IonLabel></IonItem>
          <div className="intake-candidates">
            {ordered.map(row => {
              const candidate = row.candidate;
              const process = processLabel(candidate.status);
              const addableRow = canAddCandidate(row.verdict);
              const checked = candidate.submitted || (picked[photo.id]?.has(candidate.id) ?? false);
              return <div
                key={candidate.id}
                className={['intake-candidate', row.focus ? 'intake-candidate-focus' : '', row.verdict === 'right' ? 'intake-candidate-right' : ''].filter(Boolean).join(' ')}
                data-testid="pick-candidate"
                data-candidate-id={candidate.id}
                data-verdict={row.verdict ?? 'none'}
                data-intake-focus={row.focus ? 'wrong' : undefined}
              >
              {addableRow ? <IonCheckbox
                className="intake-check"
                checked={checked}
                disabled={candidate.submitted}
                aria-label={`选择${candidate.label}`}
                data-testid="pick-checkbox"
                onIonChange={event => { if (event.detail.checked !== checked) setPick(photo.id, candidate.id, event.detail.checked); }}
              /> : <span className="intake-check-spacer" aria-hidden="true" />}
              {candidate.crop ? <img className="row-thumb" src={candidate.crop} alt="" loading="lazy" /> : null}
              <div className="intake-candidate-text">
                <h3>{candidate.excerpt || candidate.label}</h3>
                {candidate.excerpt ? <p>{candidate.label}</p> : null}
                {process ? <p>{process}</p> : null}
                {candidate.submitted ? <p>{(photo.progress?.stage === 'done' || photo.state === 'failed') && candidate.status !== 'verified' ? '已选，暂未收录；请重试或补拍清楚的照片。' : '已选，校验通过后加入'}</p> : null}
              </div>
              <button
                type="button"
                className="intake-detail-button"
                data-testid="candidate-detail"
                aria-label={`查看${candidate.label}的详情`}
                onClick={() => openDetail(photo, candidate, addableRow)}
              >查看详情</button>
              <button
                type="button"
                className="intake-delete-button"
                data-testid="candidate-delete"
                aria-label={`删除${candidate.label}，不加入错题本`}
                onClick={() => confirmDelete({ kind: 'candidates', batches: [{ photoId: photo.id, ids: [candidate.id] }] })}
              >删除</button>
            </div>;
            })}
          </div>
          <div className="intake-actions">
            <IonButton fill="clear" color="danger" size="default" disabled={!selected.length} data-testid="candidate-delete-selected" onClick={() => confirmDelete({ kind: 'candidates', batches: [{ photoId: photo.id, ids: selected }] })}>删除所选</IonButton>
            <IonButton size="default" disabled={!selected.length} onClick={() => void include(photo)} data-testid="pick-submit">加入{selected.length ? ` ${selected.length} 道` : ''}</IonButton>
          </div>
        </> : null}
        {photo.failure ? <IonItem lines="none" className="intake-failure">
          <IonLabel className="ion-text-wrap"><p className="tone-red">{photo.failure.detail}</p></IonLabel>
          {photo.failure.retryable ? <IonButton slot="end" fill="clear" onClick={() => { void api.retry(photo.id).then(reload).catch(caught => notify(caught instanceof Error ? caught.message : '没重试成功')); }}>重试</IonButton> : null}
          {data?.mode === 'legacy' ? <IonButton slot="end" fill="clear" color="medium" onClick={() => { void api.dismiss(photo.id).then(reload); }}>不要了</IonButton> : null}
        </IonItem> : null}
      </IonList>
    </section>;
  };

  const renderGroup = (group: IntakeGroup): ReactNode => {
    const ordered = orderCandidates(group.candidates);
    const addable = ordered.filter(row => canAddCandidate(row.verdict) && !row.candidate.submitted).map(row => row.candidate);
    const selected = addable.filter(candidate => picked[candidate.photoId ?? '']?.has(candidate.id));
    const displayed = addable.map(candidate => candidate.id);
    const pickState = pagePickState(selected.map(candidate => candidate.id), displayed);
    const hasFocus = ordered.some(row => row.focus);
    const failedPhotos = failedGroupPhotos(group.photoIds, photos);
    const toggleGroup = (): void => {
      const clearing = pickState === 'all';
      const byPhoto = new Map<string, string[]>();
      for (const candidate of addable) {
        if (!candidate.photoId) continue;
        touched.current.add(intakePickKey(candidate.photoId, candidate.id));
        byPhoto.set(candidate.photoId, [...(byPhoto.get(candidate.photoId) ?? []), candidate.id]);
      }
      setPicked(currentPicks => {
        const next = { ...currentPicks };
        for (const [photoId, ids] of byPhoto) {
          const result = selectDisplayedPage([...(currentPicks[photoId] ?? [])], ids, selectLimit, clearing ? 'none' : 'all');
          if (result.truncated) notify(`一次最多加入 ${selectLimit} 道，多出来的请分批加入。`);
          next[photoId] = new Set(result.ids);
        }
        return next;
      });
    };
    const includeGroup = async (): Promise<void> => {
      const byPhoto = new Map<string, string[]>();
      for (const candidate of selected) {
        if (!candidate.photoId) continue;
        byPhoto.set(candidate.photoId, [...(byPhoto.get(candidate.photoId) ?? []), candidate.id]);
      }
      if ([...byPhoto.values()].some(ids => ids.length > selectLimit)) {
        notify(`一次最多加入 ${selectLimit} 道，多出来的请分批加入。`);
        return;
      }
      try {
        for (const [photoId, ids] of byPhoto) {
          const result = await api.select(photoId, ids);
          if (result.pending) notify(`已保存 ${result.pending} 道选择，校验通过后会加入错题本。`);
          else if (result.skipped) notify(`${result.skipped} 道未加入，请查看更新后的题目再试。`);
        }
        setPicked(currentPicks => {
          const next = { ...currentPicks };
          for (const [photoId, ids] of byPhoto) {
            const gone = new Set(ids);
            next[photoId] = new Set([...(next[photoId] ?? [])].filter(id => !gone.has(id)));
          }
          return next;
        });
      } catch (caught) { notify(caught instanceof Error ? caught.message : '没加进去'); }
      await reload();
    };
    return <section key={group.id} className="intake-photo" data-testid="intake-question-card" data-question={group.title}>
      <IonList inset lines="full">
        <IonItem lines="full" className="intake-head" detail={false}>
          <div slot="start" className="intake-thumbs">{group.thumbs.map(thumb => <img key={thumb.src} src={thumb.src} alt="" />)}</div>
          <IonLabel><h2>{group.title}</h2><p data-testid="intake-group-status">{group.status}</p></IonLabel>
          {displayed.length ? <button
            slot="end"
            type="button"
            className="intake-page-toggle"
            data-testid="pick-page"
            aria-pressed={pickState === 'all' ? 'true' : pickState === 'some' ? 'mixed' : 'false'}
            aria-label={pickState === 'all' ? `取消全选${group.title}` : `全选${group.title}`}
            onClick={toggleGroup}
          >{pickState === 'all' ? '取消全选' : '全选本题'}</button> : null}
        </IonItem>
        {failedPhotos.map(photo => <IonItem key={photo.id} lines="none" className="intake-failure" data-testid="intake-group-failure">
          <IonLabel className="ion-text-wrap"><p className="tone-red">{photo.failure?.detail}</p></IonLabel>
          {photo.failure?.retryable ? <IonButton slot="end" fill="clear" data-testid="intake-group-retry" onClick={() => { void api.retry(photo.id).then(reload).catch(caught => notify(caught instanceof Error ? caught.message : '没重试成功')); }}>重试</IonButton> : null}
        </IonItem>)}
        {group.questions.map(question => <IonItemSliding key={question.id}>
          <IonItem button detail={false} className="intake-row" data-testid="intake-question" onClick={() => navigate(`/q/${question.id}`)}>
            <img slot="start" className="row-thumb" src={question.thumb} alt="" loading="lazy" />
            <IonLabel><h3>{question.excerpt || '题目文字暂不可用'}</h3><p>{question.chapter}</p></IonLabel>
          </IonItem>
        </IonItemSliding>)}
        {group.candidates.length ? <>
          <IonItem lines="full" className="intake-note"><IonLabel className="ion-text-wrap"><p data-testid="intake-page-note">{groupNote(hasFocus)}</p></IonLabel></IonItem>
          <div className="intake-candidates">
            {ordered.map(row => {
              const candidate = row.candidate;
              const process = processLabel(candidate.status);
              const addableRow = canAddCandidate(row.verdict);
              const photoId = candidate.photoId ?? '';
              const checked = candidate.submitted || (picked[photoId]?.has(candidate.id) ?? false);
              const photo = photos.find(item => item.id === photoId);
              return <div
                key={candidate.id}
                className={['intake-candidate', row.focus ? 'intake-candidate-focus' : '', row.verdict === 'right' ? 'intake-candidate-right' : ''].filter(Boolean).join(' ')}
                data-testid="pick-candidate"
                data-candidate-id={candidate.id}
                data-verdict={row.verdict ?? 'none'}
                data-intake-focus={row.focus ? 'wrong' : undefined}
              >
                {addableRow ? <IonCheckbox
                  className="intake-check"
                  checked={checked}
                  disabled={candidate.submitted}
                  aria-label={`选择${candidate.label}`}
                  data-testid="pick-checkbox"
                  onIonChange={event => { if (event.detail.checked !== checked) setPick(photoId, candidate.id, event.detail.checked); }}
                /> : <span className="intake-check-spacer" aria-hidden="true" />}
                {candidate.crop ? <img className="row-thumb" src={candidate.crop} alt="" /> : null}
                <div className="intake-candidate-text">
                  <h3>{candidate.excerpt || candidate.label}</h3>
                  {candidate.excerpt ? <p>{candidate.label}</p> : null}
                  {process ? <p>{process}</p> : null}
                </div>
                <button type="button" className="intake-detail-button" data-testid="candidate-detail" aria-label={`查看${candidate.label}的详情`} onClick={() => { if (photo) openDetail(photo, candidate, addableRow); }}>查看详情</button>
                <button type="button" className="intake-delete-button" data-testid="candidate-delete" aria-label={`删除${candidate.label}，不加入错题本`} onClick={() => confirmDelete({ kind: 'candidates', batches: [{ photoId, ids: [candidate.id] }] })}>删除</button>
              </div>;
            })}
          </div>
          <div className="intake-actions">
            <IonButton fill="clear" color="danger" size="default" disabled={!selected.length} data-testid="candidate-delete-selected" onClick={() => {
              const batches = batchesByPhoto(selected);
              if (!batches.length) return;
              if (batches.some(batch => batch.ids.length > selectLimit)) {
                notify(`一次最多去掉 ${selectLimit} 道，多出来的请分批去掉。`);
                return;
              }
              confirmDelete({ kind: 'candidates', batches });
            }}>删除所选</IonButton>
            <IonButton size="default" disabled={!selected.length} onClick={() => void includeGroup()} data-testid="pick-submit">加入{selected.length ? ` ${selected.length} 道` : ''}</IonButton>
          </div>
        </> : null}
      </IonList>
    </section>;
  };

  const groups = (listReady ? data?.groups ?? [] : []).map(group => {
    if (!hiddenCandidates.size) return group;
    const candidates = group.candidates.filter(candidate => !hiddenCandidates.has(candidate.id));
    return candidates.length === group.candidates.length ? group : { ...group, candidates };
  });
  const groupedPhotoIds = new Set(groups.flatMap(group => group.photoIds));
  const currentIds = new Set(current.map(photo => photo.id));
  const currentGroups = groups.filter(group => group.photoIds.some(id => currentIds.has(id)));
  const earlierGroups = groups.filter(group => !currentGroups.includes(group) && group.photoIds.some(id => earlier.some(photo => photo.id === id)));

  return <IonPage>
    <IonContent fullscreen className="intake" ref={setContent}>
      <div className="intake-top">
        <h1>录入</h1>
        <p className="muted" role="status">{pendingUploads.length ? `正在上传 · 还剩 ${pendingUploads.filter(entry => entry.state !== 'failed').length} 张` : !listReady ? '正在查找…' : filter.enabled ? (busy ? 'AI 正在找题' : data?.total ? `这一天上传了 ${data.total} 张` : '这一天没有上传的材料') : busy ? 'AI 正在找题' : found ? `找到 ${found} 道，已加入错题本 · 不相关的可以删掉` : current.length ? '这一批没有新增错题' : '还没有录入'}</p>
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
      {currentGroups.map(renderGroup)}
      {current.filter(photo => !groupedPhotoIds.has(photo.id)).map(renderPhoto)}
      {filter.enabled && listReady && ((data?.page ?? 0) > 0 || data?.hasMore) ? <div className="intake-pager">
        <IonButton fill="clear" disabled={!filter.page} data-testid="day-filter-prev" onClick={() => dispatchFilter({ type: 'page', page: filter.page - 1 })}>上一页</IonButton>
        <IonButton fill="clear" disabled={!data?.hasMore} data-testid="day-filter-next" onClick={() => dispatchFilter({ type: 'page', page: filter.page + 1 })}>下一页</IonButton>
      </div> : null}
      {earlier.length ? <details className="intake-earlier"><summary>更早的 {earlier.length} 张</summary>{earlierGroups.map(renderGroup)}{earlier.filter(photo => !groupedPhotoIds.has(photo.id)).map(renderPhoto)}</details> : null}
      <div className="bottom-space intake-space" data-testid="intake-scroll-pad" style={dockPad > 0 ? { height: dockPad } : undefined} />
      <div className="intake-bottom" ref={bottomRef}>
        {deletePending > 0 ? <p className="intake-delete-progress" role="status" aria-live="polite" aria-busy="true" data-testid="intake-delete-progress"><IonSpinner name="lines-small" /> 正在删除…</p> : null}
        <p className="intake-selected" role="status" data-testid="intake-selected">{selectedText}</p>
        <IonButton expand="block" shape="round" size="large" onClick={() => { uploader.finishBatch(); navigate('/', { replace: true }); }} data-testid="intake-done"><IonIcon icon={checkmark} slot="start" />完成</IonButton>
        <CaptureDock placement="inline" />
      </div>
      <IonToast isOpen={!!toast} message={toast ?? ''} duration={toastMs} onDidDismiss={() => setToast(null)} />
      <CandidateDetailModal
        open={!!detailRequest}
        title={detailRequest?.label ?? '题目'}
        loading={detailLoading}
        error={detailError}
        detail={detailBody}
        previewCrop={detailRequest?.mode === 'materials' ? detailRequest.crop : null}
        legacy={detailRequest?.mode === 'legacy' ? { crop: detailRequest.crop, source: detailRequest.source } : null}
        selected={detailRequest ? (picked[detailRequest.photoId]?.has(detailRequest.candidateId) || photos.some(p => p.id === detailRequest.photoId && p.candidates.some(c => c.id === detailRequest.candidateId && c.submitted))) : false}
        terminal={!!detailRequest && photos.some(p => p.id === detailRequest.photoId && (p.progress?.stage === 'done' || p.state === 'failed'))}
        submitted={!!detailRequest && photos.some(p => p.id === detailRequest.photoId && p.candidates.some(c => c.id === detailRequest.candidateId && c.submitted))}
        addable={detailRequest?.addable !== false}
        onToggleSelected={selected => { if (detailRequest) setPick(detailRequest.photoId, detailRequest.candidateId, selected); }}
        onRequestClose={requestCloseDetail}
        onClosed={closeDetail}
      />
    </IonContent>
  </IonPage>;
}
