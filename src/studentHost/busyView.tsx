/** 「人有点多」503 页：说清楚为什么进不去、大概要等多久，并自己定时重试（不需要脚本）。 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Page } from '../web/views/layout.js';
import { CAPACITY_RETRY_SECONDS, capacityLines, type CapacityFacts } from './busy.js';

export { CAPACITY_RETRY_SECONDS, CapacityWaitlist, capacityLines } from './busy.js';

function CapacityPage(props: CapacityFacts & { retryHref: string }): ReactNode {
  return (
    <Page title="人有点多" back={null} showSettings={false} bar={{ caption: `每 ${CAPACITY_RETRY_SECONDS} 秒自动重试一次`, primary: { title: '现在重试', key: 'retry', href: props.retryHref }, secondary: [] }}>
      <h1>人有点多</h1>
      <section className="card" data-testid="capacity-facts">
        {capacityLines(props).map(line => <p key={line}>{line}</p>)}
      </section>
      <section className="card">
        <p data-testid="capacity-retry">这一页每 {CAPACITY_RETRY_SECONDS} 秒会自己重试，进得去就直接打开，不用一直点刷新。可以先把手机放一边。</p>
        <p className="muted small">已经传上去的照片、错题和练习都存在服务器上，不会丢；还没传完的照片先存在这台手机上，进去后回到拍照页会接着传。</p>
      </section>
    </Page>
  );
}

/** 整页 HTML；meta refresh 不受 CSP 的 script-src 限制，也不依赖 Service Worker。 */
export function capacityPageHtml(facts: CapacityFacts, retryHref: string): string {
  const html = renderToStaticMarkup(<CapacityPage {...facts} retryHref={retryHref} />)
    .replace('</head>', `<meta http-equiv="refresh" content="${CAPACITY_RETRY_SECONDS}"/></head>`);
  return `<!doctype html>${html}`;
}
