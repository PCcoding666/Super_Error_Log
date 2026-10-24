import { useNavigate } from 'react-router-dom';
import type { ChangeEvent, ReactNode } from 'react';
import { watchChooser } from '../lib/chooserWatch';
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

function usePickFiles(): (event: ChangeEvent<HTMLInputElement>) => void {
  const navigate = useNavigate();
  return event => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length) return;
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
  children: ReactNode;
}): ReactNode {
  const onChange = usePickFiles();
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
      aria-label={album ? '从相册选择' : '拍照'}
      onClick={event => watchChooser(event.currentTarget)}
      onChange={onChange}
    />
  </label>;
}
