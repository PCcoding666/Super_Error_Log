import { IonIcon, useIonViewWillEnter, useIonViewWillLeave } from '@ionic/react';
import { albumsOutline, cameraOutline } from 'ionicons/icons';
import { useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { captureEntryAction, deviceOffersCombinedCapture, pickerLease, showCaptureModeBar, type CaptureChoiceKind, type CaptureRouteKind } from '../lib/captureEntry';
import { MAX_SET_PAGES, captureSession, hintsForPages, useCaptureSession, type CaptureMode } from '../lib/captureSession';
import { uploader } from '../lib/uploader';
import { PickLabel } from './CaptureInput';

function useCaptureRoute(): CaptureRouteKind | null {
  const [route, setRoute] = useState<CaptureRouteKind | null>(() => uploader.knownRoute()?.kind ?? null);
  useEffect(() => {
    let live = true;
    void uploader.route().then(mode => { if (live) setRoute(mode.kind); }).catch(() => { if (live) setRoute('legacy'); });
    return () => { live = false; };
  }, []);
  return route;
}

export function CaptureModeSwitch(): ReactNode {
  const route = useCaptureRoute();
  const { mode } = useCaptureSession();
  // The old single-page flow has no multi-page tray. The pill stays off until the route is materials.
  if (route !== 'materials') return null;
  return <div className="capture-mode-switch" data-testid="capture-mode-switch">
    <div className="capture-mode-bar" role="radiogroup" aria-label="拍摄模式" data-testid="capture-mode-bar">
      <button type="button" role="radio" aria-checked={mode === 'single'} data-testid="capture-mode-single" onClick={() => captureSession.setMode('single')}>单页</button>
      <button type="button" role="radio" aria-checked={mode === 'multi'} data-testid="capture-mode-multi" onClick={() => captureSession.setMode('multi')}>多页</button>
    </div>
    <p className="capture-mode-note">试卷和答题卡不在同一张纸上，或一道题的材料有好几页时，用「多页」。</p>
  </div>;
}

function useCombinedCapture(): boolean {
  const [combined, setCombined] = useState(deviceOffersCombinedCapture);
  useEffect(() => setCombined(deviceOffersCombinedCapture()), []);
  return combined;
}

/**
 * Camera and album entry. The 单页 / 多页 pill is separate, so this tap opens the system picker.
 * Do not script a click on a hidden file input.
 */
export function CaptureEntry(props: {
  kind: CaptureChoiceKind;
  className?: string;
  testId?: string;
  inputId?: string;
  /** Icon-only controls pass a name. Buttons that already show text leave this unset. */
  label?: string;
  /** One input: iOS already offers the camera and the photo library. */
  combined?: boolean;
  children: ReactNode;
}): ReactNode {
  const route = useCaptureRoute();
  const { mode, pages } = useCaptureSession();
  const leased = useRef(false);
  const pinSingle = useRef(false);
  const leaseEnd = useRef<(() => void) | null>(null);
  const [, bump] = useState(0);
  const action = captureEntryAction(route, pages.length, mode);
  const disarm = (): void => {
    if (!leased.current) return;
    leased.current = false;
    pinSingle.current = false;
    leaseEnd.current?.();
    leaseEnd.current = null;
    bump(value => value + 1);
  };
  const arm = (): void => {
    if (leased.current) return;
    // A picker opened before materials is known must stay 单页, even if the route arrives as materials
    // and localStorage still says 多页.
    pinSingle.current = route !== 'materials';
    leased.current = true;
    leaseEnd.current = pickerLease.begin();
    bump(value => value + 1);
  };
  useEffect(() => () => {
    leaseEnd.current?.();
    leaseEnd.current = null;
    leased.current = false;
  }, []);
  // An in-flight picker keeps its input. Held and the idle chooser only replace it after the picker ends.
  if (!leased.current && action === 'held') {
    return <button
      type="button"
      className={`${props.className ?? ''} is-held`}
      data-testid={props.testId}
      aria-label={props.label}
      aria-disabled="true"
      aria-describedby="capture-mode-hold"
    >{props.children}</button>;
  }
  return <PickLabel
    kind={props.kind}
    combined={props.combined}
    className={props.className}
    testId={props.testId}
    inputId={props.inputId}
    inputLabel={props.combined ? '拍照或从相册选择' : props.label}
    route={route}
    mode={pinSingle.current || route !== 'materials' ? 'single' : mode}
    onArm={arm}
    onPicked={disarm}
    onCancel={disarm}
  >{props.children}</PickLabel>;
}

/**
 * Bottom capture controls. The 单页 / 多页 pill is already chosen before these buttons open a picker.
 * iPhone uses one button. Android keeps camera and album apart.
 */
export function CaptureDock(props: {
  placement: 'corner' | 'inline';
  cameraInputId?: string;
  albumInputId?: string;
  albumTestId?: string;
  cameraTestId?: string;
  /** Empty notebook already shows the pill in the page body. */
  showMode?: boolean;
}): ReactNode {
  const navigate = useNavigate();
  const { mode, pages, overflow } = useCaptureSession();
  // Ionic keeps the previous page mounted. A second dock would cover this one and duplicate #camera-input.
  const [active, setActive] = useState(true);
  const route = useCaptureRoute();
  const combined = useCombinedCapture();
  useIonViewWillEnter(() => setActive(true));
  useIonViewWillLeave(() => setActive(false));
  useEffect(() => {
    if (!active || route !== 'legacy') return;
    captureSession.setMode('single');
    if (captureSession.pages.length === 0) return;
    // A tray staged before we knew this server is legacy must not sit here as 多页. Upload the photos as single pages.
    const staged = captureSession.take();
    uploader.add(staged.map(page => page.file));
    navigate('/new');
  }, [active, route, navigate]);
  const action = captureEntryAction(route, pages.length, mode);
  if (!active) return null;
  const tray = pages.length > 0;
  const finish = (): void => {
    const staged = captureSession.take();
    if (!staged.length) return;
    uploader.add(staged.map(page => page.file), { hints: hintsForPages(staged), setId: crypto.randomUUID() });
    navigate('/new');
  };
  const cameraLabel = combined ? '拍照或从相册选择' : '拍照';
  const picks = props.placement === 'inline'
    ? <div className="intake-picks">
        <CaptureEntry kind="camera" combined={combined} className="pick-button pick-text" testId="intake-camera" label={cameraLabel}><IonIcon icon={cameraOutline} aria-hidden="true" />{combined ? '拍照或从相册选择' : '拍照'}</CaptureEntry>
        {combined ? null : <CaptureEntry kind="album" className="pick-button pick-text" testId="intake-album"><IonIcon icon={albumsOutline} aria-hidden="true" />从相册选择</CaptureEntry>}
      </div>
    : <div className="capture-dock-picks">
        <CaptureEntry kind="camera" combined={combined} className="fab-circle fab-camera" inputId={props.cameraInputId} testId={props.cameraTestId} label={cameraLabel}><IonIcon icon={cameraOutline} aria-hidden="true" /></CaptureEntry>
        {combined ? null : <CaptureEntry kind="album" className="fab-circle fab-album" inputId={props.albumInputId} testId={props.albumTestId} label="从相册选择"><IonIcon icon={albumsOutline} aria-hidden="true" /></CaptureEntry>}
      </div>;
  const body = <>
    {tray ? <div className="capture-tray" data-testid="capture-tray">
      <div className="capture-tray-head">
        <p data-testid="capture-count">已拍 {pages.length} 张</p>
        <span className="capture-tray-actions">
          <button type="button" className="capture-discard" data-testid="capture-set-discard" onClick={() => captureSession.discard()}>放弃这组</button>
          <button type="button" className="capture-done" data-testid="capture-set-done" onClick={finish}>完成</button>
        </span>
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
    {action === 'held' ? <p id="capture-mode-hold" className="capture-mode-hold" data-testid="capture-mode-hold" role="status">这组还在。先点完成或放弃，再拍单页。</p> : null}
    {props.showMode !== false && showCaptureModeBar(route, pages.length) ? <CaptureModeSwitch /> : null}
    {picks}
  </>;
  if (props.placement === 'inline') {
    return <div className="capture-inline" data-testid="capture-dock" data-capture-route={route ?? 'pending'} data-capture-choice={action}>{body}</div>;
  }
  return <div className={`capture-dock${tray ? ' has-tray' : ''}`} slot="fixed" data-testid="capture-dock" data-capture-route={route ?? 'pending'} data-capture-choice={action}>{body}</div>;
}
