/** 学生邀请码网关自己的页面：登录、注册、找回、我的邀请码与网关错误页（不含学习数据，由父进程直接渲染）。 */
import type { ReactNode } from 'react';
import { Page, Problem } from '../web/views/layout.js';
import type { AttemptBlock } from './attemptGuard.js';

/** 页面上显示北京时间（与学习页一致）。 */
function beijing(date: Date): string {
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function beijingDate(date: Date): string {
  return date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' });
}

/** 限速提示：说清楚是谁太频繁、要等多久。subject 是按什么计的（码 / 这个网络）。 */
function throttleText(block: NonNullable<AttemptBlock>, subject = '这个码'): string {
  const minutes = Math.max(1, Math.ceil(block.seconds / 60));
  if (block.scope === 'global') return `现在同时试的人太多了，等 ${minutes} 分钟左右再试。`;
  if (block.scope === 'ip_success') return `你们这个网络里刚注册的人太多了，等 ${minutes} 分钟左右再试；也可以换手机流量试试。`;
  if (block.scope === 'ip' || subject !== '这个码') return `你们这个网络里输错的次数太多了，等 ${minutes} 分钟左右再试；也可以换手机流量试试。${subject === '这个码' ? '正确的码不受影响，先对照一下有没有输错。' : ''}`;
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
        <Problem title="这个邀请码进不去" detail="检查一下有没有输错（12 位）。忘了或过期了，可以用注册时设的找回码换一个新的。" reason={props.error} />
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
      <p><a href="/s/recover" data-testid="recover-link">忘了邀请码？找回</a></p>
      <p className="hint">用注册时的姓名、手机号和找回码换一个新邀请码，学习记录都在。没设过找回码的老账号，请老师或管理员帮你找回。</p>
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

export interface RegistrationFormValues { name?: string; phone?: string; regcode?: string }

export type RegistrationField = 'regcode' | 'name' | 'phone' | 'pin';

/** 和服务器拒绝时的那句一样，客户端提前拦住空的、不够 4 位的、太好猜的找回码。 */
export const RECOVERY_PIN_SET_MESSAGE = '请设一个 4 位数字的找回码（不要用 1234、0000 这种），忘了邀请码时要用它。';
const RECOVERY_PIN_SAVE_MESSAGE = '找回码要 4 位数字，不要用 1234、0000 这种好猜的。';
const RECOVERY_PIN_ENTER_MESSAGE = '请填写 4 位找回码。';
const NAME_MESSAGE = '请填写学生姓名（可以写化名）。';
const PHONE_MESSAGE = '请填写有效手机号。不会发短信，7 到 15 位数字即可。';
const REGCODE_MESSAGE = '注册码不正确或已经失效。请向老师要班级注册码。';

/**
 * 注册失败时，把格式问题落到具体输入框。重复注册、名额已满仍只在页面上方说明，
 * 因为那不是某一格填错。找回对不上时不指出是哪一项（不暴露账号是否存在）。
 */
export function registrationFieldErrors(code: string, values: { name: string; phone: string }): Partial<Record<RegistrationField, string>> | undefined {
  if (code === 'invalid_recovery_pin') return { pin: RECOVERY_PIN_SET_MESSAGE };
  if (code === 'invalid_registration_code') return { regcode: REGCODE_MESSAGE };
  if (code !== 'invalid_registration') return undefined;
  const name = values.name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const phone = values.phone.normalize('NFKC').trim().replace(/[\s()-]/gu, '');
  const nameBad = !name || name.length > 60 || /[\p{Cc}\p{Cf}]/u.test(name);
  const phoneBad = !/^\+?[0-9]{7,15}$/.test(phone);
  const errors: Partial<Record<RegistrationField, string>> = {};
  if (nameBad) errors.name = NAME_MESSAGE;
  if (phoneBad) errors.phone = PHONE_MESSAGE;
  if (!nameBad && !phoneBad) errors.name = '请填写姓名和有效手机号。';
  return errors;
}

function firstField(errors?: Partial<Record<RegistrationField, string>>): RegistrationField | null {
  if (!errors) return null;
  for (const field of ['regcode', 'name', 'phone', 'pin'] as const) if (errors[field]) return field;
  return null;
}

/** 底栏短句：人盯着按钮时也能看见为什么没注册上。 */
function registerBar(errors?: Partial<Record<RegistrationField, string>>): { caption: string; captionAlert?: boolean } {
  if (errors?.pin) return { caption: '请先设好 4 位找回码', captionAlert: true };
  if (errors?.name && errors?.phone) return { caption: '请先填好姓名和手机号', captionAlert: true };
  if (errors?.phone) return { caption: '请先填对手机号', captionAlert: true };
  if (errors?.name) return { caption: '请先填写姓名', captionAlert: true };
  if (errors?.regcode) return { caption: '请先填对注册码', captionAlert: true };
  return { caption: '注册后请保存你的专属邀请码' };
}

/** 输入框正下方的红字。没有错误时也留着空位，脚本填上后不用再造节点。 */
function FieldAlert(props: { id: string; message?: string }): ReactNode {
  return <p className="field-error" id={`${props.id}-error`} role="alert" data-testid={`${props.id}-error`} hidden={!props.message}>{props.message ?? ''}</p>;
}

/** 4 位找回码输入框（注册、找回、我的邀请码共用）。 */
function PinInput(props: { id: string; label: string; hint: string; error?: string; autoFocus?: boolean; message: string; caption: string }): ReactNode {
  return <>
    <label htmlFor={props.id} className="field-label">{props.label}</label>
    <input id={props.id} name="pin" type="text" inputMode="numeric" autoComplete="off" enterKeyHint="done" pattern="[0-9]{4}" minLength={4} maxLength={4} required
      placeholder="4 位数字" aria-describedby={props.error ? `${props.id}-error ${props.id}-hint` : `${props.id}-hint`} aria-invalid={props.error ? true : undefined}
      autoFocus={props.autoFocus} data-invalid-message={props.message} data-caption={props.caption} data-testid={`${props.id}-input`} />
    <FieldAlert id={props.id} message={props.error} />
    <p className="hint" id={`${props.id}-hint`}>{props.hint}</p>
  </>;
}

/**
 * 注册：填姓名（可写化名）、手机号，自己设一个 4 位找回码；网关打开班级注册码时另要注册码。
 * 手机号不发短信、不验证归属，只和找回码一起用来自助找回。
 */
export function RegistrationPage(props: { error?: string; duplicate?: boolean; blocked?: AttemptBlock; inAppBrowser?: boolean; values?: RegistrationFormValues; requireCode?: boolean; fieldErrors?: Partial<Record<RegistrationField, string>> }): ReactNode {
  const values = props.values ?? {};
  const errors = props.fieldErrors;
  const focus = firstField(errors);
  const bar = registerBar(errors);
  return (
    <Page title="注册账号" back={{ href: '/s/', label: '邀请码登录' }} showSettings={false}
      bar={{ ...bar, primary: { title: '注册并生成邀请码', key: 'register', form: 'register-form' }, secondary: [] }}>
      <h1>注册账号</h1>
      <p className="lead">填姓名和手机号，设一个找回码，就能有自己的错题本。以后输入邀请码登录。</p>
      <InAppBrowserNotice show={props.inAppBrowser === true} where="register" />
      {props.blocked
        ? <Problem title="提交太频繁了" detail={throttleText(props.blocked, props.requireCode ? '这个码' : '这个网络')} />
        : props.error ? <Problem title="暂时没能注册" detail={props.error} /> : null}
      {props.duplicate ? <p><a className="btn" href="/s/recover">用找回码找回邀请码</a></p> : null}
      <section className="card">
        <form method="post" action="/s/register" id="register-form" data-field-gate="" data-pin-guard="set" data-wait="正在注册…">
          {props.requireCode ? <>
            <label htmlFor="register-code" className="field-label">注册码（8 位，老师发的）</label>
            <input id="register-code" name="regcode" type="text" autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
              maxLength={20} placeholder="XXXX-XXXX" required defaultValue={values.regcode ?? ''} data-testid="registration-code-input"
              aria-invalid={errors?.regcode ? true : undefined} aria-describedby={errors?.regcode ? 'register-code-error' : undefined}
              autoFocus={focus === 'regcode'} data-invalid-message="请填写老师发的注册码。" data-caption="请先填对注册码" />
            <FieldAlert id="register-code" message={errors?.regcode} />
          </> : null}
          <label htmlFor="register-name" className="field-label">学生姓名（可以写化名）</label>
          <input id="register-name" name="name" type="text" autoComplete="name" maxLength={60} required defaultValue={values.name ?? ''}
            aria-invalid={errors?.name ? true : undefined} aria-describedby={errors?.name ? 'register-name-error' : undefined}
            autoFocus={focus === 'name'} data-invalid-message={NAME_MESSAGE} data-caption="请先填写姓名" />
          <FieldAlert id="register-name" message={errors?.name} />
          <label htmlFor="register-phone" className="field-label">手机号</label>
          <input id="register-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={40} required defaultValue={values.phone ?? ''}
            placeholder="填写常用手机号，可含国家区号" aria-invalid={errors?.phone ? true : undefined}
            aria-describedby={errors?.phone ? 'register-phone-error registration-phone-hint' : 'registration-phone-hint'}
            autoFocus={focus === 'phone'} data-invalid-message={PHONE_MESSAGE} data-caption="请先填对手机号" />
          <FieldAlert id="register-phone" message={errors?.phone} />
          <p className="hint" id="registration-phone-hint">不会发短信。可以填家长的手机号，不同学生可共用同一号码。</p>
          <PinInput id="register-pin" label="设一个找回码（4 位数字）" hint="忘了邀请码时，用姓名、手机号和这 4 位数字找回。不要用 1234、0000 这种好猜的，也别告诉别人。"
            error={errors?.pin} autoFocus={focus === 'pin'} message={RECOVERY_PIN_SET_MESSAGE} caption="请先设好 4 位找回码" />
        </form>
      </section>
      <p><a href="/s/">已有邀请码，直接登录</a></p>
    </Page>
  );
}

/** 自助找回：姓名 + 手机号 + 找回码。对不上统一一句话，不说是哪一项错。 */
export function RecoveryPage(props: { error?: string; blocked?: AttemptBlock; inAppBrowser?: boolean; values?: { name?: string; phone?: string } }): ReactNode {
  const values = props.values ?? {};
  return (
    <Page title="找回邀请码" back={{ href: '/s/', label: '邀请码登录' }} showSettings={false}
      bar={{ caption: '找回后旧邀请码作废，学习记录都在', primary: { title: '找回邀请码', key: 'recover', form: 'recover-form' }, secondary: [] }}>
      <h1>找回邀请码</h1>
      <p className="lead">填注册时的姓名、手机号和找回码，换一个新的邀请码。</p>
      <InAppBrowserNotice show={props.inAppBrowser === true} where="register" />
      {props.blocked
        ? <Problem title="试得太频繁了" detail={throttleText(props.blocked, '这个网络')} />
        : props.error ? <Problem title="没能找回" detail={props.error} /> : null}
      <section className="card">
        <form method="post" action="/s/recover" id="recover-form" data-field-gate="" data-wait="正在找回…">
          <label htmlFor="recover-name" className="field-label">学生姓名（和注册时一样）</label>
          <input id="recover-name" name="name" type="text" autoComplete="name" maxLength={60} required defaultValue={values.name ?? ''}
            data-invalid-message="请填写学生姓名。" data-caption="请先填写姓名" />
          <FieldAlert id="recover-name" />
          <label htmlFor="recover-phone" className="field-label">手机号</label>
          <input id="recover-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={40} required defaultValue={values.phone ?? ''}
            data-invalid-message="请填写手机号。" data-caption="请先填写手机号" />
          <FieldAlert id="recover-phone" />
          <PinInput id="recover-pin" label="找回码（4 位数字）" hint="连续输错 5 次，要等 24 小时才能再试。" message={RECOVERY_PIN_ENTER_MESSAGE} caption="请先填写 4 位找回码" />
        </form>
      </section>
      <p className="hint">没设过找回码的老账号，请老师或管理员帮你找回。</p>
      <p><a href="/s/register">还没注册过？注册账号</a></p>
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

/** 凭证只随本次成功响应展示；不放进 URL、日志或浏览器持久存储。找回成功也用这一页。 */
export function RegistrationCompletePage(props: { code: string; expiresAt: Date; inAppBrowser?: boolean; recovered?: boolean }): ReactNode {
  return (
    <Page title="保存你的邀请码" back={null} showSettings={false}
      bar={{ caption: '这是你的登录凭证，请勿发给别人', primary: { title: '我已保存，进入错题本', key: 'registered-login', form: 'registered-login-form' }, secondary: [] }}>
      <h1>{props.recovered ? '找回成功' : '注册成功'}</h1>
      <p className="lead">{props.recovered
        ? '这是新的邀请码，旧的已经作废；其他手机要用新码重新登录。学习记录都在。'
        : '请复制或截图保存邀请码，下次登录、换手机、换浏览器都要用它。'}</p>
      <section className="card">
        <p>你的专属邀请码</p>
        <CopyableCode code={props.code} testId="registered-invite-code" />
        <p className="hint">有效期 60 天，期间可重复登录。到期时间：<time dateTime={props.expiresAt.toISOString()}>{beijing(props.expiresAt)}（北京时间）</time>。登录以后在「设置 → 我的邀请码」里还能再看到，快到期时可以一键换新码。</p>
        <form method="post" action="/s/login" id="registered-login-form">
          <input type="hidden" name="code" value={props.code} />
        </form>
      </section>
      {props.inAppBrowser ? <p className="hint tone-orange" data-testid="in-app-browser-notice">现在在微信里：换到浏览器打开时要用这个码再登录一次。</p> : null}
      <p className="hint">忘了邀请码，用姓名、手机号和找回码找回。不要重复注册，以免建立新的错题本。</p>
    </Page>
  );
}

/**
 * 「我的邀请码」（登录后，网关直接渲染，P0-11）：
 * - 本设备用可重复登录的码登录时，能再看到并复制这个码；
 * - 快到期（7 天内）或已经看不到时，一键重新生成：旧码作废，其他手机要用新码重新登录，学习记录不变。
 */
export function AccountPage(props: { code: string | null; expiresAt: Date | null; studentExpiresAt: Date | null; now: Date; regenerated?: boolean;
  /** 有没有设过找回码；null = 不是自助注册的账号，没有找回。 */
  recovery?: boolean | null; pinSaved?: boolean; pinError?: string }): ReactNode {
  const expiry = props.expiresAt ?? props.studentExpiresAt;
  const daysLeft = expiry ? Math.ceil((expiry.getTime() - props.now.getTime()) / 86_400_000) : null;
  const expiring = daysLeft === null || daysLeft <= 7;
  return (
    <Page title="我的邀请码" back={{ href: '/s/settings', label: '设置' }} showSettings={false}
      bar={{ caption: '重新生成后，旧邀请码立刻作废；其他手机要用新码再登录一次', primary: { title: '重新生成邀请码', key: 'regenerate-invitation', form: 'regenerate-form' }, secondary: [] }}>
      <h1>我的邀请码</h1>
      {props.regenerated ? <div className="flash" role="status" data-testid="flash-ok">已经换成新邀请码，旧的不能再用了。请复制或截图保存。</div> : null}
      {props.pinSaved ? <div className="flash" role="status" data-testid="flash-ok">找回码已保存。</div> : null}
      {props.pinError && (props.recovery === null || props.recovery === undefined) ? <Problem title="没能保存找回码" detail={props.pinError} /> : null}
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
      {props.recovery === null || props.recovery === undefined ? null : (
        <section className="card" data-testid="recovery-pin">
          <h2 className="card-title">找回码</h2>
          {props.pinError ? <Problem title="没能保存找回码" detail={props.pinError} /> : null}
          <p>{props.recovery
            ? '已经设好了。忘了邀请码时，用姓名、手机号和找回码就能换一个新的。想改可以在下面重新设。'
            : <b className="tone-orange">还没设找回码。设一个，以后忘了邀请码可以自己找回。</b>}</p>
          <form method="post" action="/s/account/recovery" data-field-gate="" data-pin-guard="set">
            <PinInput id="account-pin" label={props.recovery ? '新的找回码（4 位数字）' : '设一个找回码（4 位数字）'} hint="不要用 1234、0000 这种好猜的，也别告诉别人。"
              error={props.pinError} autoFocus={Boolean(props.pinError)} message={RECOVERY_PIN_SAVE_MESSAGE} caption="请先设好 4 位找回码" />
            <button className="btn" type="submit">保存找回码</button>
          </form>
        </section>
      )}
    </Page>
  );
}
