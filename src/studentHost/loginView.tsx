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
      bar={{ caption: '首次使用可先注册，已有邀请码直接登录', primary: { title: '进入我的错题本', key: 'login', form: 'login-form' }, secondary: [] }}
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
        <p className="hint">短横线和空格不用管，大小写都可以。新生成的邀请码 60 天内可重复登录，请妥善保存，不要分享给别人。</p>
      </section>
      <p><a href="/s/register" className="btn">首次使用，注册账号</a></p>
      <p className="hint">忘记或过期了？联系老师或管理员，核验注册时的姓名和手机号后补发，学习记录保留。</p>
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


/** 注册只收集姓名和手机号；号码归属尚未验证，不作为自动找回的凭据。 */
export function RegistrationPage(props: { error?: string; retryAfterSeconds?: number }): ReactNode {
  return (
    <Page title="注册账号" back={{ href: '/s/', label: '邀请码登录' }} showSettings={false}
      bar={{ caption: '注册后请保存你的专属邀请码', primary: { title: '注册并生成邀请码', key: 'register', form: 'register-form' }, secondary: [] }}>
      <h1>注册账号</h1>
      <p className="lead">填写姓名和手机号，创建自己的错题本。以后只需输入邀请码登录。</p>
      {props.retryAfterSeconds
        ? <Problem title="提交太频繁了" detail={'请约 ' + Math.ceil(props.retryAfterSeconds / 60) + ' 分钟后再试。'} />
        : props.error ? <Problem title="暂时没能注册" detail={props.error} /> : null}
      <section className="card">
        <form method="post" action="/s/register" id="register-form">
          <label htmlFor="register-name" className="field-label">学生姓名</label>
          <input id="register-name" name="name" type="text" autoComplete="name" maxLength={60} required />
          <label htmlFor="register-phone" className="field-label">手机号</label>
          <input id="register-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={40} required
            placeholder="填写常用手机号，可含国家区号" aria-describedby="registration-privacy" />
          <p className="hint" id="registration-privacy">姓名和手机号保存在服务器，用于管理员核验找回账号；这里不会发送短信。学生可填写家长手机号，不同学生可共用同一号码。</p>
        </form>
      </section>
      <p><a href="/s/">已有邀请码，直接登录</a></p>
    </Page>
  );
}

/** 凭证只随本次成功响应展示；不放进 URL、日志或浏览器持久存储。 */
export function RegistrationCompletePage(props: { code: string; expiresAt: Date }): ReactNode {
  return (
    <Page title="保存你的邀请码" back={null} showSettings={false}
      bar={{ caption: '这是你的登录凭证，请勿发给别人', primary: { title: '我已保存，进入错题本', key: 'registered-login', form: 'registered-login-form' }, secondary: [] }}>
      <h1>注册成功</h1>
      <p className="lead">请复制或记下邀请码，下次登录仍然使用它。</p>
      <section className="card">
        <p>你的专属邀请码</p>
        <p><code data-testid="registered-invite-code" style={{ fontSize: '1.5rem', userSelect: 'all', overflowWrap: 'anywhere' }}>{props.code}</code></p>
        <p className="hint">有效期 60 天，期间可重复登录。到期时间：<time dateTime={props.expiresAt.toISOString()}>{props.expiresAt.toISOString().replace('T', ' ').slice(0, 19)} UTC</time>。</p>
        <form method="post" action="/s/login" id="registered-login-form">
          <input type="hidden" name="code" value={props.code} />
        </form>
      </section>
      <p className="hint">忘记邀请码时，请联系老师或管理员核验后补发。不要重复注册，以免建立新的错题本。</p>
    </Page>
  );
}
