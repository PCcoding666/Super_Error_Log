import type { ReactNode } from 'react';
import { APP_NAME, APP_SHORT_NAME, CSS_PATH, JS_PATH, THEME_COLOR, THEME_COLOR_DARK } from '../assets.js';
import { phrasePieces } from '../phrases.js';

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

/** look：primary = 实心主按钮；outline = 低强调按钮（保留既有参数名）；alt = 主按钮上方的文字操作。 */
export function ButtonView(props: { button: BarButton; primary: boolean; look?: 'primary' | 'outline' | 'alt' }): ReactNode {
  const { button, primary } = props;
  const look = props.look ?? (primary ? 'primary' : 'outline');
  const testId = primary ? 'next-step-primary' : `next-step-secondary-${button.key}`;
  const cls = `btn${look === 'primary' ? ' primary' : look === 'alt' ? ' alt' : ''}`;
  if ('href' in button) {
    return <a className={cls} href={button.href} aria-label={button.title} data-testid={testId} data-key={button.key} data-print={button.print ? '' : undefined}><Phrased text={button.title} /></a>;
  }
  if ('post' in button) {
    const formId = `bar-${button.key}`;
    return (
      <form method="post" action={button.post} id={formId} data-wait={button.wait}>
        {Object.entries(button.fields ?? {}).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
        <button className={cls} type="submit" aria-label={button.title} data-testid={testId} data-key={button.key}><Phrased text={button.title} /></button>
      </form>
    );
  }
  if ('form' in button) {
    return (
      <button className={`${cls}${button.disabled ? ' disabled' : ''}`} type="submit" form={button.form} name={button.name} value={button.value} aria-label={button.title} data-testid={testId} data-key={button.key}
        disabled={button.disabled} data-main="" data-count-label={button.countTemplate ? '' : undefined} data-template={button.countTemplate} data-empty={button.emptyTitle}>
        <Phrased text={button.title} />
      </button>
    );
  }
  if ('labelFor' in button) {
    // 拍照 / 从相册选：label 直接打开系统相机或相册（不靠脚本）。键盘焦点落在被它指向的文件输入上，焦点环画在这个 label 上（见样式）。
    return <label className={cls} htmlFor={button.labelFor} aria-label={button.title} data-testid={testId} data-key={button.key}><Phrased text={button.title} /></label>;
  }
  return <button className={`${cls}${button.waiting ? ' waiting' : ''}`} type="button" disabled aria-label={button.title} data-testid={testId} data-key={button.key}><Phrased text={button.title} /></button>;
}

/** 当前任务操作。任务页固定在底部；根页面内联到任务内容，避免与全局导航竞争。 */
export function NextBar(props: { model: BarModel; extra?: ReactNode; inline?: boolean }): ReactNode {
  const { model } = props;
  const hasPrimary = model.primary !== null;
  return (
    <nav className={`next-bar${props.inline ? ' next-bar-inline' : ''}`} data-testid="next-step-bar" aria-label="下一步" data-live={props.inline ? undefined : "bar"}>
      <div className="inner">
        {model.caption || model.captionAfterPrint ? (
          <p className="caption bar-caption" data-testid="next-step-caption" data-after={model.captionAfterPrint}>{model.caption}</p>
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
  /** 三个常驻内容入口；任务页保留返回和当前任务操作。 */
  tab?: 'today' | 'items' | 'practices';
  /** 顶部左边的返回：缺省回到「今天」；首页传 null。label 只写去哪（「今天」），箭头由外壳画。 */
  back?: { href: string; label: string } | null;
  showSettings?: boolean;
  bar?: BarModel | null;
  barExtra?: ReactNode;
  /** 自己写的底栏（练习纸单独页：开着 / 关掉脚本时主按钮不同），代替 bar。 */
  after?: ReactNode;
  /** 等 AI 的页面：开着脚本时每隔几秒取一次这一页，只换掉标了 data-live 的区域（状态、底栏）；关掉脚本时退回 meta refresh。 */
  pollSeconds?: number;
  flash?: { ok?: string | null; err?: string | null };
  bodyClass?: string;
  children: ReactNode;
}

/** 学生网页版的页面外壳：PWA 头信息、顶部返回、内容、底部下一步按钮。没有任何第三方资源。 */
export function Page(props: PageProps): ReactNode {
  const back = props.tab ? null : props.back === undefined ? { href: '/s/', label: '今天' } : props.back;
  const bodyClass = [props.bodyClass, props.tab ? 'has-tabbar' : ''].filter(Boolean).join(' ') || undefined;
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>{`${props.title} · ${APP_NAME}`}</title>
        {/* Same-origin forms need a non-null Origin for the invitation gateway's CSRF check.
            Cross-origin destinations still receive no Referer under this policy. */}
        <meta name="referrer" content="same-origin" />
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
        <link rel="stylesheet" href={CSS_PATH} />
        {/* defer：不挡首屏；只在有 / 没有脚本时出现的东西由样式的 scripting 媒体特性决定，不等脚本 */}
        <script src={JS_PATH} defer></script>
      </head>
      <body className={bodyClass} data-poll={props.pollSeconds ? String(props.pollSeconds) : undefined}>
        <header className={`top${back ? '' : ' top-root'}`}>
          {back ? <a href={back.href} data-testid="back-link" data-key="back"><svg className="nav-icon chev-left" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m14 5-7 7 7 7" /></svg>{back.label}</a> : null}
          {props.showSettings === false ? <span /> : <a href="/s/settings" data-testid="settings-link" data-key="settings"><svg className="nav-icon settings-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 3-.7 2.4-2 .9-2.2-.6-2 3.4 1.6 1.8v2.2l-1.6 1.8 2 3.4 2.2-.6 2 .9L9 21h4l.7-2.4 2-.9 2.2.6 2-3.4-1.6-1.8v-2.2l1.6-1.8-2-3.4-2.2.6-2-.9L13 3Z" /><circle cx="11" cy="12" r="3" /></svg>设置</a>}
        </header>
        <main>
          {props.flash?.ok ? <div className="flash" role="status" data-testid="flash-ok">{props.flash.ok}</div> : null}
          {props.flash?.err ? <div className="flash err" role="alert" data-testid="flash-err">{props.flash.err}</div> : null}
          {props.children}
          {props.tab && props.bar ? <NextBar model={props.bar} extra={props.barExtra} inline /> : null}
          {!props.tab && props.bar ? <p className="caption-flow small muted" data-caption-flow="" data-live="caption" data-after={props.bar.captionAfterPrint}>{props.bar.caption}</p> : null}
          {props.pollSeconds ? <p className="visually-hidden" aria-live="polite" data-announcer="" /> : null}
        </main>
        {!props.tab && props.bar ? <NextBar model={props.bar} extra={props.barExtra} /> : props.after ?? null}
        {props.tab ? <TabBar selected={props.tab} /> : null}
      </body>
    </html>
  );
}

/** 原创矢量图标；链接采用真实地址，浏览器返回和无脚本访问都保持可用。 */
function TabBar(props: { selected: NonNullable<PageProps['tab']> }): ReactNode {
  const tabs = [
    { key: 'today' as const, href: '/s/', label: '今天', path: 'M7 3v3m10-3v3M4 10h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1Zm3 10 3 3 5-5' },
    { key: 'items' as const, href: '/s/items', label: '错题', path: 'M5 3h13a1 1 0 0 1 1 1v17H6a2 2 0 0 1-2-2V5a2 2 0 0 1 1-2Zm-1 14h15M8 7h7M8 11h5' },
    { key: 'practices' as const, href: '/s/practices', label: '练习', path: 'M7 4h11a1 1 0 0 1 1 1v16H6V5a1 1 0 0 1 1-1Zm2-1h7v4H9Zm0 9 2 2 4-4m-6 7h6' },
  ];
  return <nav className="tab-bar" aria-label="主要导航" data-testid="root-tabs">
    {tabs.map(tab => <a key={tab.key} href={tab.href} aria-current={props.selected === tab.key ? 'page' : undefined} data-testid={`tab-${tab.key}`} data-key={`tab-${tab.key}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={tab.path} /></svg><span>{tab.label}</span>
    </a>)}
  </nav>;
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
      {seconds !== null && Number.isFinite(seconds) ? <><span className="ph" data-elapsed={String(seconds)}>{elapsedText(seconds)}</span>{' · '}</> : null}
      <Phrased text={props.expect} />
      <span className="wait-net hidden" data-wait-net="">{' · 暂时没拿到最新进度，正在重试'}</span>
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
      <button type="button" className="voice-cancel hidden" data-voice-cancel="" data-key="voice-cancel" data-testid={t('voice-cancel')}>取消，改用打字</button>
      <span className="small muted voice-wait" data-voice-wait="" data-testid={t('voice-wait')} />
      <span className="small muted" data-testid={t('voice-privacy')}>录音会发给通义千问转文字，本应用不保存录音；最多 60 秒，也可以直接打字</span>
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
 * 中文短句的断行：分成不可拆的小段（inline-block），换行只落在小段之间，不会把一个词拆到两行（「没 / 批改」），
 * 也不会剩一个字单独一行（「第 1 / 道印出来是这 / 样」）、标点落到行首。小段比一行还长时照常在段内换行（样式里 line-break: strict）。
 * - 18 个字以内的短句（标题、按钮、清单行、说明行）：按词组分段（phrasePieces，ICU 分词，见 phrases.ts）；
 * - 更长的句子：在标点（，；。：、！？）后面分段（长段落照常按字换行，中文排版的惯例）；
 * - 4 个字以内：原样（一行总放得下）。
 * max：词组的最大字数（节奏条那种很窄的格子用 2）。suffix：贴在最后一段里的尾巴（例如链接后面的「›」，不单独换到下一行）。文字内容不变。
 */
export function Phrased(props: { text: string; max?: number; prefix?: ReactNode; suffix?: ReactNode }): ReactNode {
  const count = (props.text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (count <= 4 && !props.suffix && !props.prefix && props.max === undefined) return quoted(props.text);
  const pieces = count <= 18 ? phrasePieces(props.text, props.max ?? 4) : props.text.split(/(?<=[，；。：、！？])(?=\S)/u);
  const last = pieces.length - 1;
  return (
    <span className="phr">
      {pieces.map((piece, index) => (piece.trim() === ''
        ? piece
        : <span key={index} className="ph">{index === 0 ? props.prefix : null}{quoted(piece)}{index === last ? props.suffix : null}</span>))}
    </span>
  );
}
