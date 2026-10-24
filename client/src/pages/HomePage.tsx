import {
  IonActionSheet, IonButton, IonButtons, IonCheckbox, IonContent, IonFab, IonFabButton, IonHeader, IonIcon, IonItem, IonItemOption, IonItemOptions, IonItemSliding,
  IonLabel, IonList, IonPage, IonPopover, IonSearchbar, IonTitle, IonToast, IonToolbar, useIonViewWillEnter,
} from '@ionic/react';
import { cameraOutline, checkmark, checkmarkCircleOutline, chevronDown, gridOutline, listOutline, optionsOutline, searchOutline, settingsOutline, trashOutline } from 'ionicons/icons';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { NotebookItem, NotebookResponse } from '../../../src/web/apiTypes';
import { CAPTURE_INPUT_ID, CaptureInput } from '../components/CaptureInput';
import { Problem } from '../components/Problem';
import { StageGate } from '../components/StageGate';
import { api } from '../lib/api';
import { useLoad, useLocalPreference } from '../lib/hooks';

const STATUS_CHOICES: Array<{ value: string; label: string }> = [
  { value: '', label: '全部状态' }, { value: 'todo', label: '待练习' }, { value: 'practicing', label: '练习中' }, { value: 'mastered', label: '真会了' }, { value: 'stable', label: '稳了' },
];

function dateLabel(day: string | null, groupKey: string): string {
  if (groupKey === 'today') return '今天';
  const match = day && /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  return match ? `${Number(match[1])}/${Number(match[2])}` : '';
}

export function HomePage(): ReactNode {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const query = useMemo(() => ({ subject: params.get('subject') ?? '', grade: params.get('grade') ?? '', chapter: params.get('chapter') ?? '', status: params.get('status') ?? '', q: params.get('q') ?? '' }), [params]);
  const { data, error, loading, reload } = useLoad(() => api.notebook(query), [query.subject, query.grade, query.chapter, query.status, query.q]);
  useIonViewWillEnter(() => { void reload(); });
  const [view, setView] = useLocalPreference('sel-notebook-view', 'list');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [searchOpen, setSearchOpen] = useState(!!query.q);
  const [sheet, setSheet] = useState<'subject' | 'stage' | 'chapter' | 'status' | 'confirm' | null>(null);
  const [toast, setToast] = useState<{ message: string; undo?: string[] } | null>(null);
  const [connected, setConnected] = useState(params.get('paired') === '1' || params.get('login') === '1');
  const [menuEvent, setMenuEvent] = useState<Event | null>(null);

  const patch = useCallback((changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) { if (value) next.set(key, value); else next.delete(key); }
    next.delete('paired'); next.delete('login');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const items = useMemo(() => (data?.groups ?? []).flatMap(group => group.items), [data]);
  const toggle = (id: string): void => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const leaveSelect = (): void => { setSelecting(false); setSelected(new Set()); };
  const discard = async (ids: string[]): Promise<void> => {
    try {
      const result = await api.discard(ids);
      setToast({ message: result.removed.length ? `已移除 ${result.removed.length} 道` : (result.failed[0]?.message ?? '没有移除'), undo: result.removed.length ? result.removed : undefined });
    } catch (caught) { setToast({ message: caught instanceof Error ? caught.message : '没有移除' }); }
    leaveSelect();
    await reload();
  };
  const undo = async (ids: string[]): Promise<void> => {
    for (const id of ids) { try { await api.restore(id); } catch { /* 留给下一次刷新 */ } }
    setToast(null);
    await reload();
  };

  if (error?.code === 'stage_required') return <StageGate onChosen={() => void reload()} />;

  const openCamera = (): void => { document.getElementById(CAPTURE_INPUT_ID)?.click(); };
  const subtitle = data ? `${data.grade} · ${data.total} 道错题${data.shown !== data.total ? ` · 显示 ${data.shown} 道` : ''}${data.todo ? ` · ${data.todo} 道待练习` : ''}` : '';
  const renderRow = (item: NotebookItem): ReactNode => {
    // 摘要不用 <p>：iOS 模式下 ion-label 自带的 p 样式会盖掉两行截断，露出第三行的半截。
    const body = <IonLabel className="ion-text-wrap">
      <h2>{item.chapter}</h2>
      <span className="row-excerpt">{item.excerpt || '题目文字暂不可用，可查看原图。'}</span>
    </IonLabel>;
    if (selecting) {
      return <IonItem key={item.id} className="notebook-row" button detail={false} onClick={() => toggle(item.id)} data-testid="item-card">
        <IonCheckbox slot="start" checked={selected.has(item.id)} aria-label={`选择 ${item.chapter}`} onIonChange={() => toggle(item.id)} />
        {body}
      </IonItem>;
    }
    return <IonItemSliding key={item.id}>
      <IonItem className="notebook-row" routerLink={`/q/${item.id}`} detail data-testid="item-card">{body}</IonItem>
      <IonItemOptions side="end">
        <IonItemOption color="danger" onClick={() => void discard([item.id])}>移除</IonItemOption>
      </IonItemOptions>
    </IonItemSliding>;
  };
  const renderCard = (item: NotebookItem, groupKey: string): ReactNode => {
    const picked = selected.has(item.id);
    const content = <>
      <span className="card-date">{dateLabel(item.intakeDay, groupKey)}</span>
      <img className="card-crop" src={item.thumb} alt="" loading="lazy" />
      <b>{item.chapter}</b>
      <span className="card-excerpt">{item.excerpt}</span>
    </>;
    return <button key={item.id} type="button" className={`notebook-card${picked ? ' picked' : ''}`} onClick={() => (selecting ? toggle(item.id) : navigate(`/q/${item.id}`))} data-testid="item-card">
      {selecting ? <span className={`pick-mark${picked ? ' on' : ''}`} aria-hidden="true"><IonIcon icon={checkmark} /></span> : null}{content}
    </button>;
  };

  return <IonPage>
    {selecting ? <IonHeader className="select-header" translucent>
      <IonToolbar>
        <IonButtons slot="start"><IonButton onClick={leaveSelect}>取消</IonButton></IonButtons>
        <IonTitle>已选 {selected.size} 道</IonTitle>
        <IonButtons slot="end"><IonButton className="select-done" onClick={leaveSelect} aria-label="完成选择"><IonIcon icon={checkmark} slot="icon-only" /></IonButton></IonButtons>
      </IonToolbar>
    </IonHeader> : null}
    <IonContent fullscreen className="home" scrollEvents={false}>
      <CaptureInput />
      {!selecting ? <div className="home-top">
        <div className="capsule">
          <IonButton fill="clear" aria-label="视图与筛选" data-testid="notebook-filters" onClick={event => setMenuEvent(event.nativeEvent)}><IonIcon icon={optionsOutline} slot="icon-only" /></IonButton>
          <IonButton fill="clear" routerLink="/me" aria-label="设置" data-testid="settings-link"><IonIcon icon={settingsOutline} slot="icon-only" /></IonButton>
        </div>
      </div> : null}
      <IonPopover isOpen={menuEvent !== null} event={menuEvent ?? undefined} onDidDismiss={() => setMenuEvent(null)} dismissOnSelect side="bottom" alignment="end" className="filter-popover">
        <IonList lines="none">
          <IonItem button detail={false} onClick={() => setView('grid')}><IonIcon icon={gridOutline} slot="start" /><IonLabel>网格</IonLabel>{view === 'grid' ? <IonIcon icon={checkmark} slot="end" /> : null}</IonItem>
          <IonItem button detail={false} onClick={() => setView('list')}><IonIcon icon={listOutline} slot="start" /><IonLabel>列表</IonLabel>{view === 'list' ? <IonIcon icon={checkmark} slot="end" /> : null}</IonItem>
          <IonItem button detail={false} className="menu-divider" onClick={() => { setSelecting(true); setSelected(new Set()); }} disabled={!items.length}><IonIcon icon={checkmarkCircleOutline} slot="start" /><IonLabel>选择</IonLabel></IonItem>
          {data && data.stages.length > 1 ? <IonItem button detail className="menu-divider" onClick={() => setSheet('stage')} data-testid="stage-filter"><IonLabel>学段</IonLabel><IonLabel slot="end" className="muted">{data.grade}</IonLabel></IonItem> : null}
          <IonItem button detail className={data && data.stages.length > 1 ? undefined : 'menu-divider'} onClick={() => setSheet('chapter')}><IonLabel>章节</IonLabel><IonLabel slot="end" className="muted">{query.chapter || '全部'}</IonLabel></IonItem>
          <IonItem button detail onClick={() => setSheet('status')}><IonLabel>状态</IonLabel><IonLabel slot="end" className="muted">{STATUS_CHOICES.find(choice => choice.value === query.status)?.label ?? '全部'}</IonLabel></IonItem>
        </IonList>
      </IonPopover>
      {!selecting ? <>
        <button type="button" className="home-title" onClick={() => setSheet('subject')} aria-label={`切换学科，当前${data?.subject ?? ''}`} data-testid="subject-switch">
          <span>{data?.subject ?? ' '}</span><IonIcon icon={chevronDown} />
        </button>
        <p className="home-subtitle" role="status">{subtitle}</p>
      </> : null}
      {searchOpen || query.q ? <IonSearchbar value={query.q} placeholder="搜索" debounce={300} inputmode="search" showCancelButton="always" cancelButtonText="取消"
        onIonInput={event => patch({ q: String(event.detail.value ?? '') })} onIonCancel={() => { setSearchOpen(false); patch({ q: '' }); }} className="home-search" /> : null}
      {data && (data.finding || data.pendingIntake) ? <IonList inset lines="none" className="intake-hint">
        <IonItem routerLink="/new" detail data-testid="intake-hint"><IonLabel>{data.finding ? `AI 正在找题（${data.finding} 张照片）` : `照片里还有 ${data.pendingIntake} 道没收进错题本`}</IonLabel></IonItem>
      </IonList> : null}
      {error && error.code !== 'stage_required' ? <Problem message={error.message} onRetry={() => void reload()} /> : null}
      {data && !items.length && !loading ? <div className="empty" data-testid="empty-notebook">
        <IonIcon icon={cameraOutline} />
        <b>{data.total ? '没有符合筛选的题' : '拍一张批改过的卷子'}</b>
        <p>{data.total ? '换个章节或状态试试。' : 'AI 会找出错题，放进这里。'}</p>
        {data.total ? <IonButton fill="clear" onClick={() => patch({ chapter: '', status: '', q: '' })}>清除筛选</IonButton> : <IonButton shape="round" onClick={openCamera}><IonIcon icon={cameraOutline} slot="start" />去拍照</IonButton>}
      </div> : null}
      {data?.groups.map(group => <section key={group.key} className="group">
        <h2 className="group-label">{group.title}</h2>
        {view === 'grid'
          ? <div className="notebook-grid">{group.items.map(item => renderCard(item, group.key))}</div>
          : <IonList lines="full" className="notebook-list">{group.items.map(renderRow)}</IonList>}
      </section>)}
      <div className="bottom-space" />
      {!selecting ? <>
        <IonFab vertical="bottom" horizontal="start" slot="fixed"><IonFabButton color="light" size="small" className="corner corner-search" aria-label="搜索" data-testid="corner-search" onClick={() => setSearchOpen(open => !open)}><IonIcon icon={searchOutline} /></IonFabButton></IonFab>
        <IonFab vertical="bottom" horizontal="end" slot="fixed"><IonFabButton className="corner corner-capture" aria-label="拍照录入" data-testid="next-step-primary" onClick={openCamera}><IonIcon icon={cameraOutline} /></IonFabButton></IonFab>
      </> : <IonFab vertical="bottom" horizontal="end" slot="fixed"><IonFabButton color="danger" className="corner" aria-label="移除所选" data-testid="discard-selected" disabled={!selected.size} onClick={() => setSheet('confirm')}><IonIcon icon={trashOutline} /></IonFabButton></IonFab>}
      <IonActionSheet isOpen={sheet === 'subject'} onDidDismiss={() => setSheet(null)} header="学科"
        buttons={[...(data?.subjects ?? []).map(name => ({ text: name, role: name === data?.subject ? 'selected' : undefined, handler: () => patch({ subject: name, grade: '', chapter: '', status: '', q: '' }) })), { text: '取消', role: 'cancel' }]} />
      <IonActionSheet isOpen={sheet === 'stage'} onDidDismiss={() => setSheet(null)} header="学段"
        buttons={[...(data?.stages ?? []).map(name => ({ text: name, role: name === data?.grade ? 'selected' : undefined, handler: () => patch({ grade: name, chapter: '' }) })), { text: '取消', role: 'cancel' }]} />
      <IonActionSheet isOpen={sheet === 'chapter'} onDidDismiss={() => setSheet(null)} header="章节"
        buttons={[{ text: '全部章节', role: query.chapter ? undefined : 'selected', handler: () => patch({ chapter: '' }) }, ...(data?.chapters ?? []).map(name => ({ text: name, role: name === query.chapter ? 'selected' : undefined, handler: () => patch({ chapter: name }) })), { text: '取消', role: 'cancel' }]} />
      <IonActionSheet isOpen={sheet === 'status'} onDidDismiss={() => setSheet(null)} header="状态"
        buttons={[...STATUS_CHOICES.map(choice => ({ text: choice.label, role: choice.value === query.status ? 'selected' : undefined, handler: () => patch({ status: choice.value }) })), { text: '取消', role: 'cancel' }]} />
      <IonActionSheet isOpen={sheet === 'confirm'} onDidDismiss={() => setSheet(null)} header={`把这 ${selected.size} 道移出错题本？`} subHeader="原图保留，移出后可以撤销。"
        buttons={[{ text: '移除', role: 'destructive', handler: () => { void discard([...selected]); } }, { text: '取消', role: 'cancel' }]} />
      <IonToast isOpen={!!toast} message={toast?.message ?? ''} duration={6000} position="bottom" onDidDismiss={() => setToast(null)}
        buttons={toast?.undo ? [{ text: '撤销', handler: () => { void undo(toast.undo!); } }] : []} />
      <IonToast isOpen={connected} message="已连接 ✓" duration={2000} position="top" onDidDismiss={() => { setConnected(false); patch({}); }} />
    </IonContent>
  </IonPage>;
}

export type { NotebookResponse };
