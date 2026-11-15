import type { CaptureMode } from './captureSession.js';

export type CaptureRouteKind = 'legacy' | 'materials';

/**
 * sheet: idle materials. 新增 opens the mode sheet. It is not a file input.
 * direct: a real file label. Legacy has no multi-page tray, and an open multi-page tray adds another page.
 * held: a tray is open and the student switched it back to 单页. 新增 stays closed until 完成 or 放弃.
 *
 * A null route stays direct so a picker opened while /s/api/upload is in flight keeps its input.
 * That file is still committed as a single upload; stored 多页 does not apply until the route is materials.
 */
export type CaptureEntryAction = 'sheet' | 'direct' | 'held';

export function captureEntryAction(route: CaptureRouteKind | null, pageCount: number, mode: CaptureMode): CaptureEntryAction {
  if (route !== 'materials') return 'direct';
  if (pageCount > 0 && mode === 'single') return 'held';
  if (pageCount > 0) return 'direct';
  return 'sheet';
}

/**
 * Where a file that just arrived should go.
 * Unknown and legacy routes upload as 单页 even if localStorage still says 多页.
 * An open materials tray stays one set. 多页 starts only from an explicit sheet choice.
 */
export function pickedFileDestination(route: CaptureRouteKind | null, explicit: CaptureMode | undefined, pageCount: number): 'tray' | 'upload' {
  if (route !== 'materials') return 'upload';
  if (pageCount > 0) return 'tray';
  if (explicit === 'multi') return 'tray';
  return 'upload';
}

/** The 单页 / 多页 pill stays on an open materials tray. The first choice lives in the sheet. */
export function showCaptureModeBar(route: CaptureRouteKind | null, pageCount: number): boolean {
  return route === 'materials' && pageCount > 0;
}

type Listener = () => void;

/** True while a file input the student already tapped may still receive a change event. */
class PickerLease {
  private count = 0;
  private listeners = new Set<Listener>();
  get open(): boolean { return this.count > 0; }
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  begin(): () => void {
    this.count += 1;
    this.emit();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.count -= 1;
      this.emit();
    };
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
}

export const pickerLease = new PickerLease();

/** The mode sheet. One instance, shared by the empty notebook, the corner button, and the intake page. */
class CaptureSheet {
  open = false;
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  show(): void {
    if (this.open) return;
    this.open = true;
    this.emit();
  }
  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.emit();
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
}

export const captureSheet = new CaptureSheet();
