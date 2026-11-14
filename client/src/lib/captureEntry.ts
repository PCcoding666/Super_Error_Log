import type { CaptureMode } from './captureSession.js';

export type CaptureRouteKind = 'legacy' | 'materials';

/**
 * direct: the control is a real file label. The 单页 / 多页 pill is already on screen, so the tap opens the system picker.
 * held: a tray is open and the student switched it back to 单页. Camera and album stay closed until 完成 or 放弃.
 *
 * A null route stays direct so a picker opened while /s/api/upload is in flight keeps its input.
 * That file is still committed as a single upload; stored 多页 does not apply until the route is materials.
 */
export type CaptureEntryAction = 'direct' | 'held';

export function captureEntryAction(route: CaptureRouteKind | null, pageCount: number, mode: CaptureMode): CaptureEntryAction {
  if (route !== 'materials') return 'direct';
  if (pageCount > 0 && mode === 'single') return 'held';
  return 'direct';
}

/**
 * iPhone and iPad Safari show 照片图库 / 拍照 / 选取文件 for one image input, and ignore capture.
 * Android, including Xiaomi and Redmi, opens the camera or the gallery from different inputs.
 * A desktop file dialog is not that iOS sheet, so it keeps the two inputs.
 */
export function iosOffersCameraAndLibrary(ua: string, platform = '', maxTouchPoints = 0): boolean {
  if (/Android/i.test(ua)) return false;
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return platform === 'MacIntel' && maxTouchPoints > 1;
}

export function deviceOffersCombinedCapture(): boolean {
  if (typeof navigator === 'undefined') return false;
  return iosOffersCameraAndLibrary(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
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

/** The 单页 / 多页 pill is on screen before the picker, including an empty materials page. */
export function showCaptureModeBar(route: CaptureRouteKind | null, _pageCount: number): boolean {
  return route === 'materials';
}

export type CaptureChoiceKind = 'camera' | 'album';

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
