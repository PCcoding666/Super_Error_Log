import { IonButton } from '@ionic/react';
import type { ReactNode } from 'react';

export function Problem(props: { message: string; onRetry?: () => void }): ReactNode {
  return <div className="problem" role="alert">
    <p>{props.message}</p>
    {props.onRetry ? <IonButton fill="clear" size="small" onClick={props.onRetry}>再试一次</IonButton> : null}
  </div>;
}
