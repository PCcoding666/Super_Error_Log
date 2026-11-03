import { IonIcon, useIonViewWillEnter, useIonViewWillLeave } from '@ionic/react';
import { albumsOutline, cameraOutline } from 'ionicons/icons';
import { useNavigate } from 'react-router-dom';
import { useState, type ReactNode } from 'react';
import { MAX_SET_PAGES, captureSession, hintsForPages, useCaptureSession, type CaptureMode } from '../lib/captureSession';
import { uploader } from '../lib/uploader';
import { PickLabel } from './CaptureInput';

function ModeBar(props: { mode: CaptureMode }): ReactNode {
  return <div className="capture-mode-bar" role="radiogroup" aria-label="拍摄模式" data-testid="capture-mode-bar">
    <button type="button" role="radio" aria-checked={props.mode === 'single'} data-testid="capture-mode-single" onClick={() => captureSession.setMode('single')}>单页</button>
    <button type="button" role="radio" aria-checked={props.mode === 'multi'} data-testid="capture-mode-multi" onClick={() => captureSession.setMode('multi')}>多页</button>
  </div>;
}

/**
 * Bottom capture controls. The phone's own camera has no place for our buttons, so the
 * 单页 / 多页 bar sits on this surface, above the safe area. 单页 still opens the native
 * camera and uploads that one photo. 多页 keeps each shot here until 完成.
 */
export function CaptureDock(props: {
  placement: 'corner' | 'inline';
  cameraInputId?: string;
  albumInputId?: string;
  albumTestId?: string;
}): ReactNode {
  const navigate = useNavigate();
  const { mode, pages, overflow } = useCaptureSession();
  // Ionic keeps the previous page mounted. A second dock would cover this one and duplicate #camera-input.
  const [active, setActive] = useState(true);
  useIonViewWillEnter(() => setActive(true));
  useIonViewWillLeave(() => setActive(false));
  if (!active) return null;
  const tray = pages.length > 0;
  const finish = (): void => {
    const staged = captureSession.take();
    if (!staged.length) return;
    uploader.add(staged.map(page => page.file), { hints: hintsForPages(staged), setId: crypto.randomUUID() });
    navigate('/new');
  };
  const picks = props.placement === 'inline'
    ? <div className="intake-picks">
        <PickLabel kind="camera" className="pick-button pick-text" testId="intake-camera"><IonIcon icon={cameraOutline} aria-hidden="true" />拍照</PickLabel>
        <PickLabel kind="album" className="pick-button pick-text" testId="intake-album"><IonIcon icon={albumsOutline} aria-hidden="true" />从相册选择</PickLabel>
      </div>
    : <div className="capture-dock-picks">
        <PickLabel kind="camera" className="fab-circle fab-camera" inputId={props.cameraInputId}><IonIcon icon={cameraOutline} aria-hidden="true" /></PickLabel>
        <PickLabel kind="album" className="fab-circle fab-album" inputId={props.albumInputId} testId={props.albumTestId}><IonIcon icon={albumsOutline} aria-hidden="true" /></PickLabel>
      </div>;
  const body = <>
    {tray ? <div className="capture-tray" data-testid="capture-tray">
      <div className="capture-tray-head">
        <p data-testid="capture-count">已拍 {pages.length} 张</p>
        <button type="button" className="capture-done" data-testid="capture-set-done" onClick={finish}>完成</button>
      </div>
      <ul className="capture-film" aria-label="这次拍的页">
        {pages.map((page, index) => <li key={page.id} data-testid="capture-page">
          {page.previewUrl ? <img src={page.previewUrl} alt="" /> : <span className="capture-film-fallback" aria-hidden="true" />}
          <button type="button" className="capture-page-delete" aria-label={`删除第 ${index + 1} 张`} data-testid="capture-page-delete" onClick={() => captureSession.remove(page.id)}>×</button>
          <div className="capture-kinds" role="group" aria-label={`第 ${index + 1} 张是`}>
            <button type="button" aria-pressed={page.kind === 'paper'} onClick={() => captureSession.setKind(page.id, page.kind === 'paper' ? null : 'paper')}>试卷</button>
            <button type="button" aria-pressed={page.kind === 'answer_sheet'} onClick={() => captureSession.setKind(page.id, page.kind === 'answer_sheet' ? null : 'answer_sheet')}>答题卡</button>
          </div>
        </li>)}
      </ul>
      {overflow ? <p className="capture-overflow" data-testid="capture-overflow">一次最多 {MAX_SET_PAGES} 页</p> : null}
    </div> : null}
    {picks}
    <ModeBar mode={mode} />
  </>;
  if (props.placement === 'inline') return <div className="capture-inline" data-testid="capture-dock">{body}</div>;
  return <div className={`capture-dock${tray ? ' has-tray' : ''}`} slot="fixed" data-testid="capture-dock">{body}</div>;
}
