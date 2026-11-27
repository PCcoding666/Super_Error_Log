import {
  IonActionSheet, IonButton, IonButtons, IonCheckbox, IonContent, IonFab, IonFabButton, IonHeader, IonIcon, IonItem, IonItemOption, IonItemOptions, IonItemSliding,
  IonLabel, IonList, IonPage, IonPopover, IonSearchbar, IonSkeletonText, IonTitle, IonToast, IonToolbar, useIonViewWillEnter,
} from '@ionic/react';
import { cameraOutline, checkmark, checkmarkCircleOutline, chevronDown, gridOutline, listOutline, optionsOutline, searchOutline, settingsOutline, trashOutline } from 'ionicons/icons';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { NotebookItem, NotebookResponse } from '../../../src/web/apiTypes';
import { CaptureDock, CaptureEntry } from '../components/CaptureDock';
import { useCaptureSession } from '../lib/captureSession';
import { Problem } from '../components/Problem';
import { StageGate } from '../components/StageGate';
import { api } from '../lib/api';
import { presentActionSheet } from '../lib/sheets';
import { useLoad, useLocalPreference } from '../lib/hooks';

function dateLabel(day: string | null, groupKey: string): string {
  if (groupKey === 'today') return '今天';
  const match = day && /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  return match ? `${Number(match[1])}/${Number(match[2])}` : '';
}


export function HomePage(): ReactNode {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const query = useMemo(() => ({ subject: params.get('subject') ?? '', grade: params.get('grade') ?? '', chapter: params.get('chapter') ?? '', tag: params.get('tag') ?? '', q: params.get('q') ?? '' }), [params]);
  const { data, error, loading, reload } = useLoad(() => api.notebook(query), [query.subject, query.grade, query.chapter, query.tag, query.q]);
  useIonViewWillEnter(() => { void reload(); });
  // 还有照片或材料在找题：每 3 秒取一次，和录入页一样。提示和题目不用离开这一页也会出现。失败的任务不占 finding，所以不会一直轮询。
  const finding = (data?.finding ?? 0) > 0;
  useEffect(() => {
    if (!finding) return;
    const timer = setInterval(() => { void reload(); }, 3000);
    return () => clearInterval(timer);
  }, [finding, reload]);
  const [view, setView] = useLocalPreference('sel-notebook-view', 'list');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [searchOpen, setSearchOpen] = useState(!!query.q);
  // 筛选用的 action sheet 走命令式 present（见 lib/sheets.ts），上一张收起的回调不会把刚打开的这张关掉。
  const [confirming, setConfirming] = useState(false);
  const [toast, setToast] = useState<{ message: string; undo?: string[] } | null>(null);
  const [connected, setConnected] = useState(params.get('paired') === '1' || params.get('login') === '1');
  const [menuEvent, setMenuEvent] = useState<Event | null>(null);
  const capture = useCaptureSession();
  // routerLink 会把 ion-button 画成 shadow DOM 里的 <a href>。点在图标上时，iOS 会先给按钮
  // 加上按下态（pointerdown → ion-activated），再把 click 丢掉——可滚动的 ion-content、以及
  // 筛选弹层的全屏遮罩刚收起时都容易这样。筛选按钮是普通 button + onClick，同样的点按能打开菜单。
  // 设置也在 click 时 navigate。若 click 没来，松手后的定时器仍进入设置。
  const settingsPointer = useRef<{ x: number; y: number } | null>(null);
  const settingsFallback = useRef(0);
  const openSettings = useCallback(() => {
    window.clearTimeout(settingsFallback.current);
    settingsFallback.current = 0;
    setMenuEvent(null);
    navigate('/me');
  }, [navigate]);
  useEffect(() => () => window.clearTimeout(settingsFallback.current), []);
  const onSettingsPointerDown = (event: ReactPointerEvent): void => {
    if (event.button !== 0) return;
    settingsPointer.current = { x: event.clientX, y: event.clientY };
  };
  const onSettingsPointerUp = (event: ReactPointerEvent): void => {
    const start = settingsPointer.current;
    settingsPointer.current = null;
    // 触摸的 pointerup 在部分 WebKit 上 button 是 -1，不能据此丢掉这下点按。
    if (!start || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (dx * dx + dy * dy > 144) return;
    // click 通常紧跟着来，由它导航。iOS 把 click 丢掉时，松手后仍进入设置。
    window.clearTimeout(settingsFallback.current);
    settingsFallback.current = window.setTimeout(openSettings, 400);
  };
  const onSettingsClick = (event: ReactMouseEvent): void => {
    event.preventDefault();
    openSettings();
  };
  // 筛选弹层铺满整屏（ion-app 上 z-index 高于页面），齿轮的坐标实际点到的是透明遮罩。
  // 深色底上遮罩几乎看不见，按下态却像落在齿轮上。菜单开着时按坐标认这下点按。
  useEffect(() => {
    if (menuEvent === null) return;
    let start: { x: number; y: number } | null = null;
    const insideSettings = (x: number, y: number): boolean => {
      const button = document.querySelector('[data-testid="settings-link"]');
      if (!button) return false;
      const rect = button.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };
    const down = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      start = insideSettings(event.clientX, event.clientY) ? { x: event.clientX, y: event.clientY } : null;
    };
    const up = (event: PointerEvent): void => {
      const origin = start;
      start = null;
      if (!origin || (event.pointerType === 'mouse' && event.button !== 0)) return;
      const dx = event.clientX - origin.x;
      const dy = event.clientY - origin.y;
      if (dx * dx + dy * dy > 144) return;
      if (!insideSettings(event.clientX, event.clientY)) return;
      openSettings();
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
    };
  }, [menuEvent, openSettings]);

  const patch = useCallback((changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) { if (value) next.set(key, value); else next.delete(key); }
    next.delete('paired'); next.delete('login');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const cancel = { text: '取消', role: 'cancel' as const };
  const showSubjectSheet = (): void => { void presentActionSheet({ header: '学科', buttons: [...(data?.subjects ?? []).map(name => ({ text: name, role: name === data?.subject ? 'selected' : undefined, handler: () => patch({ subject: name, grade: '', chapter: '', tag: '', q: '' }) })), cancel] }); };
  const showStageSheet = (): void => { void presentActionSheet({ header: '学段', buttons: [...(data?.stages ?? []).map(name => ({ text: name, role: name === data?.grade ? 'selected' : undefined, handler: () => patch({ grade: name, chapter: '', tag: '' }) })), cancel] }); };
  const showChapterSheet = (): void => { void presentActionSheet({ header: '章节', buttons: [{ text: '全部章节', role: query.chapter ? undefined : 'selected', handler: () => patch({ chapter: '' }) }, ...(data?.chapters ?? []).map(name => ({ text: name, role: name === query.chapter ? 'selected' : undefined, handler: () => patch({ chapter: name }) })), cancel] }); };
  const showTagSheet = (): void => { void presentActionSheet({ header: '知识点', buttons: [{ text: '全部知识点', role: query.tag ? undefined : 'selected', handler: () => patch({ tag: '' }) }, ...(data?.tags ?? []).map(name => ({ text: name, role: name === query.tag ? 'selected' : undefined, handler: () => patch({ tag: name }) })), cancel] }); };

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

  // 第一份数据还没回来（也没出错）：先画骨架，别让标题和列表空着。之后的刷新保留旧数据，不再闪骨架。
  const first = !data && !error;
  const subtitle = data ? `${data.grade} · ${data.total} 道错题${data.shown !== data.total ? ` · 显示 ${data.shown} 道` : ''}` : '';
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
      </IonToolbar>
    </IonHeader> : null}
    <IonContent fullscreen className="home" scrollEvents={false}>
      {!selecting ? <div className="home-top">
        <div className="capsule">
          <IonButton fill="clear" aria-label="视图与筛选" data-testid="notebook-filters" onClick={event => setMenuEvent(event.nativeEvent)}><IonIcon icon={optionsOutline} slot="icon-only" /></IonButton>
          <IonButton fill="clear" type="button" aria-label="设置" data-testid="settings-link" onPointerDown={onSettingsPointerDown} onPointerUp={onSettingsPointerUp} onClick={onSettingsClick}><IonIcon icon={settingsOutline} slot="icon-only" /></IonButton>
        </div>
      </div> : null}
      <IonPopover isOpen={menuEvent !== null} event={menuEvent ?? undefined} onDidDismiss={() => setMenuEvent(null)} dismissOnSelect side="bottom" alignment="end" className="filter-popover">
        <IonList lines="none">
          <IonItem button detail={false} onClick={() => setView('grid')}><IonIcon icon={gridOutline} slot="start" /><IonLabel>网格</IonLabel>{view === 'grid' ? <IonIcon icon={checkmark} slot="end" /> : null}</IonItem>
          <IonItem button detail={false} onClick={() => setView('list')}><IonIcon icon={listOutline} slot="start" /><IonLabel>列表</IonLabel>{view === 'list' ? <IonIcon icon={checkmark} slot="end" /> : null}</IonItem>
          <IonItem button detail={false} className="menu-divider" onClick={() => { setSelecting(true); setSelected(new Set()); }} disabled={!items.length}><IonIcon icon={checkmarkCircleOutline} slot="start" /><IonLabel>选择</IonLabel></IonItem>
          {data && data.stages.length > 1 ? <IonItem button detail className="menu-divider" onClick={showStageSheet} data-testid="stage-filter"><IonLabel>学段</IonLabel><IonLabel slot="end" className="muted">{data.grade}</IonLabel></IonItem> : null}
          <IonItem button detail className={data && data.stages.length > 1 ? undefined : 'menu-divider'} onClick={showChapterSheet}><IonLabel>章节</IonLabel><IonLabel slot="end" className="muted">{query.chapter || '全部'}</IonLabel></IonItem>
          <IonItem button detail onClick={showTagSheet} disabled={!data?.tags.length} data-testid="tag-filter"><IonLabel>知识点</IonLabel><IonLabel slot="end" className="muted">{query.tag || '全部'}</IonLabel></IonItem>
        </IonList>
      </IonPopover>
      {!selecting ? <>
        <button type="button" className="home-title" onClick={showSubjectSheet} disabled={!data} aria-label={data ? `切换学科，当前${data.subject}` : '学科'} data-testid="subject-switch">
          {first ? <IonSkeletonText animated className="sk-title" aria-hidden="true" /> : <><span>{data?.subject ?? ' '}</span><IonIcon icon={chevronDown} /></>}
        </button>
        <p className="home-subtitle" role="status" aria-busy={first}>{first ? <IonSkeletonText animated className="sk-subtitle" aria-hidden="true" /> : subtitle}</p>
      </> : null}
      {searchOpen || query.q ? <IonSearchbar value={query.q} placeholder="搜索" debounce={300} inputmode="search" showCancelButton="always" cancelButtonText="取消"
        onIonInput={event => patch({ q: String(event.detail.value ?? '') })} onIonCancel={() => { setSearchOpen(false); patch({ q: '' }); }} className="home-search" /> : null}
      {data && (data.finding || data.pendingIntake) ? <IonList inset lines="none" className="intake-hint">
        <IonItem routerLink="/new" detail data-testid="intake-hint"><IonLabel>{data.finding ? `AI 正在找题（${data.finding} 张照片）` : `照片里还有 ${data.pendingIntake} 道没收进错题本`}</IonLabel></IonItem>
      </IonList> : null}
      {error && error.code !== 'stage_required' ? <Problem message={error.message} requestId={error.requestId} onRetry={() => void reload()} /> : null}
      {first ? <div className="sk-list" data-testid="home-skeleton" aria-hidden="true">
        {[0, 1, 2, 3].map(row => <div key={row} className="sk-row"><IonSkeletonText animated /><IonSkeletonText animated /></div>)}
      </div> : null}
      {data && !items.length && !loading ? <div className="empty" data-testid="empty-notebook">
        <IonIcon icon={cameraOutline} />
        <b>{data.total ? '没有符合筛选的题' : '拍一张你的错题照片'}</b>
        <p>{data.total ? '换个章节或状态试试。' : 'AI 会找出错题，放进这里。'}</p>
        {data.total ? <IonButton fill="clear" onClick={() => patch({ chapter: '', tag: '', q: '' })}>清除筛选</IonButton> : capture.pages.length ? null : <div className="empty-actions">
          <CaptureEntry className="pick-button pick-solid" testId="capture-add">新增</CaptureEntry>
        </div>}
      </div> : null}
      {data?.groups.map(group => <section key={group.key} className="group">
        <h2 className="group-label">{group.title}</h2>
        {view === 'grid'
          ? <div className="notebook-grid">{group.items.map(item => renderCard(item, group.key))}</div>
          : <IonList lines="full" className="notebook-list">{group.items.map(renderRow)}</IonList>}
      </section>)}
      <div className={capture.pages.length ? 'bottom-space tall' : 'bottom-space'} />
      {!selecting ? <>
        <IonFab vertical="bottom" horizontal="start" slot="fixed"><IonFabButton color="light" size="small" className="corner corner-search" aria-label="搜索" data-testid="corner-search" onClick={() => setSearchOpen(open => !open)}><IonIcon icon={searchOutline} /></IonFabButton></IonFab>
        <CaptureDock placement="corner" showAdd={!(data && !items.length && !data.total && capture.pages.length === 0)} showMode={!(data && !items.length && !data.total && capture.pages.length === 0)} />
      </> : <IonFab vertical="bottom" horizontal="end" slot="fixed"><IonFabButton color="danger" className="corner" aria-label="移除所选" data-testid="discard-selected" disabled={!selected.size} onClick={() => setConfirming(true)}><IonIcon icon={trashOutline} /></IonFabButton></IonFab>}
      <IonActionSheet isOpen={confirming} onDidDismiss={() => setConfirming(false)} header={`把这 ${selected.size} 道移出错题本？`} subHeader="原图保留，移出后可以撤销。"
        buttons={[{ text: '移除', role: 'destructive', handler: () => { void discard([...selected]); } }, { text: '取消', role: 'cancel' }]} />
      <IonToast isOpen={!!toast} message={toast?.message ?? ''} duration={6000} position="bottom" onDidDismiss={() => setToast(null)}
        buttons={toast?.undo ? [{ text: '撤销', handler: () => { void undo(toast.undo!); } }] : []} />
      <IonToast isOpen={connected} message="已连接 ✓" duration={2000} position="top" onDidDismiss={() => { setConnected(false); patch({}); }} />
    </IonContent>
  </IonPage>;
}

export type { NotebookResponse };
