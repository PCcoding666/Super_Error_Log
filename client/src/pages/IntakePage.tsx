import { IonButton, IonCheckbox, IonContent, IonIcon, IonItem, IonItemOption, IonItemOptions, IonItemSliding, IonLabel, IonList, IonPage, IonSpinner, IonToast } from '@ionic/react';
import { albumsOutline, cameraOutline, checkmark } from 'ionicons/icons';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { IntakePhoto } from '../../../src/web/apiTypes';
import { PickLabel } from '../components/CaptureInput';
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

/** 录入态：一次上传算一个批次，按照片分段；找到的题默认已在错题本，左滑删掉不相关的；没批改痕迹的页勾出做错的题。 */
export function IntakePage(): ReactNode {
  const navigate = useNavigate();
  const uploads = useUploads();
  const { data, error, reload } = useLoad(() => api.intake(), []);
  const [picked, setPicked] = useState<Record<string, Set<string>>>({});
  const [toast, setToast] = useState<string | null>(null);
  const uploading = uploads.some(entry => entry.state !== 'succeeded' && entry.state !== 'failed');
  const uploadedIds = useMemo(() => new Set(uploader.batchIds), [uploads]);

  useEffect(() => { if (data) uploader.setMode(data.mode === 'materials' && data.draftNamespace ? { kind: 'materials', namespace: data.draftNamespace } : { kind: 'legacy' }); }, [data]);
  // 还在找题、还在上传、或刚传完还没登记：每 3 秒取一次，只换数据不整页刷新。
  const busy = !!data?.busy || uploading || uploads.some(entry => entry.state === 'succeeded' && !data?.photos.some(photo => photo.id === entry.photoId));
  useEffect(() => { if (!busy) return; const timer = setInterval(() => { void reload(); }, 3000); return () => clearInterval(timer); }, [busy, reload]);

  const batchSize = uploadedIds.size + uploads.filter(entry => !entry.photoId).length;
  const photos: IntakePhoto[] = data?.photos ?? [];
  // 本批上传的照片在前，其余（历史）折在后面。
  // 本批按拍摄先后排（和学生选照片的顺序一致）；没有本批时只展开最近一张。
  const current = (batchSize ? photos.filter(photo => uploadedIds.has(photo.id)) : photos.slice(0, 1)).slice().sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt) || a.number - b.number);
  const earlier = photos.filter(photo => !current.includes(photo));
  const found = current.reduce((n, photo) => n + photo.questions.length, 0);
  const pendingUploads = uploads.filter(entry => !entry.photoId);

  const remove = async (itemId: string): Promise<void> => {
    try { const result = await api.discard([itemId]); if (result.failed[0]) setToast(result.failed[0].message); }
    catch (caught) { setToast(caught instanceof Error ? caught.message : '没有移除'); }
    await reload();
  };
  const include = async (photo: IntakePhoto): Promise<void> => {
    const ids = [...(picked[photo.id] ?? [])];
    if (!ids.length) return;
    try { await api.select(photo.id, ids); setPicked(current => ({ ...current, [photo.id]: new Set() })); }
    catch (caught) { setToast(caught instanceof Error ? caught.message : '没加进去'); }
    await reload();
  };
  const togglePick = (photoId: string, id: string): void => setPicked(current => { const next = new Set(current[photoId] ?? []); if (next.has(id)) next.delete(id); else next.add(id); return { ...current, [photoId]: next }; });

  const renderPhoto = (photo: IntakePhoto, index: number): ReactNode => <section key={photo.id} className="intake-photo" data-testid={`photo-row-${photo.number}`} data-state={photo.state}>
    <IonList inset lines="full">
      <IonItem lines="full" className="intake-head" detail={false}>
        <a slot="start" className="intake-thumb" href={photo.full} target="_blank" rel="noreferrer" aria-label="查看原图"><img src={photo.thumb} alt="" loading="lazy" /></a>
        <IonLabel><h2>第 {current.length > 1 ? index + 1 : photo.number} 张{photo.questions.length ? ` · ${photo.questions.length} 道` : ''}</h2><p>{timeLabel(photo.takenAt)} · {photo.statusText}</p></IonLabel>
        {photo.state === 'finding' ? <IonSpinner slot="end" name="lines-small" /> : null}
      </IonItem>
      {photo.questions.map(question => <IonItemSliding key={question.id}>
        <IonItem routerLink={`/q/${question.id}`} detail={false} className="intake-row" data-testid="intake-question">
          <img slot="start" className="row-thumb" src={question.thumb} alt="" loading="lazy" />
          <IonLabel><h3>{question.excerpt || '题目文字暂不可用'}</h3><p>{question.chapter}</p></IonLabel>
        </IonItem>
        <IonItemOptions side="end"><IonItemOption color="danger" onClick={() => void remove(question.id)}>删除</IonItemOption></IonItemOptions>
      </IonItemSliding>)}
      {photo.candidates.length ? <>
        <IonItem lines="full" className="intake-note"><IonLabel className="ion-text-wrap"><p>这页没有批改痕迹，勾出做错的题</p></IonLabel></IonItem>
        {photo.candidates.map(candidate => <IonItem key={candidate.id} button detail={false} className="intake-row" onClick={() => togglePick(photo.id, candidate.id)} data-testid="pick-candidate">
          <IonCheckbox slot="start" checked={picked[photo.id]?.has(candidate.id) ?? false} aria-label={candidate.label} onIonChange={() => togglePick(photo.id, candidate.id)} />
          {candidate.crop ? <img className="row-thumb" src={candidate.crop} alt="" loading="lazy" /> : null}
          <IonLabel><h3>{candidate.excerpt || candidate.label}</h3>{candidate.excerpt ? <p>{candidate.label}</p> : null}</IonLabel>
        </IonItem>)}
        <IonItem lines="none"><IonButton slot="end" size="default" disabled={!(picked[photo.id]?.size)} onClick={() => void include(photo)} data-testid="pick-submit">加入{picked[photo.id]?.size ? ` ${picked[photo.id]!.size} 道` : ''}</IonButton></IonItem>
      </> : null}
      {photo.failure ? <IonItem lines="none" className="intake-failure">
        <IonLabel className="ion-text-wrap"><p className="tone-red">{photo.failure.detail}</p></IonLabel>
        {photo.failure.retryable ? <IonButton slot="end" fill="clear" onClick={() => { void api.retry(photo.id).then(reload).catch(caught => setToast(caught instanceof Error ? caught.message : '没重试成功')); }}>重试</IonButton> : null}
        {data?.mode === 'legacy' ? <IonButton slot="end" fill="clear" color="medium" onClick={() => { void api.dismiss(photo.id).then(reload); }}>不要了</IonButton> : null}
      </IonItem> : null}
    </IonList>
  </section>;

  return <IonPage>
    <IonContent fullscreen className="intake">
      <div className="intake-top">
        <h1>录入</h1>
        <p className="muted" role="status">{pendingUploads.length ? `正在上传 · 还剩 ${pendingUploads.filter(entry => entry.state !== 'failed').length} 张` : busy ? 'AI 正在找题' : found ? `找到 ${found} 道，已加入错题本 · 不相关的左滑删掉` : current.length ? '这一批没有新增错题' : '还没有录入'}</p>
      </div>
      {pendingUploads.length ? <IonList inset lines="full" className="upload-list">
        {pendingUploads.map(entry => <IonItem key={entry.key} className="intake-head" detail={false} data-upload-state={entry.state}>
          {entry.previewUrl ? <img slot="start" className="intake-thumb" src={entry.previewUrl} alt="" /> : null}
          <IonLabel><h2>{entry.name}</h2><p className={entry.state === 'failed' ? 'tone-red' : undefined}>{entry.message}</p></IonLabel>
          {entry.state === 'preparing' || entry.state === 'uploading' ? <IonSpinner slot="end" name="lines-small" /> : null}
        </IonItem>)}
        {pendingUploads.some(entry => entry.state === 'failed' && entry.retryable) ? <IonItem lines="none"><IonButton slot="end" fill="clear" onClick={() => uploader.retry()} data-testid="upload-retry">再试一次</IonButton></IonItem> : null}
      </IonList> : null}
      {error ? <Problem message={error.message} onRetry={() => void reload()} /> : null}
      {current.map(renderPhoto)}
      {earlier.length ? <details className="intake-earlier"><summary>更早的 {earlier.length} 张</summary>{earlier.map(renderPhoto)}</details> : null}
      <div className="bottom-space intake-space" />
      <div className="intake-bottom">
        <IonButton expand="block" shape="round" size="large" onClick={() => { uploader.finishBatch(); navigate('/', { replace: true }); }} data-testid="intake-done"><IonIcon icon={checkmark} slot="start" />完成</IonButton>
        <div className="intake-picks">
          <PickLabel kind="camera" className="pick-button pick-text" testId="intake-camera"><IonIcon icon={cameraOutline} aria-hidden="true" />拍照</PickLabel>
          <PickLabel kind="album" className="pick-button pick-text" testId="intake-album"><IonIcon icon={albumsOutline} aria-hidden="true" />从相册选择</PickLabel>
        </div>
      </div>
      <IonToast isOpen={!!toast} message={toast ?? ''} duration={3000} onDidDismiss={() => setToast(null)} />
    </IonContent>
  </IonPage>;
}
