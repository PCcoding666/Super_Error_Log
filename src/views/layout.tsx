import type { ReactNode } from 'react';
import type { ItemStatus, Role } from '../domain/types.js';
import { STATUS_LABEL } from '../domain/types.js';

export function Layout(props: {
  title: string;
  role: Role;
  children: ReactNode;
  flash?: { ok?: string; err?: string };
  /** 处理中页面每隔 N 秒自动整页刷新（SSR 无 hydration 的进度刷新机制；仅在确有后台进度时传）。 */
  refreshSeconds?: number;
}): ReactNode {
  const { title, role, children, flash } = props;
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${title} · Super Error Log`}</title>
        {props.refreshSeconds ? <meta httpEquiv="refresh" content={String(props.refreshSeconds)} /> : null}
        <link rel="stylesheet" href="/public/styles.css" />
        <script src="/public/app.js" defer></script>
      </head>
      <body>
        <header className="topbar">
          <a className="brand" href={role === 'parent' ? '/parent' : '/'}>
            错题复习闭环
          </a>
          <nav aria-label="主导航">
            {role === 'student' ? (
              <>
                <a href="/">首页</a>
                <a href="/items">错题</a>
                <a href="/plan">复习计划</a>
                <a href="/trends">趋势</a>
                <a href="/settings">设置</a>
                <a className="role-switch" href="/role/parent">
                  家长视图
                </a>
              </>
            ) : (
              <a className="role-switch" href="/role/student">
                返回学生视图
              </a>
            )}
          </nav>
        </header>
        <main className="container">
          {flash?.ok ? <div className="flash ok" role="status">{flash.ok}</div> : null}
          {flash?.err ? <div className="flash err" role="alert">{flash.err}</div> : null}
          {children}
        </main>
      </body>
    </html>
  );
}

export function StatusBadge(props: { status: ItemStatus }): ReactNode {
  return <span className={`badge st-${props.status}`}>{STATUS_LABEL[props.status]}</span>;
}

export function ConfidenceBadge(props: { confidence: number }): ReactNode {
  const pct = Math.round(props.confidence * 100);
  const low = props.confidence < 0.8;
  return (
    <span className={`badge ${low ? 'conf-low' : 'conf-ok'}`} title="AI 识别置信度">
      置信度 {pct}%{low ? ' · 需人工确认' : ''}
    </span>
  );
}

export function EmptyState(props: { title: string; hint: string; actionHref?: string; actionText?: string }): ReactNode {
  return (
    <div className="empty">
      <p className="empty-title">{props.title}</p>
      <p>{props.hint}</p>
      {props.actionHref ? (
        <a className="btn primary" href={props.actionHref}>
          {props.actionText ?? '去处理'}
        </a>
      ) : null}
    </div>
  );
}
