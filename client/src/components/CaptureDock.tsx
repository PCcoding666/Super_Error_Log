import { useIonViewWillEnter, useIonViewWillLeave } from '@ionic/react';
import { useNavigate } from 'react-router-dom';
import { flushSync } from 'react-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { captureEntryAction, captureSheet, pickerLease, showCaptureModeBar, type CaptureRouteKind } from '../lib/captureEntry';
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

/** Pill on an open multi-page tray. The first choice is the sheet, not this bar. */
export function CaptureModeSwitch(): ReactNode {
  const route = useCaptureRoute();
  const { mode } = useCaptureSession();
  if (route !== 'materials') return null;
  return <div className="capture-mode-bar" role="radiogroup" aria-label="拍摄模式" data-testid="capture-mode-bar">
    <button type="button" role="radio" aria-checked={mode === 'single'} data-testid="capture-mode-single" onClick={() => captureSession.setMode('single')}>单页</button>
    <button type="button" role="radio" aria-checked={mode === 'multi'} data-testid="capture-mode-multi" onClick={() => captureSession.setMode('multi')}>多页</button>
  </div>;
}

/**
 * 新增. Idle materials opens the mode sheet. Legacy, and an open multi-page tray, are a real file label.
 * A tray switched back to 单页 stays closed until 完成 or 放弃.
 * Do not script a click on a hidden file input.
 */
export function CaptureEntry(props: {
  className?: string;
  testId?: string;
  inputId?: string;
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
  if (!leased.current && action === 'held') {
    return <button
      type="button"
      className={`${props.className ?? ''} is-held`}
      data-testid={props.testId}
      aria-label="新增"
      aria-disabled="true"
      aria-describedby="capture-mode-hold"
    >{props.children}</button>;
  }
  if (!leased.current && action === 'sheet') {
    return <button type="button" className={props.className} data-testid={props.testId} onClick={() => captureSheet.show()}>{props.children}</button>;
  }
  return <PickLabel
    kind="album"
    combined
    className={props.className}
    testId={props.testId}
    inputId={props.inputId ?? 'camera-input'}
    inputLabel="新增"
    route={route}
    mode={pinSingle.current || route !== 'materials' ? 'single' : mode}
    onArm={arm}
    onPicked={disarm}
    onCancel={disarm}
  >{props.children}</PickLabel>;
}

/** Mode sheet. 单页 / 多页 does not open the picker. 开始 is the file label, and the sheet hides on that tap. */
export function CaptureModeSheet(): ReactNode {
  const route = useCaptureRoute();
  const [open, setOpen] = useState(captureSheet.open);
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<CaptureMode>('single');
  useEffect(() => captureSheet.subscribe(() => {
    setOpen(captureSheet.open);
    if (captureSheet.open) {
      setDraft(captureSession.mode);
      setPicking(false);
    }
  }), []);
  if (route !== 'materials' || (!open && !picking)) return null;
  const finish = (): void => {
    setPicking(false);
    captureSheet.hide();
  };
  return createPortal(<div
    className={picking ? 'capture-sheet-parked' : 'capture-choice-backdrop'}
    data-testid={picking ? undefined : 'capture-mode-sheet'}
    role={picking ? undefined : 'dialog'}
    aria-modal={picking ? undefined : true}
    aria-label={picking ? undefined : '新增'}
    onClick={() => { if (!picking) captureSheet.hide(); }}
  >
    <div className="capture-choice-sheet" onClick={event => event.stopPropagation()}>
      {picking ? null : <div className="capture-sheet-copy">
        <div className="capture-mode-bar" role="radiogroup" aria-label="拍摄模式" data-testid="capture-mode-bar">
          <button type="button" role="radio" aria-checked={draft === 'single'} data-testid="capture-mode-single" onClick={() => setDraft('single')}>单页</button>
          <button type="button" role="radio" aria-checked={draft === 'multi'} data-testid="capture-mode-multi" onClick={() => setDraft('multi')}>多页</button>
        </div>
        <p className="capture-mode-note">试卷和答题卡不在同一张纸上，或一道题的材料有好几页时，用「多页」。</p>
      </div>}
      <PickLabel
        kind="album"
        combined
        className="pick-button pick-solid capture-sheet-go"
        testId="capture-start"
        inputId="camera-input"
        inputLabel="开始"
        route={route}
        mode={draft}
        onArm={() => {
          captureSession.setMode(draft);
          flushSync(() => setPicking(true));
          captureSheet.hide();
        }}
        onPicked={finish}
        onCancel={finish}
      >开始</PickLabel>
      {picking ? null : <button type="button" className="capture-choice-cancel" data-testid="capture-mode-cancel" onClick={() => captureSheet.hide()}>取消</button>}
    </div>
  </div>, document.body);
}

/**
 * Bottom capture control. One 新增 on every phone.
 * The mode pill on this dock is only the open tray; the first choice is the sheet.
 */
export function CaptureDock(props: {
  placement: 'corner' | 'inline';
  /** Empty notebook already shows 新增 in the page body. */
  showAdd?: boolean;
  showMode?: boolean;
}): ReactNode {
  const navigate = useNavigate();
  const { mode, pages, overflow } = useCaptureSession();
  // Ionic keeps the previous page mounted. A second dock would cover this one and duplicate the file input.
  const [active, setActive] = useState(true);
  const route = useCaptureRoute();
  useIonViewWillEnter(() => setActive(true));
  useIonViewWillLeave(() => { setActive(false); captureSheet.hide(); });
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
  const add = props.showAdd === false && !tray ? null : <CaptureEntry
    className={props.placement === 'inline' ? 'pick-button pick-text' : 'pick-button pick-solid capture-add-fab'}
    testId="capture-add"
  >新增</CaptureEntry>;
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
    {add}
  </>;
  const dock = props.placement === 'inline'
    ? <div className="capture-inline" data-testid="capture-dock" data-capture-route={route ?? 'pending'} data-capture-choice={action}>{body}</div>
    : <div className={`capture-dock${tray ? ' has-tray' : ''}`} slot="fixed" data-testid="capture-dock" data-capture-route={route ?? 'pending'} data-capture-choice={action}>{body}</div>;
  return <>
    <CaptureModeSheet />
    {dock}
  </>;
}
