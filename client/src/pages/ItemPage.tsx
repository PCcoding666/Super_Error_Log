import {
  IonActionSheet, IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonList, IonModal, IonPage, IonPopover, IonSelect, IonSelectOption,
  IonTitle, IonToast, IonToolbar,
} from '@ionic/react';
import { ellipsisHorizontal } from 'ionicons/icons';
import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Problem } from '../components/Problem';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';

/** 题目详情：照片、题干、你写的、章节；右上角「…」里是修改分类、材料来源、移除。 */
export function ItemPage(): ReactNode {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, error, reload } = useLoad(() => api.item(id), [id]);
  const [sheet, setSheet] = useState<'confirm' | null>(null);
  const [editing, setEditing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [values, setValues] = useState<{ grade: string; subject: string; chapter: string } | null>(null);
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [menuEvent, setMenuEvent] = useState<Event | null>(null);

  const remove = async (): Promise<void> => {
    try { await api.discard([id]); navigate(-1); }
    catch (caught) { setToast(caught instanceof Error ? caught.message : '没有移除'); }
  };
  const save = async (): Promise<void> => {
    if (!values) return;
    try { await api.category(id, values); setEditing(false); setToast('分类已更新'); await reload(); }
    catch (caught) { setToast(caught instanceof Error ? caught.message : '没保存成功'); }
  };
  const item = data?.item;
  return <IonPage>
    <IonHeader className="plain-header ion-no-border">
      <IonToolbar>
        <IonButtons slot="start"><IonBackButton defaultHref="/" text="" data-testid="back-link" /></IonButtons>
        <IonButtons slot="end"><IonButton aria-label="更多" data-testid="item-more" onClick={event => setMenuEvent(event.nativeEvent)}><IonIcon icon={ellipsisHorizontal} slot="icon-only" /></IonButton></IonButtons>
      </IonToolbar>
    </IonHeader>
    <IonContent fullscreen className="item">
      <IonPopover isOpen={menuEvent !== null} event={menuEvent ?? undefined} onDidDismiss={() => setMenuEvent(null)} dismissOnSelect side="bottom" alignment="end">
        <IonList lines="none">
          <IonItem button detail={false} onClick={() => { setValues(data ? { grade: data.category.grade, subject: data.category.subject, chapter: data.category.chapter } : null); setEditing(true); }}><IonLabel>修改分类</IonLabel></IonItem>
          {data?.materialUrl ? <IonItem button detail={false} href={data.materialUrl}><IonLabel>查看材料与批改来源</IonLabel></IonItem> : null}
          {data?.canDiscard ? <IonItem button detail={false} onClick={() => setSheet('confirm')}><IonLabel color="danger">不是错题，移除</IonLabel></IonItem> : null}
        </IonList>
      </IonPopover>
      {error ? <Problem message={error.message} onRetry={() => void reload()} /> : null}
      {data && item ? <>
        <h1 className="item-title">{item.chapter}</h1>
        <p className="item-subtitle" data-testid="item-category">{[item.shortId, item.grade, item.subject].filter(Boolean).join(' · ')}{item.statusLabel ? ` · ${item.statusLabel}` : ''}</p>
        {data.images.map(image => <a key={image.url} className="item-photo" href={image.fullUrl} target="_blank" rel="noreferrer" aria-label={`${image.title}，打开原图`}><img src={image.url} alt={image.title} /></a>)}
        <div className="item-stem" data-testid="question-text">{data.questionText || '还没有可读的识别文字，请打开上方原图查看。'}</div>
        {data.badge === 'low' ? <p className="item-hint tone-orange">字可能认错了，以照片为准。</p> : null}
        <IonList inset lines="full" className="item-rows">
          {data.notes.map(note => <IonItem key={note.kind} button detail onClick={() => setOpenNote(note.kind)}><IonLabel>{note.title}</IonLabel></IonItem>)}
          <IonItem button detail onClick={() => { setValues({ grade: data.category.grade, subject: data.category.subject, chapter: data.category.chapter }); setEditing(true); }} data-testid="item-chapter">
            <IonLabel>章节</IonLabel><IonLabel slot="end" className="muted">{data.category.chapter}</IonLabel>
          </IonItem>
        </IonList>
        {data.canDiscard ? <IonButton fill="clear" color="danger" expand="block" className="item-remove" onClick={() => setSheet('confirm')} data-testid="discard">不是错题，移除</IonButton> : null}
      </> : null}
      <IonModal isOpen={openNote !== null} onDidDismiss={() => setOpenNote(null)} initialBreakpoint={0.6} breakpoints={[0, 0.6, 1]}>
        <div className="note-sheet">
          <h2>{data?.notes.find(note => note.kind === openNote)?.title}</h2>
          <pre>{data?.notes.find(note => note.kind === openNote)?.text}</pre>
        </div>
      </IonModal>
      <IonModal isOpen={editing} onDidDismiss={() => setEditing(false)}>
        <IonHeader><IonToolbar>
          <IonButtons slot="start"><IonButton onClick={() => setEditing(false)}>取消</IonButton></IonButtons>
          <IonTitle>修改分类</IonTitle>
          <IonButtons slot="end"><IonButton strong onClick={() => void save()}>保存</IonButton></IonButtons>
        </IonToolbar></IonHeader>
        <IonContent>
          {values ? <IonList inset>
            <IonItem><IonSelect label="学段" value={values.grade} interface="action-sheet" onIonChange={event => setValues({ ...values, grade: String(event.detail.value) })}>{data?.category.stages.map(stage => <IonSelectOption key={stage} value={stage}>{stage}</IonSelectOption>)}</IonSelect></IonItem>
            <IonItem><IonSelect label="学科" value={values.subject} interface="action-sheet" cancelText="取消" onIonChange={event => setValues({ ...values, subject: String(event.detail.value) })}>{(data?.category.subjects ?? []).map(name => <IonSelectOption key={name} value={name}>{name}</IonSelectOption>)}</IonSelect></IonItem>
            <IonItem><IonInput label="章节" value={values.chapter} maxlength={100} placeholder="例如：一元二次方程" onIonInput={event => setValues({ ...values, chapter: String(event.detail.value ?? '') })} /></IonItem>
          </IonList> : null}
        </IonContent>
      </IonModal>
      <IonActionSheet isOpen={sheet === 'confirm'} onDidDismiss={() => setSheet(null)} header="把这道题移出错题本？" subHeader="原图保留，移出后可以在错题本撤销。"
        buttons={[{ text: '移除', role: 'destructive', handler: () => { void remove(); } }, { text: '取消', role: 'cancel' }]} />
      <IonToast isOpen={!!toast} message={toast ?? ''} duration={3000} onDidDismiss={() => setToast(null)} />
    </IonContent>
  </IonPage>;
}
