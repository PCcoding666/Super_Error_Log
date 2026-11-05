import { IonButton } from '@ionic/react';
import type { ReactNode } from 'react';

/** requestId：服务器给这次失败请求的编号；显示出来，学生反馈时报这个，服务器日志按它查。 */
export function Problem(props: { message: string; requestId?: string | null; onRetry?: () => void }): ReactNode {
  return <div className="problem" role="alert">
    <p>{props.message}</p>
    {props.requestId ? <p className="muted small">错误编号 {props.requestId}</p> : null}
    {props.onRetry ? <IonButton fill="clear" size="small" onClick={props.onRetry}>再试一次</IonButton> : null}
  </div>;
}
