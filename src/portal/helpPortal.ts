/**
 * 公开产品说明页，地址 https://study.pccoding666.com/help/ 。
 * 与学生应用同一进程、同一端口，按路径区分，不看 Host：
 * GET /help/ 返回本页，GET /help 301 到 /help/（查询串保留）。
 * study.pccoding666.com 的 GET / 仍是 404；/s、/v1、/v2、/admin 不在这里处理。
 * help.pccoding666.com 子域名暂不使用（DNS 仍是 NXDOMAIN）。不要再按主机名把 GET / 换成这一页。
 * 页面是静态文案，不含学生数据、邀请码或密钥。发布包只带 dist/，所以 HTML 随 tsc 编译进去。
 * 联系方式（2026-11-01）只从环境变量 SEL_HELP_CONTACT_WECHAT / SEL_HELP_CONTACT_EMAIL 读：没设就不显示那一行，代码里不写个人信息。
 */
import type { Express, Request, Response, NextFunction } from 'express';

/** 规范路径。不带斜杠的 /help 会 301 到这里。 */
export const HELP_PORTAL_PATH = '/help/';

const STUDY_URL = 'https://study.pccoding666.com/s/';
const PORTAL_URL = 'https://study.pccoding666.com/help/';
const GITHUB_URL = 'https://github.com/PCcoding666/Super_Error_Log';

export interface HelpContact { wechat?: string; email?: string }

/** 从环境变量读联系方式；空白当没有，长度截到 120。 */
export function readHelpContact(env: NodeJS.ProcessEnv = process.env): HelpContact {
  const pick = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value.slice(0, 120) : undefined;
  };
  return { wechat: pick('SEL_HELP_CONTACT_WECHAT'), email: pick('SEL_HELP_CONTACT_EMAIL') };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/** 联系方式区块：有哪一项显示哪一项；一项都没有时只说找老师。 */
function contactHtml(contact: HelpContact): string {
  const rows: string[] = [];
  if (contact.email) {
    const safe = escapeHtml(contact.email);
    const link = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(contact.email) ? `<a href="mailto:${safe}">${safe}</a>` : safe;
    rows.push(`<div><dt>邮箱</dt><dd data-contact="email">${link}</dd></div>`);
  }
  if (contact.wechat) rows.push(`<div><dt>微信</dt><dd data-contact="wechat">${escapeHtml(contact.wechat)}</dd></div>`);
  if (rows.length === 0) return '<p class="quiet" data-contact="none">使用中有问题，先问给你邀请码的老师。</p>';
  return `<dl class="contact">${rows.join('')}</dl>`;
}

export function helpPortalHtml(contact: HelpContact = readHelpContact()): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="超级错题本：周末拍下做错的题，工作日在纸上再做一遍，下周末把结果记回来。">
<link rel="canonical" href="${PORTAL_URL}">
<title>超级错题本</title>
<style>
:root{--ink:#171717;--muted:#4d4d4d;--faint:#666;--line:#eaeaea;--link:#0070f3;--bg:#fff;--sidebar:240px}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"PingFang SC","Hiragino Sans GB","Noto Sans SC","Noto Sans CJK SC","Source Han Sans SC","WenQuanYi Micro Hei","Microsoft YaHei",sans-serif;font-size:16px;line-height:1.7;letter-spacing:-.011em}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
a:focus-visible{outline:2px solid var(--link);outline-offset:3px}
.top{position:sticky;top:0;z-index:2;display:flex;align-items:baseline;gap:12px;height:64px;padding:0 28px;background:rgba(255,255,255,.92);border-bottom:1px solid var(--line);backdrop-filter:saturate(180%) blur(8px)}
.brand{color:var(--ink);font-weight:600;font-size:15px;letter-spacing:-.02em}
.brand:hover{text-decoration:none}
.brand-mark{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--faint);letter-spacing:.04em}
.layout{display:grid;grid-template-columns:var(--sidebar) minmax(0,1fr);align-items:start}
aside{position:sticky;top:64px;height:calc(100vh - 64px);padding:32px 24px 48px 28px;border-right:1px solid var(--line)}
.side-label{margin:0 0 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--faint);letter-spacing:.06em}
aside a{display:block;padding:7px 0;color:var(--muted);font-size:14px}
aside a:hover{color:var(--ink);text-decoration:none}
body:has(#product:target) a[href="#product"],
body:has(#use:target) a[href="#use"],
body:has(#start:target) a[href="#start"],
body:has(#install:target) a[href="#install"],
body:has(#contact:target) a[href="#contact"]{color:var(--ink);font-weight:600}
main{max-width:760px;padding:72px 56px 96px}
h1{margin:0 0 16px;font-size:44px;line-height:1.15;font-weight:600;letter-spacing:-.04em}
.lede{margin:0;max-width:38em;color:var(--muted);font-size:20px;line-height:1.6}
h2{margin:72px 0 16px;font-size:28px;line-height:1.3;font-weight:600;letter-spacing:-.03em;scroll-margin-top:88px}
h2 .num{margin-right:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;font-weight:400;color:var(--faint);letter-spacing:0}
h3{margin:40px 0 8px;font-size:20px;line-height:1.3;font-weight:600;letter-spacing:-.02em;scroll-margin-top:88px}
p{margin:0 0 16px}
.quiet{color:var(--muted)}
ol.steps{list-style:none;margin:8px 0 0;padding:0}
ol.steps li{padding:22px 0;border-top:1px solid var(--line)}
ol.steps strong{display:block;margin-bottom:4px;font-size:18px;font-weight:600;letter-spacing:-.02em}
ol.steps strong span{margin-right:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;font-weight:400;color:var(--faint)}
.cta{display:inline-flex;align-items:center;min-height:44px;margin:8px 0 16px;padding:0 18px;border-radius:8px;background:#000;color:#fff;font-weight:500}
.cta:hover{background:#333;text-decoration:none}
.url{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px}
dl.contact{margin:8px 0 0;border-top:1px solid var(--line)}
dl.contact div{display:grid;grid-template-columns:6em 1fr;gap:16px;padding:14px 0;border-bottom:1px solid var(--line)}
dl.contact dt{margin:0;color:var(--muted)}
dl.contact dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px}
footer{margin-top:80px;padding-top:24px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}
footer p{margin:0 0 6px}
@media (max-width:800px){
  .top{padding:0 20px}
  .layout{grid-template-columns:1fr}
  aside{position:static;height:auto;padding:8px 20px 12px;border-right:0;border-bottom:1px solid var(--line)}
  .side-label{margin-top:12px}
  aside nav{display:flex;flex-wrap:wrap;gap:4px 18px}
  aside a{padding:8px 0}
  main{padding:40px 20px 72px}
  h1{font-size:36px}
  h2{margin-top:48px;font-size:24px}
  dl.contact div{grid-template-columns:5em 1fr}
}
</style>
</head>
<body>
<header class="top">
  <a class="brand" href="/help/">超级错题本</a>
  <span class="brand-mark">说明</span>
</header>
<div class="layout">
  <aside>
    <p class="side-label">目录</p>
    <nav aria-label="目录">
      <a href="#product">产品是什么</a>
      <a href="#use">怎么用</a>
      <a href="#start">开始使用</a>
      <a href="#install">放到手机桌面</a>
      <a href="#contact">联系方式</a>
    </nav>
  </aside>
  <main>
    <h1>超级错题本</h1>
    <p class="lede">把卷子上做错的题收好，隔几天在纸上再做一遍。</p>

    <h2 id="product"><span class="num">01</span>产品是什么</h2>
    <p>超级错题本给寄宿制学生用。周末用手机拍下批改过的卷子，把做错的题收进错题本；工作日把打印出来的练习在纸上做完；下个周末把结果记回来。</p>
    <p>隔几天还能自己做对，才算真的会了。当天做对，不算会。</p>
    <p class="quiet">照片里的题目由 AI 抽出，建议也由 AI 给出。错因要自己写下来。家长只看到完成情况和掌握程度这些汇总，看不到题目，也看不到错因。</p>

    <h2 id="use"><span class="num">02</span>怎么用</h2>
    <ol class="steps">
      <li><strong><span>01</span>周末拍卷</strong>拿到批改过的卷子，一页拍一张。放平、拍全、光线均匀。相册里可以一次选多张。</li>
      <li><strong><span>02</span>收进错题本</strong>老师打了叉的题会自动收进来。没有自动收、但自己做错或没把握的，勾上再收录。做对的不用收。</li>
      <li><strong><span>03</span>打印练习</strong>选这周要练的几道题，打印出来带回学校。</li>
      <li><strong><span>04</span>工作日纸上做</strong>不看答案，自己做。每道题写上做题日期，勾选独立做出、看了提示，或没做出来。</li>
      <li><strong><span>05</span>下周末记结果</strong>按纸上写的，把每题的日期和对错记回来。隔 3 天以上还能独立做对，才算真的会了。</li>
    </ol>

    <h2 id="start"><span class="num">03</span>开始使用</h2>
    <p>三步就能用起来。手机浏览器打开就行，不用装 App。</p>
    <ol class="steps" data-testid="start-steps">
      <li><strong><span>01</span>扫码或点链接</strong>老师会给你一个二维码或一条链接。用手机相机扫一下，或直接点链接，打开的登录页里邀请码已经填好。只拿到 12 位邀请码的，打开下面的学习页手动输入。</li>
      <li><strong><span>02</span>进入错题本</strong>点「进入我的错题本」。在微信里打开的，先点右上角「…」→「在浏览器打开」（iPhone 上叫「在 Safari 中打开」），到浏览器里再进入。</li>
      <li><strong><span>03</span>拍一张批改过的卷子</strong>点「去拍照」，拍一张老师批改过的卷子，放平、拍全。做错的题会收进错题本，接下来照上面「怎么用」的节奏走。</li>
    </ol>
    <p><a class="cta" href="${STUDY_URL}">开始使用</a></p>
    <p class="url"><a href="${STUDY_URL}">${STUDY_URL}</a></p>

    <h3 id="install">放到手机桌面</h3>
    <p class="quiet">放到桌面以后，像 App 一样一点就开，不用每次找链接。这一步要在浏览器里做，微信里做不了。</p>
    <ol class="steps" data-testid="install-steps">
      <li><strong>iPhone · Safari</strong>用 Safari 打开学习页 → 点底部「分享」（方框加向上箭头）→ 往下找「添加到主屏幕」→ 点右上角「添加」。</li>
      <li><strong>安卓 · Chrome</strong>用 Chrome 打开学习页 → 点右上角「⋮」→「添加到主屏幕」（有的叫「安装应用」）→「添加」。安卓上图标打开的还是浏览器页面，这样拍照和相册才能正常用。</li>
    </ol>

    <h2 id="contact"><span class="num">04</span>联系方式</h2>
    ${contactHtml(contact)}

    <footer>
      <p><a href="${GITHUB_URL}">GitHub</a></p>
      <p class="url"><a href="${GITHUB_URL}">${GITHUB_URL}</a></p>
      <p>超级错题本 · Super Error Log</p>
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
  response.send(helpPortalHtml(readHelpContact()));
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
