import { IonIcon, useIonViewWillEnter, useIonViewWillLeave } from '@ionic/react';
import { albumsOutline, cameraOutline } from 'ionicons/icons';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { captureChoice, captureEntryAction, pickerLease, showCaptureModeBar, type CaptureChoiceKind, type CaptureRouteKind } from '../lib/captureEntry';
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

function usePickerOpen(): boolean {
  const [open, setOpen] = useState(pickerLease.open);
  useEffect(() => pickerLease.subscribe(() => setOpen(pickerLease.open)), []);
  return open;
}

function useChoiceKind(): CaptureChoiceKind | null {
  const [kind, setKind] = useState<CaptureChoiceKind | null>(captureChoice.kind);
  useEffect(() => captureChoice.subscribe(() => setKind(captureChoice.kind)), []);
  return kind;
}

function ModeBar(props: { mode: CaptureMode }): ReactNode {
  return <div className="capture-mode-bar" role="radiogroup" aria-label="拍摄模式" data-testid="capture-mode-bar">
    <button type="button" role="radio" aria-checked={props.mode === 'single'} data-testid="capture-mode-single" onClick={() => captureSession.setMode('single')}>单页</button>
    <button type="button" role="radio" aria-checked={props.mode === 'multi'} data-testid="capture-mode-multi" onClick={() => captureSession.setMode('multi')}>多页</button>
  </div>;
}

function CaptureChoiceSheet(props: { kind: CaptureChoiceKind }): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null);
  const leaseEnd = useRef<(() => void) | null>(null);
  const arm = (): void => { if (!leaseEnd.current) leaseEnd.current = pickerLease.begin(); };
  const disarm = (): void => { leaseEnd.current?.(); leaseEnd.current = null; };
  const closeSheet = (): void => { disarm(); captureChoice.close(); };
  useEffect(() => () => { disarm(); }, []);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); closeSheet(); return; }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button, input')].filter(element => !element.hasAttribute('disabled'));
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);
  const camera = props.kind === 'camera';
  const option = (mode: CaptureMode, title: string, detail: string, testId: string): ReactNode => <PickLabel
    kind={props.kind}
    className="capture-choice-option"
    testId={testId}
    route="materials"
    mode={mode}
    inputLabel={camera ? `${title}拍照` : `${title}从相册选择`}
    onArm={arm}
    onPicked={() => { disarm(); captureChoice.close(); }}
    onCancel={disarm}
  >
    <span><b>{title}</b><small>{detail}</small></span>
  </PickLabel>;
  return createPortal(<div className="capture-choice-backdrop" data-testid="capture-mode-sheet" onClick={closeSheet}>
    <div
      className="capture-choice-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="capture-choice-title"
      tabIndex={-1}
      ref={dialogRef}
      onClick={event => event.stopPropagation()}
    >
      <h2 id="capture-choice-title">{camera ? '怎么拍照' : '怎么从相册选'}</h2>
      <p>选好这一次是单页还是多页。点下去会直接打开{camera ? '相机' : '相册'}。</p>
      <div role="group" aria-label="拍摄模式">
        {option('single', '单页', '选好就上传', 'capture-mode-single')}
        {option('multi', '多页', '先留在本页，拍完再一起上传', 'capture-mode-multi')}
      </div>
      <button type="button" className="capture-choice-cancel" data-testid="capture-mode-cancel" onClick={closeSheet}>取消</button>
    </div>
  </div>, document.body);
}

/**
 * Camera and album entry. Idle materials asks for 单页 / 多页 in a sheet whose options are real file labels.
 * The picker opens from that tap. Do not script a click on a hidden file input.
 */
export function CaptureEntry(props: {
  kind: CaptureChoiceKind;
  className?: string;
  testId?: string;
  inputId?: string;
  /** Icon-only controls pass a name. Buttons that already show text leave this unset. */
  label?: string;
  children: ReactNode;
}): ReactNode {
  const route = useCaptureRoute();
  const choice = useChoiceKind();
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
  if (action === 'choice' && !leased.current) {
    const open = choice === props.kind;
    return <button
      type="button"
      className={props.className}
      data-testid={props.testId}
      aria-label={props.label}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => captureChoice.open(props.kind)}
    >{props.children}</button>;
  }
  return <PickLabel
    kind={props.kind}
    className={props.className}
    testId={props.testId}
    inputId={props.inputId}
    inputLabel={props.label}
    route={route}
    mode={pinSingle.current || route !== 'materials' ? 'single' : undefined}
    onArm={arm}
    onPicked={disarm}
    onCancel={disarm}
  >{props.children}</PickLabel>;
}

/**
 * Bottom capture controls. The phone camera has no room for our buttons, so a populated
 * multi-page tray keeps 单页 / 多页 here. Idle home and intake only show camera and album;
 * the mode choice is the next tap, on a real file label.
 */
export function CaptureDock(props: {
  placement: 'corner' | 'inline';
  cameraInputId?: string;
  albumInputId?: string;
  albumTestId?: string;
  cameraTestId?: string;
}): ReactNode {
  const navigate = useNavigate();
  const { mode, pages, overflow } = useCaptureSession();
  // Ionic keeps the previous page mounted. A second dock would cover this one and duplicate #camera-input.
  const [active, setActive] = useState(true);
  const route = useCaptureRoute();
  const choice = useChoiceKind();
  const pickerOpen = usePickerOpen();
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
  useEffect(() => { if (!active) captureChoice.close(); }, [active]);
  const action = captureEntryAction(route, pages.length, mode);
  // Only the visible dock may dismiss the sheet. Leave it up while its file picker can still deliver a change.
  useEffect(() => { if (active && choice && action !== 'choice' && !pickerOpen) captureChoice.close(); }, [active, choice, action, pickerOpen]);
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
        <CaptureEntry kind="camera" className="pick-button pick-text" testId="intake-camera"><IonIcon icon={cameraOutline} aria-hidden="true" />拍照</CaptureEntry>
        <CaptureEntry kind="album" className="pick-button pick-text" testId="intake-album"><IonIcon icon={albumsOutline} aria-hidden="true" />从相册选择</CaptureEntry>
      </div>
    : <div className="capture-dock-picks">
        <CaptureEntry kind="camera" className="fab-circle fab-camera" inputId={props.cameraInputId} testId={props.cameraTestId} label="拍照"><IonIcon icon={cameraOutline} aria-hidden="true" /></CaptureEntry>
        <CaptureEntry kind="album" className="fab-circle fab-album" inputId={props.albumInputId} testId={props.albumTestId} label="从相册选择"><IonIcon icon={albumsOutline} aria-hidden="true" /></CaptureEntry>
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
    {picks}
    {showCaptureModeBar(route, pages.length) ? <ModeBar mode={mode} /> : null}
    {choice && action === 'choice' ? <CaptureChoiceSheet kind={choice} /> : null}
  </>;
  if (props.placement === 'inline') {
    return <div className="capture-inline" data-testid="capture-dock" data-capture-route={route ?? 'pending'} data-capture-choice={action}>{body}</div>;
  }
  return <div className={`capture-dock${tray ? ' has-tray' : ''}`} slot="fixed" data-testid="capture-dock" data-capture-route={route ?? 'pending'} data-capture-choice={action}>{body}</div>;
}
