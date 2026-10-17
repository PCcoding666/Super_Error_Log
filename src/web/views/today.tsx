import type { ReactNode } from 'react';
import { weekRangeText } from '../format.js';
import { actionHref, type PhotoView, type TodayState } from '../state.js';
import { actionKey, header, type Choice, type ConnectReason, type NextStepModel, type Step } from '../weekPlan.js';
import { NextBar, Page, Phrased, Problem, WaitLine, quoted, type BarButton, type BarModel } from './layout.js';

/** 与练习纸封面三条规则同一说法（printService.ts 55 行）。 */
export const PAPER_RULES = '做的时候：不看答案，独立做；卡住先看一级提示，再看二级；做完打勾，写上做题日期。';

/** WeekPlan 的一个按钮 → 网页上的按钮：要写服务器的（跳过、准备练习纸）走表单，其余是链接。 */
export function barButton(choice: Choice, options: { disabled?: boolean; waiting?: boolean } = {}): BarButton {
  const key = actionKey(choice.action);
  const title = choice.title;
  if (options.disabled || options.waiting) return { title, key, disabled: true, waiting: options.waiting };
  const action = choice.action;
  switch (action.kind) {
    case 'skipShoot': return { title, key, post: '/s/skip', fields: { step: 'shoot' } };
    case 'skipRecord': return { title, key, post: '/s/skip', fields: { step: 'record' } };
    case 'skipWhy': return { title, key, post: '/s/skip', fields: { step: 'why', practice: action.practiceID }, wait: '正在准备练习纸…' };
    case 'print': return { title, key, post: `/s/print/${action.practiceID}`, wait: '正在准备练习纸…' };
    default: return { title, key, href: actionHref(action) };
  }
}

export function barFromPlan(next: NextStepModel | null): BarModel | null {
  if (!next) return null;
  return {
    caption: next.caption,
    primary: next.primary ? barButton(next.primary, { disabled: !next.isEnabled && !next.isWaiting, waiting: next.isWaiting }) : null,
    secondary: next.secondary.map(choice => barButton(choice)),
  };
}

function StepRow(props: { step: Step; index: number; current: boolean }): ReactNode {
  const { step, index, current } = props;
  const cls = `${current ? 'current' : ''}${step.isDone ? ' done' : ''}`;
  const inner = (
    <>
      <span className="dot" aria-hidden="true">{step.isDone ? '✓' : index + 1}</span>
      <span className="step-body">
        <span className="step-title"><Phrased text={step.title} /></span>
        {step.isOptional && !step.isDone ? <span className="chip">可跳过</span> : null}
        {current ? <span className="chip now">现在做这个</span> : null}
        <span className="step-detail"><span className={`tone-${step.tone}`}><Phrased text={step.detail} /></span> <span className="step-min">· 约 {step.minutes} 分钟</span></span>
        {step.warning ? <span className="step-detail tone-orange"><Phrased text={step.warning} /></span> : null}
      </span>
      {step.action ? <span className="chev" aria-hidden="true">›</span> : null}
    </>
  );
  const label = `第 ${index + 1} 步，${step.title}${current ? '，现在做这个' : ''}${step.isDone ? '，做完了' : ''}`;
  // data-step / data-done / data-current：页面脚本拿来和上一次看到的清单比，放「打勾」「挪到下一步」的动效（不影响内容）。
  const marks = { 'data-step': step.kind, 'data-done': step.isDone ? '1' : '0', 'data-current': current ? '1' : '0' };
  return (
    <li>
      {step.action
        ? <a className={cls} href={actionHref(step.action)} data-testid={`today-step-${step.kind}`} aria-label={label} {...marks}>{inner}</a>
        : <div className={`row ${cls}`} data-testid={`today-step-${step.kind}`} aria-label={label} role="group" {...marks}>{inner}</div>}
    </li>
  );
}

function Rhythm(props: { active: number }): ReactNode {
  const parts: Array<[string, string]> = [['周末', '拍卷子·打印'], ['周中', '在纸上做'], ['下个周末', '录结果']];
  return (
    <ol className="rhythm" aria-label="一周的节奏">
      {parts.map(([when, what], index) => (
        <li key={when} className={index === props.active ? 'on' : ''} aria-current={index === props.active ? 'step' : undefined}><b><Phrased text={when} max={2} /></b><Phrased text={what} max={2} /></li>
      ))}
    </ol>
  );
}

/** 安装帮助按需展开，不占用当前学习任务的位置；关闭脚本也能使用。 */
function InstallHint(): ReactNode {
  return (
    <details className="today-install a2hs" data-testid="install-hint">
      <summary><span>放到主屏幕</span><span className="chev" aria-hidden="true">›</span></summary>
      <p className="small">{quoted('在 Safari 里点下方的「分享」（方框里一个向上的箭头）→「添加到主屏幕」→「添加」。以后从主屏幕上的「错题本」打开。')}</p>
      <div className="actions">
        <form method="post" action="/s/install/seen" className="inline-form"><button className="link-btn" type="submit" data-key="install-seen">知道了</button></form>
        <a href="/s/install" className="more-inline" data-key="install-how">看看怎么做</a>
      </div>
    </details>
  );
}

/** 自绘矢量图标只辅助任务识别；任务名称始终以文字呈现。 */
function TaskIcon(props: { kind: Step['kind'] | 'paper' | 'complete' }): ReactNode {
  const paths: Record<typeof props.kind, ReactNode> = {
    shoot: <><path d="M9 5.5 10.5 3h7L19 5.5H23v17H5v-17Z" /><circle cx="14" cy="14" r="5" /></>,
    pick: <><rect x="5" y="4" width="18" height="21" rx="3" /><path d="m9 11 2 2 4-4m-6 10 2 2 4-4m3-6h2m-2 8h2" /></>,
    choose: <><rect x="5" y="4" width="18" height="21" rx="3" /><path d="M10 10h8m-8 5h8m-8 5h4" /></>,
    why: <><path d="M23 13a9 9 0 0 1-9 9H9l-5 3 1.5-7A9 9 0 1 1 23 13Z" /><path d="M11 10a3 3 0 1 1 5 2c-2 1-2 1.5-2 3m0 3h.01" /></>,
    print: <><path d="M9 9V3h10v6M9 19H5V9h18v10h-4M9 16h10v9H9Z" /><path d="M19 12h.01" /></>,
    record: <><rect x="5" y="4" width="18" height="21" rx="3" /><path d="M9 9h9m-9 5h4m1 9 7-7 3 3-7 7h-3Z" /></>,
    paper: <><path d="M7 3h10l5 5v17H7ZM17 3v6h5M11 14h7m-7 5h7" /></>,
    complete: <><circle cx="14" cy="14" r="10" /><path d="m9 14 3 3 7-7" /></>,
  };
  return <span className="focus-icon" aria-hidden="true"><svg viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false">{paths[props.kind]}</svg></span>;
}

function WeekOverview(props: { state: TodayState; slot: string }): ReactNode {
  const { plan } = props.state;
  const doneCount = plan.steps.filter(step => step.isDone).length;
  const active = plan.stage === 'midweek' ? 1 : plan.stage === 'weekendB' ? 2 : 0;
  return (
    <details className="week-overview" data-week-sheet="">
      <summary data-testid="week-plan-open" aria-controls="week-plan-content">
        <span className="week-overview-label">本周安排</span>
        <span className="week-overview-meta">{plan.steps.length > 0 ? `已完成 ${doneCount} / ${plan.steps.length} 步` : '看看接下来做什么'}</span>
        <span className="chev" aria-hidden="true">›</span>
      </summary>
      <div id="week-plan-content" data-sheet-content="">
        <h2 id="week-plan-title">本周安排</h2>
        {plan.steps.length > 0 ? (
          <>
            <p className="muted" data-testid="today-header">{header(plan)}</p>
            <ul className="steps">
              {plan.steps.map((step, index) => <StepRow key={step.kind} step={step} index={index} current={index === plan.currentIndex} />)}
            </ul>
          </>
        ) : plan.practice ? <p className="muted">练习纸已准备好，{props.slot}在纸上做，做完后回来录结果。</p> : <p className="muted">周末整理错题、准备练习纸；隔几天在纸上独立做，再回来录结果。</p>}
        <h3 className="section-label">一周的节奏</h3>
        <Rhythm active={active} />
      </div>
    </details>
  );
}

/** 这周的事做完以后（做完了 / 周中）又拍了卷子：告诉他新拍的去了哪、要不要他勾。 */
function NewPhotosNote(props: { photos: PhotoView[] }): ReactNode {
  const needsPick = props.photos.find(photo => photo.state === 'needsPick');
  const finding = props.photos.some(photo => photo.state === 'finding');
  if (!needsPick && !finding) return null;
  return (
    <div data-testid="today-new-photos">
      <a className="pending-photo-row" href={needsPick ? `/s/photos/${needsPick.jobId}` : '/s/photos'} data-key="today-new-photos">
        <span><span className="pending-photo-title">{needsPick ? `第 ${needsPick.number} 张卷子` : '新拍的卷子'}</span><span className="meta-line muted">{needsPick ? '待勾出错题' : 'AI 正在找题 · 查看进度'}</span></span>
        <span className="chev" aria-hidden="true">›</span>
      </a>
      <p className="small muted">找到的题会进错题本，下个周末再选进练习。</p>
    </div>
  );
}

/** 「今天」在等什么（AI 找题 / 准备练习纸）：等的时候局部轮询，清单下面写已经等了多久。 */
export interface TodayWait { since: string | null; expect: string }

export function TodayPage(props: { state: TodayState; practiceSlot: string; flash?: { ok?: string | null; err?: string | null }; showInstallHint: boolean; wait?: TodayWait | null; now?: Date }): ReactNode {
  const { plan, week } = props.state;
  const slot = plan.practice?.practiceSlot ?? props.practiceSlot;
  const bar = barFromPlan(plan.next);
  const finding = props.state.photos.some(photo => photo.state === 'finding');
  const waiting = finding || plan.next?.isWaiting === true;
  let content: ReactNode;
  if (plan.stage === 'done') {
    content = (
      <section className="today-focus" data-testid="today-done" data-steps="" data-stage="done">
        <TaskIcon kind="complete" />
        <p className="focus-eyebrow">准备好了</p>
        <h2 className="focus-title" data-testid="today-done-title"><Phrased text="这一份练习纸已准备好" /></h2>
        <p>把练习纸带回学校，<b>{slot}</b>在纸上做。</p>
        <p><Phrased text={PAPER_RULES} /></p>
        <p className="muted">下个周末打开错题本，录一下做的结果。</p>
        {bar ? <NextBar model={bar} inline /> : null}
        <NewPhotosNote photos={props.state.photos} />
      </section>
    );
  } else if (plan.stage === 'midweek') {
    content = (
      <section className="today-focus" data-testid="today-midweek" data-steps="" data-stage="midweek">
        <TaskIcon kind="paper" />
        <p className="focus-eyebrow">纸上练习</p>
        <h2 className="focus-title" data-testid="today-midweek-title"><Phrased text="现在是在纸上做练习的时候" /></h2>
        {plan.practice ? <p className="focus-meta">{[`练习纸：${plan.practice.itemCount} 道`, slot].join(' · ')}</p> : null}
        <p><Phrased text={PAPER_RULES} /></p>
        <p className="muted"><Phrased text="没做完也没关系，周末回来再录。当天做对不算真会，隔几天再做对才算，所以别急着对答案。" /></p>
        {bar ? <NextBar model={bar} inline /> : null}
        <NewPhotosNote photos={props.state.photos} />
      </section>
    );
  } else {
    const current = plan.currentIndex === null ? null : plan.steps[plan.currentIndex];
    content = (
      <section className="today-focus" data-testid="today-card">
        <TaskIcon kind={current?.kind ?? 'complete'} />
        <p className="focus-eyebrow">{plan.next?.isWaiting ? '正在准备' : '接下来'}</p>
        <h2 className="focus-title"><Phrased text={current?.title ?? (plan.stage === 'loading' ? '正在读取本周安排' : '这周的步骤都做完了')} /></h2>
        {current ? <p className={`focus-detail tone-${current.tone}`}><Phrased text={current.detail} /></p> : null}
        {current?.warning ? <p className="focus-detail tone-orange"><Phrased text={current.warning} /></p> : null}
        {bar ? <NextBar model={bar} inline /> : null}
        {props.wait ? <WaitLine since={props.wait.since} now={props.now ?? new Date()} expect={props.wait.expect} /> : null}
      </section>
    );
  }
  return (
    <Page title="今天" back={null} tab="today" flash={props.flash} pollSeconds={waiting || props.wait ? 4 : undefined}>
      <div className="today-heading">
        <p className="today-date">本周 · {weekRangeText(week.week)}</p>
        <h1>今天</h1>
      </div>
      <div data-live="today" data-steps="" data-stage={plan.stage} data-announce={bar?.primary?.title ?? (plan.stage === 'done' ? '这一份练习纸已准备好' : plan.stage === 'midweek' ? '现在是在纸上做练习的时候' : '本周安排已更新')}>
        {content}
        {finding ? <p className="small muted" data-testid="today-processing">照片已保存，正在处理。你可以先离开，回来会接着显示进度。<a href="/s/photos" data-key="today-progress">查看处理进度</a></p> : null}
        <WeekOverview state={props.state} slot={slot} />
      </div>
      <section className="today-supplement">
        <a className="btn" href="/s/capture" data-testid="today-add-mistakes" aria-describedby="add-mistakes-hint">＋补充错题</a>
        <p className="small muted" id="add-mistakes-hint">拍照或从相册选图，随时添加。</p>
      </section>
      <section className="today-library" aria-labelledby="anytime-title">
        <h2 className="section-label" id="anytime-title">学习记录</h2>
        <ul className="list" data-live="anytime">
          <li><a className="row library-row" href="/s/items" data-testid="today-items"><span className="library-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" focusable="false"><rect x="5" y="3" width="15" height="18" rx="2" /><path d="M3 7h4m-4 5h4m-4 5h4m4-9h5m-5 4h5" /></svg></span><span className="row-text">这周的错题<span className="meta-line muted">{week.items.length} 道题</span></span><span className="chev" aria-hidden="true">›</span></a></li>
          <li><a className="row library-row" href="/s/practices" data-testid="today-practices"><span className="library-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d="M5 4h10l4 4v13H5ZM15 4v5h4M9 13h6m-6 4h6" /></svg></span><span className="row-text">以前的练习<span className="meta-line muted">练习纸和做题结果</span></span><span className="chev" aria-hidden="true">›</span></a></li>
          {props.showInstallHint ? null : <li className="a2hs-row"><a className="row" href="/s/install" data-testid="today-install"><span className="row-text">放到主屏幕</span><span className="chev" aria-hidden="true">›</span></a></li>}
        </ul>
      </section>
      {props.showInstallHint ? <InstallHint /> : null}
    </Page>
  );
}

const CONNECT_COPY: Record<ConnectReason, { title: string; detail: string; button: string }> = {
  unpaired: {
    title: '先连上服务器',
    detail: '这一步要大人帮一下：请帮你装错题本的人给你一个连接用的二维码或链接。只要做一次。',
    button: '扫码连接',
  },
  unauthorized: {
    title: '需要重新扫码',
    detail: '连接过期了。请帮你装错题本的人给你一个新的二维码或链接。照片和错题都还在。',
    button: '重新扫码',
  },
  incompatible: {
    title: '网页和服务器对不上',
    detail: '请帮你装错题本的人给你一个新的二维码或链接。',
    button: '扫新的二维码',
  },
};

/** 连接页（§4.2 的网页版）：网页里没法直接开扫码器，所以说清楚用「相机」扫，或粘贴链接。 */
export function ConnectPage(props: { reason: ConnectReason; error?: string | null; standalone?: boolean }): ReactNode {
  const copy = CONNECT_COPY[props.reason];
  const bar: BarModel = { caption: '这一步要大人帮一下', primary: { title: '用这个链接连接', key: 'connect', form: 'connect-form' }, secondary: [] };
  return (
    <Page title={copy.title} back={null} showSettings={false} bar={bar}>
      <h1 data-testid="connect-title">{copy.title}</h1>
      <p className="lead">{copy.detail}</p>
      {props.error ? <Problem title="这个二维码用不了" detail="请帮你装错题本的人重新生成一个，再扫一次。" reason={props.error} /> : null}
      <section className="card" id="connect" data-testid="today-connect">
        <h2 className="card-title">两种连法</h2>
        <ol className="steps-text">
          <li><b>二维码：</b>打开手机自带的「相机」对准它，点屏幕上弹出的链接（用 Safari 打开）。</li>
          <li><b>链接：</b>长按它选「拷贝」，粘贴到下面，再点「用这个链接连接」。</li>
        </ol>
        <form method="post" action="/s/pair" id="connect-form">
          <label htmlFor="connect-link" className="field-label">连接用的链接</label>
          <input id="connect-link" type="text" name="link" inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="https://…/s/pair?code=…" />
        </form>
        <p className="hint">放到主屏幕以后，如果主屏幕上的错题本还要你连接，请大人再给一个新链接，粘贴到这里。</p>
      </section>
    </Page>
  );
}

/** 打开配对链接后的确认页：点一下才兑换（链接预览、聊天软件的抓取不会把一次性配对码用掉）。 */
export function PairPage(props: { code: string; clientId: string; inAppBrowser: boolean }): ReactNode {
  const bar: BarModel = props.inAppBrowser
    ? { caption: '这个链接只能用一次，请先换到 Safari', primary: { title: '先在 Safari 里打开', key: 'pair', disabled: true }, secondary: [] }
    : { caption: '这一步只要做一次', primary: { title: '连接这台手机', key: 'pair', form: 'pair-form' }, secondary: [] };
  return (
    <Page title="连接这台手机" back={null} showSettings={false} bar={bar}>
      <h1>连接这台手机</h1>
      <section className="card">
        <p>{quoted('点下面的「连接这台手机」，这台手机就能用错题本了。照片、错题和练习都存在服务器上，换手机也不会丢。')}</p>
        {props.inAppBrowser
          ? <p className="tone-orange" data-testid="in-app-warning"><b>现在是在聊天软件里打开的。</b>{quoted('请点右上角「…」，选「在 Safari 中打开」，再点连接——连在这里，以后从 Safari 和主屏幕都打不开。')}</p>
          : <p className="muted small">连好以后，按提示把错题本放到主屏幕上。这个链接只能用一次。</p>}
        <form method="post" action="/s/pair" id="pair-form">
          <input type="hidden" name="code" value={props.code} />
          <input type="hidden" name="clientId" value={props.clientId} />
        </form>
      </section>
    </Page>
  );
}

export function InstallPage(): ReactNode {
  const bar: BarModel = { caption: '', primary: { title: '回到今天', key: 'goHome', href: '/s/' }, secondary: [] };
  return (
    <Page title="放到主屏幕" bar={bar}>
      <h1>放到主屏幕</h1>
      <p className="lead">放到主屏幕以后，错题本会像 App 一样全屏打开，不用每次找网址。</p>
      <section className="card">
        <h2 className="card-title">在 Safari 里，四步</h2>
        <ol className="steps-text">
          <li>用 <b>Safari</b> 打开错题本（微信里打开的先点右上角「…」→「在 Safari 中打开」）。</li>
          <li>点屏幕下方的「分享」按钮（方框里一个向上的箭头）。</li>
          <li>往下找「添加到主屏幕」，点它，再点右上角「添加」。</li>
          <li>以后从主屏幕上的「错题本」图标打开。</li>
        </ol>
      </section>
      <p className="hint">如果主屏幕上的错题本打开后让你重新连接，请大人再给一个新链接，粘贴进去就好。</p>
    </Page>
  );
}

/** 离线页：Service Worker 只缓存这一页（不含任何学生数据），导航失败时显示。 */
export function OfflinePage(): ReactNode {
  const bar: BarModel = { caption: '', primary: { title: '再试一次', key: 'retry', href: '/s/' }, secondary: [] };
  return (
    <Page title="连不上服务器" back={null} showSettings={false} bar={bar}>
      <h1 data-offline-title="" data-testid="offline-title">连不上服务器</h1>
      <section className="card">
        <p data-offline-detail="">检查一下 Wi-Fi 或流量。拍过的照片和错题都在服务器上，不会丢；刚才没传上去的照片要重新拍一次。</p>
        <p className="muted small">用网页拍的照片不会存进手机相册，所以没联网的时候先别拍，连上再拍。</p>
      </section>
    </Page>
  );
}

/**
 * 服务器忙（429）。按这台手机现在的连接情况分三种说法：
 * - connected：已经连着（请求太频繁）——照片和错题都在。
 * - unpaired：还没连上（连接失败太多次才会到这里，手里的链接多半已经用过或过期）——等一会儿再试，还是不行就要一个新的。
 * - expired：以前连上过、连接失效了（cookie 无效）——不说「还没连上」；要一个新的二维码或链接重新连，照片和错题都还在。
 */
export type BusyReason = 'connected' | 'unpaired' | 'expired';
const BUSY_NOTES: Record<BusyReason, string> = {
  connected: '已经传上去的照片和错题都在服务器上，不会丢。',
  unpaired: '还没连上服务器。等一会儿再试；还是不行，请大人给一个新的二维码或链接。',
  expired: '连接过期了，要请大人给一个新的二维码或链接。照片和错题都还在服务器上。',
};

export function BusyPage(props: { retryAfterSeconds: number; reason: BusyReason }): ReactNode {
  const bar: BarModel = { caption: `大约 ${Math.max(1, Math.ceil(props.retryAfterSeconds / 60))} 分钟后再试`, primary: { title: '过一会儿再试', key: 'retry', href: '/s/' }, secondary: [] };
  return (
    <Page title="服务器有点忙" back={null} showSettings={props.reason === 'connected'} bar={bar}>
      <h1>服务器有点忙</h1>
      <section className="card">
        <p>现在来的请求太多了，过一会儿再点下面的按钮。</p>
        <p className="muted small" data-testid="busy-note"><Phrased text={BUSY_NOTES[props.reason]} /></p>
      </section>
    </Page>
  );
}

export function ErrorPage(props: { title: string; detail: string; reason?: string | null }): ReactNode {
  const bar: BarModel = { caption: '', primary: { title: '回到今天', key: 'goHome', href: '/s/' }, secondary: [] };
  return (
    <Page title={props.title} bar={bar}>
      <h1>{props.title}</h1>
      <section className="card" role="alert" data-testid="problem">
        <p>{props.detail}</p>
        {props.reason ? <details><summary data-key="problem-reason">具体原因</summary><p className="muted small">{props.reason}</p></details> : null}
      </section>
    </Page>
  );
}
