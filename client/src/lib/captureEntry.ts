import type { CaptureMode } from './captureSession.js';

export type CaptureRouteKind = 'legacy' | 'materials';

/**
 * direct: the control is a real file label (legacy, route still loading, or a multi-page tray).
 * choice: materials home/intake is idle, so the tap opens the single/multi sheet first.
 * held: a tray is open and the student switched it back to 单页. Do not start a separate upload.
 */
export type CaptureEntryAction = 'direct' | 'choice' | 'held';

export function captureEntryAction(route: CaptureRouteKind | null, pageCount: number, mode: CaptureMode): CaptureEntryAction {
  if (route !== 'materials') return 'direct';
  if (pageCount <= 0) return 'choice';
  if (mode === 'single') return 'held';
  return 'direct';
}

/** The 单页 / 多页 bar stays with a populated tray only. Idle home and intake do not show it. */
export function showCaptureModeBar(route: CaptureRouteKind | null, pageCount: number): boolean {
  return route === 'materials' && pageCount > 0;
}

/** A populated tray, and the first shots of 多页, stay in the tray. 单页 uploads only when nothing is staged. */
export function keepsPickedFilesInTray(pageCount: number, mode: CaptureMode): boolean {
  return pageCount > 0 || mode === 'multi';
}

export type CaptureChoiceKind = 'camera' | 'album';

type Listener = () => void;

/** Which entry opened the mode sheet. Shared by the corner dock, the inline dock, and the empty-notebook buttons. */
class CaptureChoice {
  kind: CaptureChoiceKind | null = null;
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  open(kind: CaptureChoiceKind): void {
    this.kind = kind;
    this.emit();
  }
  close(): void {
    if (this.kind === null) return;
    this.kind = null;
    this.emit();
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
}

export const captureChoice = new CaptureChoice();
