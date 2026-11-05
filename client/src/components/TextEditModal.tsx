import { IonButton, IonButtons, IonContent, IonHeader, IonModal, IonTextarea, IonTitle, IonToolbar } from '@ionic/react';
import { useEffect, useState, type ReactNode } from 'react';

export interface TextEdit {
  title: string;
  value: string;
  /** 改之前的提醒（例如学生原作只能改回纸上写的）。 */
  hint?: string;
  maxLength: number;
  /** 保存；返回错误文字就留在弹层里给学生看，返回 null 表示成功。 */
  save: (text: string) => Promise<string | null>;
}

/** 改一段识别出的文字（题干、你写的、批改痕迹、参考答案、拍的答案）。 */
export function TextEditModal(props: { edit: TextEdit | null; onClose: () => void }): ReactNode {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (props.edit) { setDraft(props.edit.value); setError(null); } }, [props.edit]);
  const save = async (): Promise<void> => {
    if (!props.edit || saving) return;
    setSaving(true);
    try {
      const problem = await props.edit.save(draft);
      if (problem) setError(problem); else props.onClose();
    } finally { setSaving(false); }
  };
  return <IonModal isOpen={props.edit !== null} onDidDismiss={props.onClose} data-testid="text-edit">
    <IonHeader><IonToolbar>
      <IonButtons slot="start"><IonButton onClick={props.onClose}>取消</IonButton></IonButtons>
      <IonTitle>{props.edit?.title}</IonTitle>
      <IonButtons slot="end"><IonButton strong disabled={saving || !draft.trim()} onClick={() => void save()} data-testid="text-edit-save">保存</IonButton></IonButtons>
    </IonToolbar></IonHeader>
    <IonContent>
      <div className="text-edit">
        {props.edit?.hint ? <p className="muted">{props.edit.hint}</p> : null}
        <IonTextarea value={draft} autoGrow rows={4} maxlength={props.edit?.maxLength} onIonInput={event => setDraft(String(event.detail.value ?? ''))} aria-label={props.edit?.title} data-testid="text-edit-input" />
        {error ? <p className="tone-red" role="alert" data-testid="text-edit-error">{error}</p> : null}
      </div>
    </IonContent>
  </IonModal>;
}
