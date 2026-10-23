import { IonBackButton, IonButtons, IonContent, IonHeader, IonItem, IonLabel, IonList, IonListHeader, IonNote, IonPage, IonSelect, IonSelectOption, IonToast, IonToolbar } from '@ionic/react';
import { useState, type ReactNode } from 'react';
import { Problem } from '../components/Problem';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';

function logout(): void {
  // 和旧页面一样走表单提交：网关要看同源 Origin，并在 303 后带着清掉的 cookie 回登录页。
  const form = document.createElement('form');
  form.method = 'post'; form.action = '/s/logout';
  document.body.appendChild(form);
  form.submit();
}

export function SettingsPage(): ReactNode {
  const { data, error, reload } = useLoad(() => api.settings(), []);
  const [toast, setToast] = useState<string | null>(null);
  const expires = data?.inviteExpires && data.inviteExpires !== 'none' ? new Date(data.inviteExpires) : null;
  const expiresSoon = expires && Number.isFinite(expires.getTime()) && expires.getTime() - Date.now() < 7 * 86400000;
  return <IonPage>
    <IonHeader className="plain-header ion-no-border"><IonToolbar><IonButtons slot="start"><IonBackButton defaultHref="/" text="" data-testid="back-link" /></IonButtons></IonToolbar></IonHeader>
    <IonContent fullscreen className="settings">
      <h1 className="page-title">设置</h1>
      {error ? <Problem message={error.message} onRetry={() => void reload()} /> : null}
      {data ? <>
        <IonListHeader className="group-label">学习</IonListHeader>
        <IonList inset lines="full">
          <IonItem><IonSelect label="学段" value={data.grade} interface="action-sheet" cancelText="取消" data-testid="student-grade"
            onIonChange={event => { void api.grade(String(event.detail.value)).then(() => setToast('学段已更新')).then(reload).catch(caught => setToast(caught instanceof Error ? caught.message : '没保存成功')); }}>
            {data.stages.map(stage => <IonSelectOption key={stage} value={stage}>{stage}</IonSelectOption>)}
          </IonSelect></IonItem>
          <IonItem><IonLabel>练习</IonLabel><IonNote slot="end">即将推出</IonNote></IonItem>
        </IonList>
        <IonListHeader className="group-label">应用</IonListHeader>
        <IonList inset lines="full">
          <IonItem href="/s/install" detail data-testid="settings-install"><IonLabel>添加到主屏幕</IonLabel></IonItem>
          <IonItem><IonLabel>服务</IonLabel><IonNote slot="end" color="success" data-testid="connection-ok">已连接</IonNote></IonItem>
        </IonList>
        {data.invitation ? <>
          <IonListHeader className="group-label">账号</IonListHeader>
          <IonList inset lines="full">
            {data.accountRoleLabel ? <IonItem><IonLabel>身份</IonLabel><IonNote slot="end" data-testid="account-role">{data.accountRoleLabel}</IonNote></IonItem> : null}
            <IonItem href="/s/account" detail data-testid="settings-my-invite"><IonLabel>我的邀请码</IonLabel>{expiresSoon ? <IonNote slot="end" color="warning">快到期</IonNote> : null}</IonItem>
            <IonItem button detail={false} onClick={logout} data-testid="logout"><IonLabel color="danger">退出登录</IonLabel></IonItem>
          </IonList>
        </> : null}
        <p className="version">超级错题本 {data.version}</p>
      </> : null}
      <IonToast isOpen={!!toast} message={toast ?? ''} duration={2500} onDidDismiss={() => setToast(null)} />
    </IonContent>
  </IonPage>;
}
