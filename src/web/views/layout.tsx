import type { ReactNode } from 'react';
import { APP_NAME, APP_SHORT_NAME, ASSET_VERSION, THEME_COLOR, THEME_COLOR_DARK } from '../assets.js';

/** 底部下一步按钮里的一个按钮：链接、表单提交、页面里表单的提交按钮、拍照的 label、或不可点。 */
export type BarButton = { title: string; key: string } & (
  | { href: string; print?: boolean }
  | { post: string; fields?: Record<string, string>; wait?: string }
  | { form: string; name?: string; value?: string; disabled?: boolean; countTemplate?: string; emptyTitle?: string }
  | { labelFor: string }
  | { disabled: true; waiting?: boolean }
);

export interface BarModel {
  caption: string;
  /** 打印后换成的说明（只在打印页用）。 */
  captionAfterPrint?: string;
  primary: BarButton | null;
  secondary: BarButton[];
}

/** look：primary = 实心主按钮；outline = 描边按钮（没有主按钮时的次要操作）；alt = 文字按钮（主按钮上方的一行次要操作）。 */
export function ButtonView(props: { button: BarButton; primary: boolean; look?: 'primary' | 'outline' | 'alt' }): ReactNode {
  const { button, primary } = props;
  const look = props.look ?? (primary ? 'primary' : 'outline');
  const testId = primary ? 'next-step-primary' : `next-step-secondary-${button.key}`;
  const cls = `btn${look === 'primary' ? ' primary' : look === 'alt' ? ' alt' : ''}`;
  if ('href' in button) {
    return <a className={cls} href={button.href} data-testid={testId} data-key={button.key} data-print={button.print ? '' : undefined}>{button.title}</a>;
  }
  if ('post' in button) {
    const formId = `bar-${button.key}`;
    return (
      <form method="post" action={button.post} id={formId} data-wait={button.wait}>
        {Object.entries(button.fields ?? {}).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
        <button className={cls} type="submit" data-testid={testId} data-key={button.key}>{button.title}</button>
      </form>
    );
  }
  if ('form' in button) {
    return (
      <button className={`${cls}${button.disabled ? ' disabled' : ''}`} type="submit" form={button.form} name={button.name} value={button.value} data-testid={testId} data-key={button.key}
        disabled={button.disabled} data-main="" data-count-label={button.countTemplate ? '' : undefined} data-template={button.countTemplate} data-empty={button.emptyTitle}>
        {button.title}
      </button>
    );
  }
  if ('labelFor' in button) {
    // 拍照 / 从相册选：label 直接打开系统相机或相册（不靠脚本）。键盘焦点落在被它指向的文件输入上，焦点环画在这个 label 上（见样式）。
    return <label className={cls} htmlFor={button.labelFor} data-testid={testId} data-key={button.key}>{button.title}</label>;
  }
  return <button className={`${cls}${button.waiting ? ' waiting' : ''}`} type="button" disabled data-testid={testId} data-key={button.key}>{button.title}</button>;
}

/**
 * 底部固定的下一步按钮（设计稿 §4.0）。从上到下：说明小字（第几步、大约几分钟）→ 次要操作（一行文字按钮）→ 主按钮。
 * 主按钮永远在最下面、整行宽，每一屏同一个位置；次要操作不和它抢（不是同样的实心大按钮），文字一行放得下。
 * 没有主按钮的状态（做完了、周中、随时可以看）：次要操作是整行的描边按钮，竖着排。
 */
export function NextBar(props: { model: BarModel; extra?: ReactNode }): ReactNode {
  const { model } = props;
  const hasPrimary = model.primary !== null;
  return (
    <nav className="next-bar" data-testid="next-step-bar" aria-label="下一步" data-live="bar">
      <div className="inner">
        {model.caption || model.captionAfterPrint ? (
          <p className="caption" data-testid="next-step-caption" data-after={model.captionAfterPrint}>{model.caption}</p>
        ) : null}
        {hasPrimary && model.secondary.length > 0 ? (
          <div className="bar-alt">{model.secondary.map(button => <ButtonView key={button.key} button={button} primary={false} look="alt" />)}</div>
        ) : null}
        {props.extra}
        {hasPrimary ? (
          <div className="bar-main"><ButtonView button={model.primary!} primary /></div>
        ) : (
          <div className="bar-stack">{model.secondary.map(button => <ButtonView key={button.key} button={button} primary={false} look="outline" />)}</div>
        )}
      </div>
    </nav>
  );
}

export interface PageProps {
  title: string;
  /** 顶部左边的返回：缺省回到「今天」；首页传 null。label 只写去哪（「今天」），箭头由外壳画。 */
  back?: { href: string; label: string } | null;
  showSettings?: boolean;
  bar?: BarModel | null;
  barExtra?: ReactNode;
  /** 等 AI 的页面：开着脚本时每隔几秒取一次这一页，只换掉标了 data-live 的区域（状态、底栏）；关掉脚本时退回 meta refresh。 */
  pollSeconds?: number;
  flash?: { ok?: string | null; err?: string | null };
  bodyClass?: string;
  children: ReactNode;
}

/** 学生网页版的页面外壳：PWA 头信息、顶部返回、内容、底部下一步按钮。没有任何第三方资源。 */
export function Page(props: PageProps): ReactNode {
  const back = props.back === undefined ? { href: '/s/', label: '今天' } : props.back;
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>{`${props.title} · ${APP_NAME}`}</title>
        <meta name="referrer" content="no-referrer" />
        <meta name="format-detection" content="telephone=no" />
        <meta name="theme-color" content={THEME_COLOR} media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content={THEME_COLOR_DARK} media="(prefers-color-scheme: dark)" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content={APP_SHORT_NAME} />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <link rel="manifest" href="/s/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/s/assets/apple-touch-icon.png" />
        <link rel="icon" type="image/png" href="/s/assets/icon-192.png" />
        {/* 等 AI 的页面：开着脚本时由脚本按 data-poll 局部更新（看不见、正在输入时不换）；关掉脚本时退回 meta refresh。 */}
        {props.pollSeconds ? <noscript><meta httpEquiv="refresh" content={String(props.pollSeconds)} /></noscript> : null}
        <link rel="stylesheet" href={`/s/assets/app.css?v=${ASSET_VERSION}`} />
        <script src={`/s/assets/app.js?v=${ASSET_VERSION}`}></script>
      </head>
      <body className={props.bodyClass} data-poll={props.pollSeconds ? String(props.pollSeconds) : undefined}>
        <header className="top">
          {back ? <a href={back.href} data-testid="back-link" data-key="back"><span className="chev-left" aria-hidden="true">‹</span>{back.label}</a> : <span />}
          {props.showSettings === false ? <span /> : <a href="/s/settings" data-testid="settings-link" data-key="settings">设置</a>}
        </header>
        <main>
          {props.flash?.ok ? <div className="flash" role="status" data-testid="flash-ok">{props.flash.ok}</div> : null}
          {props.flash?.err ? <div className="flash err" role="alert" data-testid="flash-err">{props.flash.err}</div> : null}
          {props.children}
          {/* 局部更新换上来的状态由这一行读给读屏软件（换掉的区域本身是新节点，读屏不一定会念） */}
          {props.pollSeconds ? <p className="visually-hidden" aria-live="polite" data-announcer="" /> : null}
        </main>
        {props.bar ? <NextBar model={props.bar} extra={props.barExtra} /> : null}
      </body>
    </html>
  );
}

/** 错误句式（§4.0）：先说发生了什么，再说东西还在不在；服务器原文放进「具体原因」折叠行。 */
export function Problem(props: { title: string; detail?: string; reason?: string | null }): ReactNode {
  return (
    <div className="card" role="alert" data-testid="problem">
      <p><b>{props.title}</b></p>
      {props.detail ? <p className="muted">{props.detail}</p> : null}
      {props.reason ? <details><summary data-key="problem-reason">具体原因</summary><p className="muted small">{props.reason}</p></details> : null}
    </div>
  );
}

/** 等了多久：「已经等了 40 秒」「已经等了 1 分 5 秒」（页面脚本每秒按同一个写法更新）。 */
export function elapsedText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return s < 60 ? `已经等了 ${s} 秒` : `已经等了 ${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/**
 * 等 AI 时的一行：等了多久（data-elapsed = 服务器出这一页时已经等了几秒，脚本接着往上数）+ 大概还要多久。
 * 网络断了的时候脚本在后面补一句（data-wait-net）。
 */
export function WaitLine(props: { since: string | null; now: Date; expect: string }): ReactNode {
  const seconds = props.since ? Math.max(0, Math.floor((props.now.getTime() - Date.parse(props.since)) / 1000)) : null;
  return (
    <p className="wait-line small" data-testid="wait-line">
      {seconds !== null && Number.isFinite(seconds) ? <><span data-elapsed={String(seconds)}>{elapsedText(seconds)}</span>{' · '}</> : null}
      <span>{props.expect}</span>
      <span className="wait-net hidden" data-wait-net="">{' · 网络断了，连上后接着等'}</span>
    </p>
  );
}

/**
 * 「点一下开始说」（说说为什么错的回答、改一下的说明共用）：开着麦克风时有音量条和计时，按钮变成「说完了」；
 * 转写时说已经转了几秒；转写失败时刚才那段录音留在页面里，可以「再转一次」，也可以直接打字。没有麦克风时整块不出现。
 */
export function VoiceBox(props: { target: string; testIds?: boolean }): ReactNode {
  const t = (id: string): string | undefined => (props.testIds ? id : undefined);
  return (
    <div className="voice hidden" data-voice-for={props.target} data-endpoint="/s/voice" data-testid={t('voice')}>
      <button type="button" data-voice-btn="" data-testid={t('voice-button')} data-key={props.testIds ? undefined : 'voice'}>点一下开始说</button>
      <button type="button" className="voice-retry hidden" data-voice-retry="" data-key="voice-retry" data-testid={t('voice-retry')}>再转一次</button>
      <span className="voice-live hidden" data-voice-live="" data-testid={t('voice-live')}>
        <span className="meter" data-voice-meter="" data-level="0" data-testid={t('voice-meter')} aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></span>
        <span className="voice-time" data-voice-time="" data-testid={t('voice-timer')} role="timer" aria-label="录了多久">0:00</span>
        <span className="heard small" data-voice-heard="" aria-hidden="true" />
        <span className="small muted">最多 60 秒</span>
      </span>
      <span className="small muted voice-note" data-voice-note="" data-testid={t('voice-note')} aria-live="polite" />
    </div>
  );
}

/** 「」里的短引语（≤ 12 个字，按钮名、菜单名）保持在同一行，不被拆成「「相 / 机」」。其余文字原样。 */
export function quoted(text: string): ReactNode {
  const parts = text.split(/(「[^「」]{1,12}」)/u);
  if (parts.length < 2) return text;
  return <>{parts.map((part, index) => (index % 2 === 1 ? <span key={index} className="q">{part}</span> : part))}</>;
}

/**
 * 中文短句的断行：在标点（，；。：、！？）后面分成不可拆的小段（inline-block），换行只落在小段之间，
 * 不会把一个词拆到两行（例如「没 / 批改」「正 / 好」）。小段比一行还长时照常在段内换行。
 * 只用于一两行的短句（清单说明行、照片状态行、小字提示）；长段落照常按字换行（中文排版的惯例）。文字内容不变。
 */
export function Phrased(props: { text: string }): ReactNode {
  const pieces = props.text.split(/(?<=[，；。：、！？])(?=\S)/u);
  if (pieces.length < 2) return quoted(props.text);
  return <>{pieces.map((piece, index) => <span key={index} className="ph">{quoted(piece)}</span>)}</>;
}
