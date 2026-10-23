import { useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { uploader } from '../lib/uploader';

/**
 * 拍照 / 相册入口：一个不带 capture 属性的文件输入框，iOS 会弹系统菜单「拍照 / 照片图库 / 选取文件」。
 * 选好就排进上传队列并进入录入态；页面上任何按钮都可以用 htmlFor 指向它。
 */
export const CAPTURE_INPUT_ID = 'library-input';

export function CaptureInput(props: { onPicked?: () => void }): ReactNode {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  return <input ref={input} id={CAPTURE_INPUT_ID} type="file" accept="image/*,.heic,.heif" multiple className="visually-hidden" data-testid="library-input"
    onChange={event => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = '';
      if (!files.length) return;
      uploader.add(files);
      props.onPicked?.();
      navigate('/new');
    }} />;
}
