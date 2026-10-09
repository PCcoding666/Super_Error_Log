import type { ReactNode } from 'react';
import { APP_NAME, APP_SHORT_NAME, ASSET_VERSION, THEME_COLOR } from '../assets.js';

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

function ButtonView(props: { button: BarButton; primary: boolean }): ReactNode {
  const { button, primary } = props;
  const testId = primary ? 'next-step-primary' : `next-step-secondary-${button.key}`;
  const cls = `btn${primary ? ' primary' : ''}`;
  if ('href' in button) {
    return <a className={cls} href={button.href} data-testid={testId} data-print={button.print ? '' : undefined}>{button.title}</a>;
  }
  if ('post' in button) {
    const formId = `bar-${button.key}`;
    return (
      <form method="post" action={button.post} id={formId} data-wait={button.wait}>
        {Object.entries(button.fields ?? {}).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
        <button className={cls} type="submit" data-testid={testId}>{button.title}</button>
      </form>
    );
  }
  if ('form' in button) {
    return (
      <button className={`${cls}${button.disabled ? ' disabled' : ''}`} type="submit" form={button.form} name={button.name} value={button.value} data-testid={testId}
        disabled={button.disabled} data-main="" data-count-label={button.countTemplate ? '' : undefined} data-template={button.countTemplate} data-empty={button.emptyTitle}>
        {button.title}
      </button>
    );
  }
  if ('labelFor' in button) {
    return <label className={cls} htmlFor={button.labelFor} data-testid={testId} role="button" tabIndex={0}>{button.title}</label>;
  }
  return <button className={`${cls}${button.waiting ? ' waiting' : ''}`} type="button" disabled data-testid={testId}>{button.title}</button>;
}

/** 底部固定的下一步按钮（设计稿 §4.0）：上面一行小字，下面主按钮，旁边可有次要按钮。 */
export function NextBar(props: { model: BarModel; extra?: ReactNode }): ReactNode {
  const { model } = props;
  const stack = model.primary === null || model.secondary.length > 1;
  return (
    <nav className="next-bar" data-testid="next-step-bar" aria-label="下一步">
      <div className="inner">
        {model.caption || model.captionAfterPrint ? (
          <p className="caption" data-testid="next-step-caption" data-after={model.captionAfterPrint}>{model.caption}</p>
        ) : null}
        {props.extra}
        <div className={`buttons${stack ? ' stack' : ''}`}>
          {model.secondary.map(button => <ButtonView key={button.key} button={button} primary={false} />)}
          {model.primary ? <ButtonView button={model.primary} primary /> : null}
        </div>
      </div>
    </nav>
  );
}

export interface PageProps {
  title: string;
  /** 顶部左边的返回：缺省回到「今天」；首页传 null。 */
  back?: { href: string; label: string } | null;
  showSettings?: boolean;
  bar?: BarModel | null;
  barExtra?: ReactNode;
  refreshSeconds?: number;
  flash?: { ok?: string | null; err?: string | null };
  bodyClass?: string;
  children: ReactNode;
}

/** 学生网页版的页面外壳：PWA 头信息、顶部返回、内容、底部下一步按钮。没有任何第三方资源。 */
export function Page(props: PageProps): ReactNode {
  const back = props.back === undefined ? { href: '/s/', label: '‹ 今天' } : props.back;
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>{`${props.title} · ${APP_NAME}`}</title>
        <meta name="referrer" content="no-referrer" />
        <meta name="format-detection" content="telephone=no" />
        <meta name="theme-color" content={THEME_COLOR} />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content={APP_SHORT_NAME} />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <link rel="manifest" href="/s/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/s/assets/apple-touch-icon.png" />
        <link rel="icon" type="image/png" href="/s/assets/icon-192.png" />
        {props.refreshSeconds ? <meta httpEquiv="refresh" content={String(props.refreshSeconds)} /> : null}
        <link rel="stylesheet" href={`/s/assets/app.css?v=${ASSET_VERSION}`} />
        <script src={`/s/assets/app.js?v=${ASSET_VERSION}`}></script>
      </head>
      <body className={props.bodyClass}>
        <header className="top">
          {back ? <a href={back.href} data-testid="back-link">{back.label}</a> : <span />}
          {props.showSettings === false ? <span /> : <a href="/s/settings" data-testid="settings-link">设置</a>}
        </header>
        <main>
          {props.flash?.ok ? <div className="flash" role="status" data-testid="flash-ok">{props.flash.ok}</div> : null}
          {props.flash?.err ? <div className="flash err" role="alert" data-testid="flash-err">{props.flash.err}</div> : null}
          {props.children}
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
      {props.reason ? <details><summary>具体原因</summary><p className="muted small">{props.reason}</p></details> : null}
    </div>
  );
}
