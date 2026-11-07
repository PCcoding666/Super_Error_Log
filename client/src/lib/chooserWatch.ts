/**
 * 安卓上「添加到桌面」出来的壳（小米浏览器等，2026-10-25 红米实录）没有实现文件选择器：
 * 文件框能拿到焦点（按钮外圈亮起），相册和相机却都不弹，页面上什么也不发生。
 *
 * 这里不猜壳的名字，只看结果：点了文件框以后两秒内，选择器真打开了页面会被盖住
 * （visibilitychange / blur / pagehide），或者直接来 change；两样都没有，就是壳把它吞了，
 * 提示换浏览器打开。iOS 的选择菜单盖在页面上不触发这些事件，所以只在安卓上看。
 * 服务端同时对安卓的 manifest 发 display: browser，以后「添加到桌面」会在浏览器标签里打开。
 */
import { report } from './report';

export const CHOOSER_GRACE_MS = 2000;
/**
 * After the camera activity returns, the change event can land after focus and
 * visibility. Wait this long before treating an empty input as a cancel.
 * A cancel event still ends the picker immediately.
 */
export const PICKER_RETURN_GRACE_MS = 1000;

const isAndroid = (): boolean => /Android/i.test(navigator.userAgent);

type Listener = () => void;

class ChooserHint {
  blocked = false;
  private listeners = new Set<Listener>();
  subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  show(): void { if (this.blocked) return; this.blocked = true; this.emit(); }
  dismiss(): void { if (!this.blocked) return; this.blocked = false; this.emit(); }
  private emit(): void { for (const listener of this.listeners) listener(); }
}

export const chooserHint = new ChooserHint();

/**
 * Keep a tapped file input alive until the picker really finishes.
 * - `cancel` ends it immediately (the browser says the student dismissed the dialog).
 * - If the page was covered and then comes back, wait PICKER_RETURN_GRACE_MS so a late
 *   change still wins over focus/visibility.
 * - On Android, if the page was never covered and no file arrived within CHOOSER_GRACE_MS,
 *   the shell swallowed the picker (小米「添加到桌面」). End the lease. iOS can keep a
 *   picker open without hiding the page, so this fallback is Android-only.
 * Returns a stop function that drops listeners without treating that as a cancel.
 */
export function bindPickerSession(input: HTMLInputElement, hooks: { onCancel: () => void }): () => void {
  let settled = false;
  let covered = false;
  let returnTimer: number | null = null;
  let noCoverTimer: number | null = null;
  const cleanup = (): void => {
    if (returnTimer !== null) window.clearTimeout(returnTimer);
    if (noCoverTimer !== null) window.clearTimeout(noCoverTimer);
    returnTimer = null;
    noCoverTimer = null;
    input.removeEventListener('change', onChange);
    input.removeEventListener('cancel', onDialogCancel);
    window.removeEventListener('blur', markCovered);
    window.removeEventListener('pagehide', markCovered);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisible);
  };
  const finishCancel = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
    hooks.onCancel();
  };
  const onChange = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
  };
  const onDialogCancel = (): void => finishCancel();
  const markCovered = (): void => {
    covered = true;
    if (noCoverTimer !== null) { window.clearTimeout(noCoverTimer); noCoverTimer = null; }
  };
  const armReturnGrace = (): void => {
    if (settled || !covered) return;
    if (returnTimer !== null) window.clearTimeout(returnTimer);
    returnTimer = window.setTimeout(() => {
      returnTimer = null;
      if (settled || (input.files?.length ?? 0) > 0) return;
      finishCancel();
    }, PICKER_RETURN_GRACE_MS);
  };
  const onFocus = (): void => { if (covered) armReturnGrace(); };
  const onVisible = (): void => {
    if (document.visibilityState === 'hidden') markCovered();
    else armReturnGrace();
  };
  input.addEventListener('change', onChange);
  input.addEventListener('cancel', onDialogCancel);
  window.addEventListener('blur', markCovered);
  window.addEventListener('pagehide', markCovered);
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisible);
  if (isAndroid()) {
    noCoverTimer = window.setTimeout(() => {
      noCoverTimer = null;
      if (settled || covered || document.visibilityState !== 'visible') return;
      if ((input.files?.length ?? 0) > 0) return;
      finishCancel();
    }, CHOOSER_GRACE_MS);
  }
  return () => { if (settled) return; settled = true; cleanup(); };
}

/** 在文件框自己的 click 上调用：两秒内既没盖住页面也没选到文件，就提示。 */
export function watchChooser(input: HTMLInputElement): void {
  if (!isAndroid()) return;
  let opened = false;
  const mark = (): void => { opened = true; };
  const onVisibility = (): void => { if (document.visibilityState === 'hidden') opened = true; };
  window.addEventListener('blur', mark);
  window.addEventListener('pagehide', mark);
  document.addEventListener('visibilitychange', onVisibility);
  input.addEventListener('change', mark);
  window.setTimeout(() => {
    window.removeEventListener('blur', mark);
    window.removeEventListener('pagehide', mark);
    document.removeEventListener('visibilitychange', onVisibility);
    input.removeEventListener('change', mark);
    if (!opened && document.visibilityState === 'visible') {
      chooserHint.show();
      // 报一条：哪些安卓壳吞了选择器、发生了多少次，服务器日志里能数出来（只有类别，没有机型以外的任何信息）。
      report('chooser_blocked', { code: 'android_shell' });
    }
  }, CHOOSER_GRACE_MS);
}
