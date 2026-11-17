import type { ReactNode } from 'react';
import { actionHref } from '../state.js';
import { actionKey, type Choice, type ConnectReason, type NextStepModel } from '../weekPlan.js';
import { Page, Phrased, Problem, quoted, type BarButton, type BarModel } from './layout.js';

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

/** invitation：邀请码登录的学生；旧的单人配对版仍按配对链接说明。 */
export function InstallPage(props: { invitation?: boolean } = {}): ReactNode {
  const bar: BarModel = { caption: '', primary: { title: '回到错题本', key: 'goHome', href: '/s/' }, secondary: [] };
  return (
    <Page title="放到主屏幕" bar={bar}>
      <h1>放到主屏幕</h1>
      <p className="lead">放到主屏幕以后，错题本一点就开，不用每次找网址。要在浏览器里做：微信里打开的，先点右上角「…」→「在浏览器打开」（iPhone 上叫「在 Safari 中打开」）。</p>
      <section className="card" data-testid="install-ios">
        <h2 className="card-title">iPhone · Safari，四步</h2>
        <ol className="steps-text">
          <li>用 <b>Safari</b> 打开错题本。</li>
          <li>点屏幕下方的「分享」按钮（方框里一个向上的箭头）。</li>
          <li>往下找「添加到主屏幕」，点它，再点右上角「添加」。</li>
          <li>以后从主屏幕上的「错题本」图标打开。</li>
        </ol>
      </section>
      <section className="card" data-testid="install-android">
        <h2 className="card-title">安卓 · Chrome，三步</h2>
        <ol className="steps-text">
          <li>用 <b>Chrome</b>（或手机自带的浏览器）打开错题本。</li>
          <li>点右上角「⋮」，选「添加到主屏幕」（有的叫「安装应用」或「添加到桌面」），再点「添加」。</li>
          <li>以后从桌面图标打开。安卓上它打开的还是浏览器页面——这样拍照和相册才能正常用。</li>
        </ol>
      </section>
      <p className="hint">{props.invitation
        ? '如果从主屏幕打开后要你登录，重新输入自己的邀请码就好（或者再扫一次老师给的二维码），学习记录都还在。'
        : '如果主屏幕上的错题本打开后让你重新连接，请大人再给一个新链接，粘贴进去就好。'}</p>
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
        <p data-offline-detail="">检查一下 Wi-Fi 或流量。传上去的照片和错题都在服务器上，不会丢；还没传完的照片先存在这台手机上，连上网回到拍照页会接着传。</p>
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
  const bar: BarModel = { caption: '', primary: { title: '回到错题本', key: 'goHome', href: '/s/' }, secondary: [] };
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
