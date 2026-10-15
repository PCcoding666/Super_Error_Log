/** 学生邀请码网关自己的两个页面：登录页与网关错误页（不含任何学生数据，由父进程直接渲染）。 */
import type { ReactNode } from 'react';
import { Page, Problem } from '../web/views/layout.js';

/**
 * 登录页（§学生体验）：输入 12 位专属邀请码。错误提示统一一句话——不暴露学生是否存在、码是过期还是已用。
 * 粘贴分组（XXXX-XXXX-XXXX）、空格、大小写都接受。
 */
export function LoginPage(props: { error?: string | null; retryAfterSeconds?: number }): ReactNode {
  return (
    <Page
      title="输入邀请码"
      back={null}
      showSettings={false}
      bar={{ caption: '邀请码问帮你装错题本的人要', primary: { title: '进入我的错题本', key: 'login', form: 'login-form' }, secondary: [] }}
    >
      <h1 data-testid="login-title">输入邀请码</h1>
      <p className="lead">每个学生有自己的邀请码。输入以后，这台手机看到的就是你自己的错题本。</p>
      {props.retryAfterSeconds ? (
        <Problem title="试得太频繁了" detail={`等 ${Math.ceil(props.retryAfterSeconds / 60)} 分钟左右再试。`} />
      ) : props.error ? (
        <Problem title="这个邀请码进不去" detail="检查一下有没有输错；还是进不去的话，让帮你装错题本的人给一个新码。" reason={props.error} />
      ) : null}
      <section className="card" data-testid="login-card">
        <form method="post" action="/s/login" id="login-form">
          <label htmlFor="invite-code" className="field-label">12 位邀请码</label>
          <input
            id="invite-code"
            type="text"
            name="code"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={20}
            placeholder="XXXX-XXXX-XXXX"
            data-testid="invite-code-input"
          />
        </form>
        <p className="hint">短横线和空格不用管，大小写都可以。换手机或清理过浏览器：让大人补一个新码，学习记录都在。</p>
      </section>
    </Page>
  );
}

/** 网关侧错误页（worker 启动失败 / 转发中断）：说清楚东西还在，不暴露内部细节。 */
export function HostErrorPage(props: { title: string; detail: string }): ReactNode {
  return (
    <Page title={props.title} back={null} showSettings={false} bar={{ caption: '', primary: { title: '再试一次', key: 'retry', href: '/s/' }, secondary: [] }}>
      <h1>{props.title}</h1>
      <section className="card">
        <p>{props.detail}</p>
        <p className="muted small">照片、错题和练习都存在服务器上，不会丢。</p>
      </section>
    </Page>
  );
}
