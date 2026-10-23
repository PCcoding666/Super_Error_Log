import { IonButton, IonContent, IonPage } from '@ionic/react';
import { useState, type ReactNode } from 'react';
import { api } from '../lib/api';

/** 新账号第一次用：先选初中或高中（服务器在选好之前对所有接口回 409 stage_required）。 */
export function StageGate(props: { onChosen: () => void }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = async (grade: string): Promise<void> => {
    setBusy(true); setError(null);
    try { await api.grade(grade); props.onChosen(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '没保存成功'); }
    finally { setBusy(false); }
  };
  return <IonPage><IonContent fullscreen className="stage-gate">
    <div className="stage-gate-body" data-testid="stage-gate">
      <h1>你在读哪个学段？</h1>
      <p className="muted">新收录的题默认用这个学段，以后可以在设置里改。</p>
      <div className="stage-gate-buttons">
        {['初中', '高中'].map(grade => <IonButton key={grade} expand="block" size="large" fill={grade === '初中' ? 'solid' : 'outline'} disabled={busy} onClick={() => void choose(grade)}>{grade}</IonButton>)}
      </div>
      {error ? <p className="tone-red">{error}</p> : null}
    </div>
  </IonContent></IonPage>;
}
