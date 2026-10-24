import { IonToast } from '@ionic/react';
import { useEffect, useState, type ReactNode } from 'react';
import { chooserHint } from '../lib/chooserWatch';

/** 安卓桌面图标壳吞掉文件选择器时的提示；整个应用只放一个，挂在 App 里。 */
export function ChooserBlockedToast(): ReactNode {
  const [open, setOpen] = useState(chooserHint.blocked);
  useEffect(() => chooserHint.subscribe(() => setOpen(chooserHint.blocked)), []);
  const url = `${location.host}/s/`;
  return <IonToast isOpen={open} className="chooser-blocked" position="bottom" layout="stacked"
    message={`这个窗口打不开相册和相机。请在手机浏览器里打开 ${url}，桌面上的这个图标可以删掉。`}
    buttons={[
      { text: '复制网址', handler: () => { void navigator.clipboard?.writeText(`${location.origin}/s/`).catch(() => undefined); } },
      { text: '知道了', role: 'cancel' },
    ]}
    onDidDismiss={() => chooserHint.dismiss()} />;
}
