/** 学生邀请码网关自己的两个页面：登录页与网关错误页（不含任何学生数据，由父进程直接渲染）。 */
import type { ReactNode } from 'react';
import { Page, Problem } from '../web/views/layout.js';
import { PRIVACY_CONTACT, PRIVACY_IS_DRAFT, PRIVACY_SECTIONS, PRIVACY_SUMMARY, PRIVACY_UPDATED } from './privacyText.js';
import type { AttemptBlock } from './attemptGuard.js';

const CHECK_ROW = { display: 'flex', gap: '8px', alignItems: 'flex-start', margin: '8px 0', lineHeight: 1.5 } as const;

/** 页面上显示北京时间（与学习页一致）。 */
function beijing(date: Date): string {
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function beijingDate(date: Date): string {
  return date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' });
}

/**
 * 限速提示：说清楚是谁太频繁、要等多久。登录只在「码不对」时出现（正确的码不受限速影响）；
 * 注册名额的全站上限（scope global，在注册前挡）也用这里的 global 文案。
 */
function throttleText(block: NonNullable<AttemptBlock>): string {
  const minutes = Math.max(1, Math.ceil(block.seconds / 60));
  if (block.scope === 'global') return `现在同时试的人太多了，等 ${minutes} 分钟左右再试。`;
  if (block.scope === 'ip') return `你们这个网络里输错的次数太多了，等 ${minutes} 分钟左右再试；也可以换手机流量试试。正确的码不受影响，先对照一下有没有输错。`;
  return `这个码输错的次数太多了，等 ${minutes} 分钟左右再试。先对照一下有没有输错。`;
}

/**
 * 微信等应用内置浏览器的提示（P0-11 / B5）：可以继续用，但换到浏览器才能放到桌面、打印，
 * 而且微信里登录过的状态到了浏览器里不通用——先把邀请码记下来。
 */
export function InAppBrowserNotice(props: { show: boolean; where: 'login' | 'register' }): ReactNode {
  if (!props.show) return null;
  return (
    <section className="card tone-orange" data-testid="in-app-browser-notice" role="note">
      <p><b>现在是在微信（或其他 App）里打开的。</b></p>
      <p>可以先在这里用。想放到手机桌面、打印练习，请点右上角「…」，选「在浏览器打开」。</p>
      <p className="muted small">{props.where === 'register'
        ? '注册后会给你一个邀请码，换到浏览器以后要用它再登录一次，请先截图或复制保存。'
        : '换到浏览器以后要重新输入邀请码；登录后在「设置 → 我的邀请码」里可以再看到它。'}</p>
    </section>
  );
}

/** 页脚：规则与联系方式（每个公开页都有）。 */
function PublicFooter(): ReactNode {
  return (
    <p className="hint" data-testid="public-footer">
      <a href="/s/privacy">个人信息处理规则</a> · 联系我们：{PRIVACY_CONTACT}
    </p>
  );
}

/**
 * 登录页（§学生体验）：输入 12 位专属邀请码。错误提示统一一句话——不暴露学生是否存在、码是过期还是已用。
 * 粘贴分组（XXXX-XXXX-XXXX）、空格、大小写都接受。
 */
export function LoginPage(props: { error?: string | null; blocked?: AttemptBlock; inAppBrowser?: boolean }): ReactNode {
  return (
    <Page
      title="输入邀请码"
      back={null}
      showSettings={false}
      bar={{ caption: '首次使用可先注册，已有邀请码直接登录', primary: { title: '进入我的错题本', key: 'login', form: 'login-form' }, secondary: [] }}
    >
      <h1 data-testid="login-title">输入邀请码</h1>
      <p className="lead">每个学生有自己的邀请码。输入以后，这台手机看到的就是你自己的错题本。</p>
      <InAppBrowserNotice show={props.inAppBrowser === true} where="login" />
      {props.blocked ? (
        <Problem title="试得太频繁了" detail={throttleText(props.blocked)} />
      ) : props.error ? (
        <Problem title="这个邀请码进不去" detail="检查一下有没有输错（12 位，老师发的 8 位注册码要在注册页用）。还是进不去，联系老师或管理员补发。" reason={props.error} />
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
        <p className="hint">短横线和空格不用管，大小写都可以。邀请码 60 天内可重复登录；登录后经常用的话不用每次输。请妥善保存，不要发给别人。</p>
      </section>
      <p><a href="/s/register" className="btn">首次使用，注册账号</a></p>
      <p className="hint">忘记或过期了？联系老师或管理员，核验注册时的姓名和手机号后补发，学习记录保留。</p>
      <PublicFooter />
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

export interface RegistrationFormValues { name?: string; phone?: string; regcode?: string; ageBand?: string; consent?: boolean; guardian?: boolean }

/**
 * 注册（P0-6 / P0-10）：要老师发的注册码；收集姓名（可写化名）和手机号；
 * 必须勾选同意《个人信息处理规则》；未满 14 周岁要家长同意。号码归属尚未验证，不作为自动找回的凭据。
 */
export function RegistrationPage(props: { error?: string; blocked?: AttemptBlock; inAppBrowser?: boolean; values?: RegistrationFormValues }): ReactNode {
  const values = props.values ?? {};
  return (
    <Page title="注册账号" back={{ href: '/s/', label: '邀请码登录' }} showSettings={false}
      bar={{ caption: '注册后请保存你的专属邀请码', primary: { title: '注册并生成邀请码', key: 'register', form: 'register-form' }, secondary: [] }}>
      <h1>注册账号</h1>
      <p className="lead">用老师发的注册码，填姓名和手机号，创建自己的错题本。以后只需输入邀请码登录。</p>
      <InAppBrowserNotice show={props.inAppBrowser === true} where="register" />
      {props.blocked
        ? <Problem title="提交太频繁了" detail={throttleText(props.blocked)} />
        : props.error ? <Problem title="暂时没能注册" detail={props.error} /> : null}
      <section className="card">
        <form method="post" action="/s/register" id="register-form">
          <label htmlFor="register-code" className="field-label">注册码（8 位，老师发的）</label>
          <input id="register-code" name="regcode" type="text" autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
            maxLength={20} placeholder="XXXX-XXXX" required defaultValue={values.regcode ?? ''} data-testid="registration-code-input" />
          <p className="hint">没有注册码？问老师要；只有拿到注册码的同学才能注册。</p>
          <label htmlFor="register-name" className="field-label">学生姓名（可以写化名）</label>
          <input id="register-name" name="name" type="text" autoComplete="name" maxLength={60} required defaultValue={values.name ?? ''} />
          <label htmlFor="register-phone" className="field-label">手机号</label>
          <input id="register-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={40} required defaultValue={values.phone ?? ''}
            placeholder="填写常用手机号，可含国家区号" aria-describedby="registration-privacy" />
          <p className="hint" id="registration-privacy">姓名和手机号只用来在你忘了邀请码时核对本人；不会发短信。可以填家长的手机号，不同学生可共用同一号码。</p>
          <fieldset className="consent-fieldset" style={{ border: 0, padding: 0, margin: '12px 0' }}>
            <legend className="field-label">年龄</legend>
            <label className="check-row" style={CHECK_ROW}><input type="radio" name="age" value="14plus" required defaultChecked={values.ageBand === '14plus'} data-testid="age-14plus" /> 我已满 14 周岁</label>
            <label className="check-row" style={CHECK_ROW}><input type="radio" name="age" value="under14" defaultChecked={values.ageBand === 'under14'} data-testid="age-under14" /> 我未满 14 周岁</label>
            <label className="check-row" style={CHECK_ROW}><input type="checkbox" name="guardian" value="1" defaultChecked={values.guardian === true} data-testid="guardian-consent" /> （未满 14 周岁必填）我的家长（监护人）已经看过规则，同意我注册使用</label>
          </fieldset>
          <label className="check-row" style={CHECK_ROW}><input type="checkbox" name="consent" value="1" required defaultChecked={values.consent === true} data-testid="privacy-consent" /> 我已阅读并同意<a href="/s/privacy" target="_blank" rel="noopener">《个人信息处理规则》</a></label>
        </form>
      </section>
      <p><a href="/s/">已有邀请码，直接登录</a></p>
      <PublicFooter />
    </Page>
  );
}

/** 「复制」按钮：网关自己的小脚本（/s/account-copy.js）；没有脚本时码本身可长按选择。 */
function CopyableCode(props: { code: string; testId: string }): ReactNode {
  return (
    <>
      <p><code id={`${props.testId}-value`} data-testid={props.testId} style={{ fontSize: '1.5rem', userSelect: 'all', overflowWrap: 'anywhere' }}>{props.code}</code></p>
      <p><button type="button" className="btn secondary" data-copy-target={`${props.testId}-value`} data-testid={`${props.testId}-copy`} hidden>复制邀请码</button>
        <span className="hint" role="status" data-copy-status="" /></p>
      <script src="/s/account-copy.js" defer></script>
    </>
  );
}

/** 凭证只随本次成功响应展示；不放进 URL、日志或浏览器持久存储。 */
export function RegistrationCompletePage(props: { code: string; expiresAt: Date; inAppBrowser?: boolean }): ReactNode {
  return (
    <Page title="保存你的邀请码" back={null} showSettings={false}
      bar={{ caption: '这是你的登录凭证，请勿发给别人', primary: { title: '我已保存，进入错题本', key: 'registered-login', form: 'registered-login-form' }, secondary: [] }}>
      <h1>注册成功</h1>
      <p className="lead">请复制或截图保存邀请码，下次登录、换手机、换浏览器都要用它。</p>
      <section className="card">
        <p>你的专属邀请码</p>
        <CopyableCode code={props.code} testId="registered-invite-code" />
        <p className="hint">有效期 60 天，期间可重复登录。到期时间：<time dateTime={props.expiresAt.toISOString()}>{beijing(props.expiresAt)}（北京时间）</time>。登录以后在「设置 → 我的邀请码」里还能再看到，快到期时可以一键换新码。</p>
        <form method="post" action="/s/login" id="registered-login-form">
          <input type="hidden" name="code" value={props.code} />
        </form>
      </section>
      {props.inAppBrowser ? <p className="hint tone-orange" data-testid="in-app-browser-notice">现在在微信里：换到浏览器打开时要用这个码再登录一次。</p> : null}
      <p className="hint">忘记邀请码时，请联系老师或管理员核验后补发。不要重复注册，以免建立新的错题本。</p>
    </Page>
  );
}

/**
 * 「我的邀请码」（登录后，网关直接渲染，P0-11）：
 * - 本设备用可重复登录的码登录时，能再看到并复制这个码；
 * - 快到期（7 天内）或已经看不到时，一键重新生成：旧码作废，其他手机要用新码重新登录，学习记录不变。
 */
export function AccountPage(props: { code: string | null; expiresAt: Date | null; studentExpiresAt: Date | null; now: Date; regenerated?: boolean }): ReactNode {
  const expiry = props.expiresAt ?? props.studentExpiresAt;
  const daysLeft = expiry ? Math.ceil((expiry.getTime() - props.now.getTime()) / 86_400_000) : null;
  const expiring = daysLeft === null || daysLeft <= 7;
  return (
    <Page title="我的邀请码" back={{ href: '/s/settings', label: '设置' }} showSettings={false}
      bar={{ caption: '重新生成后，旧邀请码立刻作废；其他手机要用新码再登录一次', primary: { title: '重新生成邀请码', key: 'regenerate-invitation', form: 'regenerate-form' }, secondary: [] }}>
      <h1>我的邀请码</h1>
      {props.regenerated ? <div className="flash" role="status" data-testid="flash-ok">已经换成新邀请码，旧的不能再用了。请复制或截图保存。</div> : null}
      {expiring ? (
        <section className="card tone-orange" role="alert" data-testid="invite-expiring">
          <p><b>{daysLeft === null || daysLeft <= 0 ? '你的邀请码已经过期了。' : `你的邀请码 ${daysLeft} 天后（${beijingDate(expiry!)}）到期。`}</b></p>
          <p>这台手机暂时还能用。为了以后换手机或换浏览器也能登录，点下面的「重新生成邀请码」换一个新的（60 天有效）。</p>
        </section>
      ) : null}
      <section className="card">
        {props.code ? (
          <>
            <p>这台手机登录用的邀请码</p>
            <CopyableCode code={props.code} testId="my-invite-code" />
            {props.expiresAt ? <p className="hint">到期时间：<time dateTime={props.expiresAt.toISOString()}>{beijing(props.expiresAt)}（北京时间）</time>。</p> : null}
          </>
        ) : (
          <p data-testid="invite-code-unavailable">这台手机看不到原来的邀请码（为了安全，邀请码只在用它登录的那台手机上能看到，过期或换过的码也看不到）。需要的话点「重新生成邀请码」。</p>
        )}
        <p className="hint">邀请码就是你的钥匙：别发给别人。换手机、换浏览器（比如从微信换到 Safari）时，用它重新登录。</p>
        <form method="post" action="/s/account/regenerate" id="regenerate-form" />
      </section>
      <p className="hint"><a href="/s/privacy">个人信息处理规则</a> · 联系我们：{PRIVACY_CONTACT}</p>
    </Page>
  );
}

/** 《个人信息处理规则》（公开页，草稿文字在 privacyText.ts，等 Peng 改定）。 */
export function PrivacyPage(): ReactNode {
  return (
    <Page title="个人信息处理规则" back={{ href: '/s/', label: '返回' }} showSettings={false}>
      <h1>个人信息处理规则</h1>
      {PRIVACY_IS_DRAFT ? <p className="card tone-orange" data-testid="privacy-draft">这是草稿版本，内容还会修改；正式版本确定后会在这里更新。</p> : null}
      <p className="lead">{PRIVACY_SUMMARY}</p>
      {PRIVACY_SECTIONS.map(section => (
        <section className="card" key={section.title}>
          <h2 className="card-title">{section.title}</h2>
          <ul>{section.items.map(item => <li key={item}>{item}</li>)}</ul>
        </section>
      ))}
      <section className="card" data-testid="privacy-contact">
        <h2 className="card-title">联系我们</h2>
        <p>{PRIVACY_CONTACT}</p>
        <p className="muted small">更新日期：{PRIVACY_UPDATED}</p>
      </section>
    </Page>
  );
}
