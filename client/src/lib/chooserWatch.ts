/**
 * 安卓上「添加到桌面」出来的壳（小米浏览器等，2026-10-25 红米实录）没有实现文件选择器：
 * 文件框能拿到焦点（按钮外圈亮起），相册和相机却都不弹，页面上什么也不发生。
 *
 * 这里不猜壳的名字，只看结果：点了文件框以后两秒内，选择器真打开了页面会被盖住
 * （visibilitychange / blur / pagehide），或者直接来 change；两样都没有，就是壳把它吞了，
 * 提示换浏览器打开。iOS 的选择菜单盖在页面上不触发这些事件，所以只在安卓上看。
 * 服务端同时对安卓的 manifest 发 display: browser，以后「添加到桌面」会在浏览器标签里打开。
 */
export const CHOOSER_GRACE_MS = 2000;

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
    if (!opened && document.visibilityState === 'visible') chooserHint.show();
  }, CHOOSER_GRACE_MS);
}
