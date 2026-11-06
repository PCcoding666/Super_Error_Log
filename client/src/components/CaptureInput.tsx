import { useNavigate } from 'react-router-dom';
import { useEffect, useRef, type ChangeEvent, type ReactNode } from 'react';
import { pickedFileDestination, type CaptureRouteKind } from '../lib/captureEntry';
import { captureSession, type CaptureMode } from '../lib/captureSession';
import { bindPickerSession, watchChooser } from '../lib/chooserWatch';
import { uploader } from '../lib/uploader';

/**
 * 拍照和相册是两个文件框，手指点在框自己身上。
 *
 * 以前只有一个不带 capture、被裁成 1×1 的输入框，按钮再用脚本 click() 去点它。
 * iOS Safari 会因此弹出「拍照 / 照片图库 / 选取文件」。安卓没有这张菜单；
 * 小米 / 红米的 Chrome 和系统 WebView 还会直接丢掉这次 click：输入框被 clip 出点击区域，
 * 或者 accept 里带了 .heic 这种扩展名（不是 MIME），选择器 Activity 解析失败后马上返回，
 * 页面上看不到任何相册。脚本 click 一个被裁掉的框在这里不可靠。
 *
 * 相册框不带 capture，accept 只用 image/*（系统相册里的 HEIC 仍然算 image/*），可多选。
 * 拍照框单独带 capture="environment"，这样相册不会被相机权限挡住。
 */
const ACCEPT = 'image/*';

function usePickFiles(route: CaptureRouteKind | null, explicit: CaptureMode | undefined): (event: ChangeEvent<HTMLInputElement>) => void {
  const navigate = useNavigate();
  return event => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length) return;
    // 多页先留在本页。还没确认是材料流程时，不按 localStorage 里的多页进托盘。
    // 材料流程里已经有一组时，新照片并进这一组，不另开一次上传。
    if (pickedFileDestination(route, explicit, captureSession.pages.length) === 'tray') {
      if (captureSession.mode !== 'multi') captureSession.setMode('multi');
      captureSession.add(files);
      return;
    }
    if (captureSession.mode !== 'single') captureSession.setMode('single');
    uploader.add(files);
    navigate('/new');
  };
}

export function PickLabel(props: {
  kind: 'album' | 'camera';
  className?: string;
  testId?: string;
  /** 整页只放一个，给还在用 #library-input / #camera-input 的测试。 */
  inputId?: string;
  /** Spoken name for this file control. Defaults to 拍照 / 从相册选择. */
  inputLabel?: string;
  /** Route known when this label was rendered. Unknown and legacy commits are 单页. */
  route?: CaptureRouteKind | null;
  /**
   * Set only when this label itself is the mode choice (the sheet). Omitted labels follow the open tray.
   * Written when a file arrives, not when the picker merely opens, so cancelling does not persist 多页.
   */
  mode?: CaptureMode;
  /** The student tapped this input. Keep it mounted until the picker finishes. */
  onArm?: () => void;
  onPicked?: () => void;
  onCancel?: () => void;
  children: ReactNode;
}): ReactNode {
  const onChange = usePickFiles(props.route ?? null, props.mode);
  const stopSession = useRef<(() => void) | null>(null);
  useEffect(() => () => { stopSession.current?.(); stopSession.current = null; }, []);
  const album = props.kind === 'album';
  return <label className={props.className} data-testid={props.testId}>
    {props.children}
    <input
      id={props.inputId}
      data-testid={props.inputId}
      data-kind={props.kind}
      className="file-hit"
      type="file"
      accept={ACCEPT}
      multiple={album}
      capture={album ? undefined : 'environment'}
      aria-label={props.inputLabel ?? (album ? '从相册选择' : '拍照')}
      onClick={event => {
        props.onArm?.();
        watchChooser(event.currentTarget);
        stopSession.current?.();
        stopSession.current = bindPickerSession(event.currentTarget, { onCancel: () => props.onCancel?.() });
      }}
      onChange={event => {
        const picked = (event.target.files?.length ?? 0) > 0;
        onChange(event);
        if (picked) props.onPicked?.();
        else props.onCancel?.();
      }}
    />
  </label>;
}
