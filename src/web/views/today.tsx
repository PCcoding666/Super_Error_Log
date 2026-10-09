import type { ReactNode } from 'react';
import { actionHref, type TodayState } from '../state.js';
import { actionKey, header, type Choice, type ConnectReason, type NextStepModel, type Step } from '../weekPlan.js';
import { Page, Problem, type BarButton, type BarModel } from './layout.js';

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
        <span className="step-title">{step.title}</span>
        {step.isOptional && !step.isDone ? <span className="chip">可跳过</span> : null}
        {current ? <span className="chip now">现在做这个</span> : null}
        <span className={`small tone-${step.tone}`} style={{ display: 'block' }}>{step.detail}</span>
        {step.warning ? <span className="small tone-orange" style={{ display: 'block' }}>{step.warning}</span> : null}
        <span className="small muted" style={{ display: 'block' }}>约 {step.minutes} 分钟</span>
      </span>
      {step.action ? <span className="chev" aria-hidden="true">›</span> : null}
    </>
  );
  const label = `第 ${index + 1} 步，${step.title}${current ? '，现在做这个' : ''}${step.isDone ? '，做完了' : ''}`;
  return (
    <li>
      {step.action
        ? <a className={cls} href={actionHref(step.action)} data-testid={`today-step-${step.kind}`} aria-label={label}>{inner}</a>
        : <div className={`row ${cls}`} data-testid={`today-step-${step.kind}`} aria-label={label}>{inner}</div>}
    </li>
  );
}

function Rhythm(props: { active: number }): ReactNode {
  const parts: Array<[string, string]> = [['周末', '拍卷子·打印'], ['周中', '在纸上做'], ['下个周末', '录结果']];
  return (
    <div className="rhythm" aria-label="一周的节奏">
      {parts.map(([when, what], index) => <span key={when} className={index === props.active ? 'on' : ''}><b>{when}</b>{what}</span>)}
    </div>
  );
}

function InstallHint(): ReactNode {
  return (
    <section className="card a2hs" data-testid="install-hint">
      <p><b>放到主屏幕，像 App 一样打开</b></p>
      <p className="small">在 Safari 里：点屏幕下方的「分享」按钮（方框里一个向上的箭头）→ 往下找「添加到主屏幕」→ 点「添加」。以后从主屏幕上的「错题本」打开。</p>
      <form method="post" action="/s/install/seen" className="inline-form"><button className="link-btn" type="submit">知道了</button></form>
      {' · '}<a href="/s/install" className="small">看看怎么做</a>
    </section>
  );
}

export function TodayPage(props: { state: TodayState; practiceSlot: string; flash?: { ok?: string | null; err?: string | null }; showInstallHint: boolean }): ReactNode {
  const { plan, week } = props.state;
  const slot = plan.practice?.practiceSlot ?? props.practiceSlot;
  const active = plan.stage === 'midweek' ? 1 : plan.stage === 'weekendB' ? 2 : 0;
  let content: ReactNode;
  if (plan.stage === 'done') {
    content = (
      <section className="card" data-testid="today-done">
        <h2 data-testid="today-done-title" style={{ marginTop: 0 }}><span className="tone-green">✓</span> 这周的事做完了</h2>
        <p>把练习纸带回学校，<b>{slot}</b>在纸上做。</p>
        <p>{PAPER_RULES}</p>
        <p className="muted">下个周末打开错题本，录一下做的结果。</p>
      </section>
    );
  } else if (plan.stage === 'midweek') {
    content = (
      <section className="card" data-testid="today-midweek">
        <h2 data-testid="today-midweek-title" style={{ marginTop: 0 }}>现在是在纸上做练习的时候</h2>
        {plan.practice ? <p>{[`练习纸：${plan.practice.itemCount} 道`, slot].join(' · ')}</p> : null}
        <p>{PAPER_RULES}</p>
        <p className="muted">没做完也没关系，周末回来再录。当天做对不算真会，隔几天再做对才算，所以别急着对答案。</p>
      </section>
    );
  } else {
    content = (
      <section className="card" data-testid="today-card">
        <p style={{ display: 'flex', justifyContent: 'space-between', margin: 0 }}>
          <b data-testid="today-header">{header(plan)}</b>
          <span className="small muted">{plan.steps.filter(step => step.isDone).length}/{plan.steps.length}</span>
        </p>
        <ul className="steps">
          {plan.steps.map((step, index) => <StepRow key={step.kind} step={step} index={index} current={index === plan.currentIndex} />)}
        </ul>
        {plan.currentIndex === null ? <p className="muted small" style={{ marginTop: 8 }}>这周的步骤都做完了。</p> : null}
      </section>
    );
  }
  return (
    <Page title="今天" back={null} bar={barFromPlan(plan.next)} flash={props.flash}>
      <h1>今天</h1>
      <Rhythm active={active} />
      {props.showInstallHint ? <InstallHint /> : null}
      {content}
      <section className="card">
        <p className="muted small" style={{ marginTop: 0 }}>随时可以看</p>
        <ul className="list">
          <li><a className="row" href="/s/items" data-testid="today-items"><span style={{ flex: 1 }}>这周的错题（{week.items.length}）</span><span className="chev">›</span></a></li>
          <li><a className="row" href="/s/practices" data-testid="today-practices"><span style={{ flex: 1 }}>以前的练习</span><span className="chev">›</span></a></li>
        </ul>
      </section>
    </Page>
  );
}

const CONNECT_COPY: Record<ConnectReason, { title: string; detail: string; button: string }> = {
  unpaired: {
    title: '先连上服务器',
    detail: '这一步要大人帮一下：请帮你装错题本的人给你一个配对二维码或链接。用手机自带的「相机」扫二维码，点弹出来的链接；或者把链接粘贴到下面。只要做一次。',
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
      <section className="card" id="connect" data-testid="today-connect">
        <p>{copy.detail}</p>
        <ol className="small">
          <li>打开手机自带的「相机」，对准二维码，点屏幕上弹出的链接（用 Safari 打开）。</li>
          <li>如果大人发给你的是一个链接：长按它选「拷贝」，粘贴到下面，点「用这个链接连接」。</li>
          <li>放到主屏幕以后，如果主屏幕上的错题本还要你连接，请大人再给一个新链接，粘贴到这里。</li>
        </ol>
        {props.error ? <Problem title="这个二维码用不了" detail="请帮你装错题本的人重新生成一个，再扫一次。" reason={props.error} /> : null}
        <form method="post" action="/s/pair" id="connect-form">
          <label htmlFor="connect-link" className="small muted">配对链接</label>
          <input id="connect-link" type="text" name="link" inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="https://…/s/pair?code=…" />
        </form>
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
        <p>点下面的「连接这台手机」，这台手机就能用错题本了。</p>
        {props.inAppBrowser
          ? <p className="tone-orange" data-testid="in-app-warning"><b>现在是在聊天软件里打开的。</b>请点右上角「…」，选「在 Safari 中打开」，再点连接——连在这里，以后从 Safari 和主屏幕都打不开。</p>
          : <p className="muted small">连好以后，按提示把错题本放到主屏幕上。</p>}
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
      <section className="card">
        <p>放到主屏幕以后，错题本会像 App 一样全屏打开，不用每次找网址。</p>
        <ol>
          <li>用 <b>Safari</b> 打开错题本（微信里打开的先点右上角「…」→「在 Safari 中打开」）。</li>
          <li>点屏幕下方的「分享」按钮（方框里一个向上的箭头）。</li>
          <li>往下找「添加到主屏幕」，点它，再点右上角「添加」。</li>
          <li>以后从主屏幕上的「错题本」图标打开。</li>
        </ol>
        <p className="muted small">如果主屏幕上的错题本打开后让你重新连接，请大人再给一个新链接，粘贴进去就好。</p>
      </section>
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

export function BusyPage(props: { retryAfterSeconds: number }): ReactNode {
  const bar: BarModel = { caption: `大约 ${Math.max(1, Math.ceil(props.retryAfterSeconds / 60))} 分钟后再试`, primary: { title: '过一会儿再试', key: 'retry', href: '/s/' }, secondary: [] };
  return (
    <Page title="服务器有点忙" back={null} bar={bar}>
      <h1>服务器有点忙</h1>
      <section className="card"><p>服务器有点忙，过一会儿再试。照片和错题都在，不会丢。</p></section>
    </Page>
  );
}

export function ErrorPage(props: { title: string; detail: string; reason?: string | null }): ReactNode {
  const bar: BarModel = { caption: '', primary: { title: '回到今天', key: 'goHome', href: '/s/' }, secondary: [] };
  return (
    <Page title={props.title} bar={bar}>
      <h1>没成功</h1>
      <Problem title={props.title} detail={props.detail} reason={props.reason} />
    </Page>
  );
}
