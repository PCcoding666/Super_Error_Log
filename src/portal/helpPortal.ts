/**
 * 公开产品说明页，地址 https://study.pccoding666.com/help/ 。
 * 与学生应用同一进程、同一端口，按路径区分，不看 Host：
 * GET /help/ 返回本页，GET /help 301 到 /help/（查询串保留）。
 * study.pccoding666.com 的 GET / 仍是 404；/s、/v1、/v2、/admin 不在这里处理。
 * help.pccoding666.com 子域名不再使用。不要按主机名把 GET / 换成这一页。
 * 页面是静态文案，不含学生数据、邀请码或密钥。发布包只带 dist/，所以 HTML 随 tsc 编译进去。
 *
 * 文案从「开始使用」写起。产品只留一两句：是什么、为什么、AI 做什么
 * （从照片抽题，可以给提示；错因由学生自己写）。
 * 不写适用人群，不写掌握标准，不把一周拍卷、打印、纸上做写成使用步骤。
 * 使用指南只写注册、邀请码、登录、找回、设置这些操作位置。
 * 邮箱是「待补充」。微信二维码还没到，页面上是占位，不要编造二维码。
 * 换成 <img> 时，下面的 CSP 要加 img-src。
 */
import type { Express, Request, Response, NextFunction } from 'express';

/** 规范路径。不带斜杠的 /help 会 301 到这里。 */
export const HELP_PORTAL_PATH = '/help/';

const STUDY_URL = 'https://study.pccoding666.com/s/';
const REGISTER_URL = 'https://study.pccoding666.com/s/register';
const RECOVER_URL = 'https://study.pccoding666.com/s/recover';
const SETTINGS_URL = 'https://study.pccoding666.com/s/me';
const PORTAL_URL = 'https://study.pccoding666.com/help/';
const GITHUB_URL = 'https://github.com/PCcoding666/Super_Error_Log';

export function helpPortalHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="把做错的题收进错题本，方便以后再看。AI 从照片里抽出题目，也可以给提示；错因由你自己写。">
<link rel="canonical" href="${PORTAL_URL}">
<title>超级错题本</title>
<style>
:root{--ink:#171717;--muted:#4d4d4d;--faint:#737373;--line:#ebebeb;--bg:#fff;--code:#fafafa;--sidebar:240px}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"PingFang SC","Hiragino Sans GB","Noto Sans SC","Noto Sans CJK SC","Source Han Sans SC","WenQuanYi Micro Hei","Microsoft YaHei",sans-serif;font-size:16px;line-height:1.7;letter-spacing:-.011em;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration-thickness:1px;text-underline-offset:3px}
a:hover{text-decoration-thickness:2px}
a:focus-visible{outline:2px solid #000;outline-offset:3px;border-radius:2px}
.shell{display:grid;grid-template-columns:var(--sidebar) minmax(0,1fr);align-items:start;min-height:100vh}
.side{position:sticky;top:0;height:100vh;padding:28px 24px;border-right:1px solid var(--line);background:#fff}
.brand{display:inline-block;color:var(--ink);font-weight:600;font-size:15px;letter-spacing:-.02em;text-decoration:none}
.brand:hover{text-decoration:none}
.brand-path{margin:6px 0 32px;color:var(--faint);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.4;word-break:break-all}
.side-label{margin:0 0 8px;color:var(--faint);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;letter-spacing:.06em}
.nav a{display:block;padding:7px 0 7px 12px;color:var(--muted);font-size:14px;text-decoration:none}
.nav a:hover{color:var(--ink);text-decoration:none}
body:not(:has(:target)) .nav a[href="#start"],
body:has(#start:target) .nav a[href="#start"],
body:has(#guide:target) .nav a[href="#guide"],
body:has(#contact:target) .nav a[href="#contact"]{color:var(--ink);font-weight:600}
main{max-width:680px;min-width:0;padding:48px 56px 96px}
h1{margin:0 0 16px;font-size:40px;line-height:1.15;font-weight:600;letter-spacing:-.04em}
.lede{margin:0;max-width:38em;color:var(--muted);font-size:18px;line-height:1.65}
h2{margin:80px 0 12px;font-size:24px;line-height:1.3;font-weight:600;letter-spacing:-.03em;scroll-margin-top:24px}
h2:first-of-type{margin-top:40px}
h3{margin:0 0 8px;font-size:16px;line-height:24px;font-weight:600;letter-spacing:-.02em}
p{margin:0 0 12px}
.quiet{color:var(--muted)}
.prep{margin:20px 0 0;padding:0 0 0 1.15em}
.prep li{margin:4px 0}
ol.steps{list-style:none;margin:28px 0 0;padding:0;counter-reset:step}
ol.steps li{position:relative;padding:0 0 32px 44px}
ol.steps li:last-child{padding-bottom:0}
ol.steps li::before{content:counter(step);counter-increment:step;position:absolute;left:0;top:0;width:24px;height:24px;border-radius:999px;background:#000;color:#fff;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:24px;text-align:center}
ol.steps li::after{content:"";position:absolute;left:11px;top:32px;bottom:4px;width:1px;background:var(--line)}
ol.steps li:last-child::after{display:none}
ol.steps h3{min-height:24px}
ol.steps p:last-child{margin-bottom:0}
.code{margin:12px 0 0;padding:12px 14px;border:1px solid var(--line);border-radius:8px;background:var(--code);color:var(--ink);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13.5px;line-height:1.5;overflow-wrap:anywhere;word-break:break-word;max-width:100%}
.code a{color:inherit;text-decoration:none}
.code a:hover{text-decoration:underline}
.actions{margin:16px 0 0}
.cta{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 16px;border-radius:6px;background:#000;color:#fff;font-size:14px;font-weight:500;letter-spacing:-.01em;text-decoration:none}
.cta:hover{background:#333;color:#fff;text-decoration:none}
.guide{margin-top:8px}
.guide h3{margin-top:28px}
.guide h3:first-of-type{margin-top:8px}
dl.contact{margin:8px 0 0}
dl.contact > div{padding:20px 0;border-top:1px solid var(--line)}
dl.contact dt{margin:0 0 6px;color:var(--muted);font-size:14px}
dl.contact dd{margin:0}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;overflow-wrap:anywhere;word-break:break-word}
.qr-slot{display:grid;place-items:center;width:168px;height:168px;margin-top:4px;padding:12px;border:1px dashed #cfcfcf;border-radius:8px;background:var(--code);color:var(--faint);font-size:13px;line-height:1.4;text-align:center}
footer{margin-top:96px;padding-top:24px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}
footer p{margin:0 0 6px}
footer a{color:var(--ink)}
@media (min-width:801px){
  body:not(:has(:target)) .nav a[href="#start"],
  body:has(#start:target) .nav a[href="#start"],
  body:has(#guide:target) .nav a[href="#guide"],
  body:has(#contact:target) .nav a[href="#contact"]{box-shadow:inset 2px 0 0 #000}
}
@media (max-width:800px){
  .shell{grid-template-columns:minmax(0,1fr)}
  main{min-width:0}
  .side{position:sticky;top:0;z-index:2;height:auto;padding:14px 20px 10px;border-right:0;border-bottom:1px solid var(--line);background:rgba(255,255,255,.94);backdrop-filter:saturate(180%) blur(8px)}
  .brand-path{display:none}
  .side-label{margin:10px 0 0}
  .nav{display:flex;flex-wrap:wrap;gap:0 16px}
  .nav a{padding:8px 0}
  main{padding:32px 20px 72px}
  h1{font-size:32px}
  h2{margin-top:56px;font-size:22px;scroll-margin-top:88px}
  h2:first-of-type{margin-top:36px}
  .cta{width:100%;min-height:48px}
}
</style>
</head>
<body>
<div class="shell">
  <aside class="side">
    <a class="brand" href="/help/">超级错题本</a>
    <p class="brand-path">study.pccoding666.com/help</p>
    <p class="side-label">本页</p>
    <nav class="nav" aria-label="本页">
      <a href="#start">开始使用</a>
      <a href="#guide">使用指南</a>
      <a href="#contact">联系方式</a>
    </nav>
  </aside>
  <main>
    <h1>超级错题本</h1>
    <p class="lede">把做错的题收进错题本，方便以后再看。AI 从照片里抽出题目，也可以给提示；错因由你自己写。</p>

    <h2 id="start">开始使用</h2>
    <p>准备好邀请码，打开学习页，注册或登录。</p>
    <h3>准备</h3>
    <ul class="prep">
      <li>老师或管理员发的邀请码</li>
      <li>手机或电脑上的浏览器</li>
    </ul>
    <ol class="steps">
      <li>
        <h3>打开学习页</h3>
        <p>用浏览器打开：</p>
        <p class="code"><a href="${STUDY_URL}">${STUDY_URL}</a></p>
        <p class="actions"><a class="cta" href="${STUDY_URL}">打开学习页</a></p>
      </li>
      <li>
        <h3>注册或登录</h3>
        <p>已经有邀请码：在登录页输入，进入你的错题本。</p>
        <p>第一次使用：点「首次使用，注册账号」。填写姓名和手机号，设一个 4 位找回码。注册完成后，保存页面给出的邀请码。</p>
      </li>
    </ol>

    <h2 id="guide">使用指南</h2>
    <p class="quiet">注册、邀请码、登录和设置的位置。</p>
    <div class="guide">
      <h3>学习页</h3>
      <p class="code"><a href="${STUDY_URL}">${STUDY_URL}</a></p>
      <p>注册、登录和错题本都从这里进入。</p>
      <h3>注册</h3>
      <p class="code"><a href="${REGISTER_URL}">${REGISTER_URL}</a></p>
      <p>填写姓名和手机号，设一个 4 位找回码。手机号不会收到短信。有的班级还要填写老师发的注册码。完成后保存 12 位邀请码。</p>
      <h3>登录</h3>
      <p>在学习页输入邀请码。60 天内可以重复登录。邀请码不要发给别人。</p>
      <h3>找回</h3>
      <p class="code"><a href="${RECOVER_URL}">${RECOVER_URL}</a></p>
      <p>用注册时的姓名、手机号和找回码换一个新邀请码。学习记录还在。没设过找回码的，请老师或管理员处理。</p>
      <h3>设置</h3>
      <p class="code"><a href="${SETTINGS_URL}">${SETTINGS_URL}</a></p>
      <p>登录后打开。可以改学段、查看「我的邀请码」、添加到主屏幕，或退出登录。退出后学习记录还在，再输入邀请码即可。</p>
    </div>

    <h2 id="contact">联系方式</h2>
    <dl class="contact">
      <div>
        <dt>邮箱</dt>
        <dd class="mono">待补充</dd>
      </div>
      <div>
        <dt>微信</dt>
        <dd>
          <!-- 微信二维码图片待补充。不要换成编造的二维码。换成 img 时，CSP 要加 img-src。 -->
          <div class="qr-slot" role="img" aria-label="微信二维码待补充">二维码待补充</div>
        </dd>
      </div>
    </dl>

    <footer>
      <p><a href="${GITHUB_URL}">GitHub</a></p>
      <p class="mono"><a href="${GITHUB_URL}">${GITHUB_URL}</a></p>
    </footer>
  </main>
</div>
</body>
</html>
`;
}

function pathnameOf(originalUrl: string): string {
  const queryAt = originalUrl.indexOf('?');
  return queryAt >= 0 ? originalUrl.slice(0, queryAt) : originalUrl;
}

function sendHelpPortal(response: Response): void {
  response.status(200);
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  response.setHeader('cache-control', 'public, max-age=300');
  response.removeHeader('pragma');
  response.send(helpPortalHtml());
}

/**
 * 挂在 404 之前。只认路径 /help 与 /help/，不认 Host。
 * 其它路径（含 /、/s、/v1、/v2、/admin）交给后面的路由。
 * strict routing 关闭时，注册 /help 就会同时吃进 /help/；两条都挂上，以后若打开 strict 也不会漏掉带斜杠的地址。
 */
export function registerHelpPortal(app: Express): void {
  const serve = (request: Request, response: Response, next: NextFunction): void => {
    const pathOnly = pathnameOf(request.originalUrl);
    if (pathOnly === '/help') {
      const queryAt = request.originalUrl.indexOf('?');
      const query = queryAt >= 0 ? request.originalUrl.slice(queryAt) : '';
      response.redirect(301, `/help/${query}`);
      return;
    }
    if (pathOnly === '/help/') {
      sendHelpPortal(response);
      return;
    }
    next();
  };
  app.get('/help', serve);
  app.get('/help/', serve);
}
