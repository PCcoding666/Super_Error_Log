/**
 * 公开产品说明页，地址 https://study.pccoding666.com/help/ 。
 * 与学生应用同一进程、同一端口，按路径区分，不看 Host：
 * GET /help/ 返回本页，GET /help 301 到 /help/（查询串保留）。
 * GET /help/img/<name>.webp 返回说明页配图。应用内截图来自真实试卷，已隐去姓名、学校、手机号和邀请码。
 * study.pccoding666.com 的 GET / 仍是 404；/s、/v1、/v2、/admin 不在这里处理。
 * help.pccoding666.com 子域名暂不使用（DNS 仍是 NXDOMAIN）。不要再按主机名把 GET / 换成这一页。
 * 页面是静态文案。发布包只带 dist/，HTML 随 tsc 编译进去；图片在构建时复制到 dist/portal/help-img/。
 * 联系方式：先问老师那句始终在。微信群「超级错题本天使用户」的二维码写在页面上，2026-11-23 前有效，过期要换图。
 * 邮箱和微信号仍只从环境变量 SEL_HELP_CONTACT_WECHAT / SEL_HELP_CONTACT_EMAIL 读：没设就不显示那一行，代码里不写个人微信号。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express, Request, Response, NextFunction } from 'express';

/** 规范路径。不带斜杠的 /help 会 301 到这里。 */
export const HELP_PORTAL_PATH = '/help/';

const STUDY_URL = 'https://study.pccoding666.com/s/';
const PORTAL_URL = 'https://study.pccoding666.com/help/';
const GITHUB_URL = 'https://github.com/PCcoding666/Super_Error_Log';

/** 说明页允许下发的图。名字固定，拒绝其它路径。 */
export const HELP_GUIDE_IMAGES = [
  'notebook-empty.webp',
  'notebook-list.webp',
  'intake-pick.webp',
  'item-detail.webp',
  'item-menu.webp',
  'item-answer.webp',
  'login.webp',
  'register.webp',
  'register-done.webp',
  'recover.webp',
  'wechat-group.webp',
  'iphone-confirm.webp',
  'iphone-home.webp',
] as const;

const HELP_GUIDE_IMAGE_SET = new Set<string>(HELP_GUIDE_IMAGES);

const HELP_IMAGE_DIRS = [
  fileURLToPath(new URL('./help-img/', import.meta.url)),
  path.resolve(process.cwd(), 'src/portal/help-img'),
];

/** 只读白名单里的 webp。找不到或名字不合法时返回 null。 */
export function readHelpImage(name: string): Buffer | null {
  if (!HELP_GUIDE_IMAGE_SET.has(name)) return null;
  for (const dir of HELP_IMAGE_DIRS) {
    const file = path.join(dir, name);
    if (existsSync(file)) return readFileSync(file);
  }
  return null;
}

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

/** 联系方式：老师那句和微信群二维码始终在。邮箱、微信号有哪一项才多出那一行。 */
function contactHtml(contact: HelpContact): string {
  const rows: string[] = [];
  if (contact.email) {
    const safe = escapeHtml(contact.email);
    const link = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(contact.email) ? `<a href="mailto:${safe}">${safe}</a>` : safe;
    rows.push(`<div><dt>邮箱</dt><dd data-contact="email">${link}</dd></div>`);
  }
  if (contact.wechat) rows.push(`<div><dt>微信</dt><dd data-contact="wechat">${escapeHtml(contact.wechat)}</dd></div>`);
  const directory = rows.length === 0 ? '' : `<dl class="group">${rows.join('')}</dl>`;
  const none = rows.length === 0 ? ' data-contact="none"' : '';
  return `<p class="note"${none}>使用中有问题，先问老师。</p>
<p>也可以加入微信群「超级错题本天使用户」。下面的二维码在 2026 年 11 月 23 日前有效（图上写的是 7 天内、11月23日前），过期后要换成新的。</p>
<figure class="contact-qr"><img src="/help/img/wechat-group.webp" width="1220" height="2712" alt="微信群「超级错题本天使用户」的入群二维码，图上写着 11月23日前有效。" loading="eager" decoding="async"></figure>
${directory}`;
}

/**
 * 一步一张卡：手机框里的图，配一两句说明。
 * 说明页没有脚本，CSP 也不允许补脚本。Safari 会跳过 loading=lazy 的预加载，
 * 从目录锚点或平滑滚动把图带进画面后也不一定开始请求，框里就只剩占位底色。
 * 所以这里全部立即加载。
 */
function card(file: string, alt: string, title: string, text: string): string {
  return `<article class="card"><figure class="device"><img src="/help/img/${file}" width="390" height="844" alt="${alt}" loading="eager" decoding="async"></figure><div class="card-copy"><h3>${title}</h3><p>${text}</p></div></article>`;
}

const TOC_LINKS = `<a href="#start">第一次用</a><a href="#use">经常用</a><a href="#faq">遇到问题</a><a href="#contact">联系</a>`;

export function helpPortalHtml(contact: HelpContact = readHelpContact()): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f2f2f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<meta name="description" content="超级错题本使用说明：自己注册，拍一张批改过的卷子，做错的题收进错题本。">
<link rel="canonical" href="${PORTAL_URL}">
<title>超级错题本</title>
<style>
/* 色值、字体、圆角与 client/src/theme.css 的 Ionic 学生端一致。 */
:root {
  color-scheme: light dark;
  --ion-color-primary: #0066d6;
  --ion-color-primary-contrast: #ffffff;
  --ion-color-primary-shade: #005abc;
  --ion-font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
  --ion-background-color: #f2f2f7;
  --ion-item-background: #ffffff;
  --ion-text-color: #1c1c1e;
  --sel-muted: #6e6e73;
  --sel-line: #e5e5ea;
  --link: #0066d6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ion-background-color: #000000;
    --ion-item-background: #1c1c1e;
    --ion-text-color: #f5f5f7;
    --sel-muted: #aeaeb5;
    --sel-line: #38383d;
    --link: #64b5ff;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--ion-background-color);
  color: var(--ion-text-color);
  font-family: var(--ion-font-family);
  font-size: 17px;
  line-height: 1.5;
  letter-spacing: -0.01em;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--link); text-decoration: none; overflow-wrap: anywhere; }
a:hover { text-decoration: underline; }
a:focus-visible, summary:focus-visible, .cta:focus-visible {
  outline: 3px solid var(--ion-color-primary);
  outline-offset: 3px;
}
.skip {
  position: absolute;
  left: 12px;
  top: 8px;
  z-index: 10;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--ion-item-background);
  transform: translateY(-160%);
}
.skip:focus { transform: none; }
.top {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 56px;
  padding: max(8px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) 8px max(16px, env(safe-area-inset-left, 0px));
  background: var(--ion-background-color);
  background: color-mix(in srgb, var(--ion-background-color) 86%, transparent);
  border-bottom: 1px solid var(--sel-line);
  backdrop-filter: saturate(180%) blur(16px);
}
.brand { color: var(--ion-text-color); font-size: 17px; font-weight: 700; letter-spacing: -0.02em; }
.brand:hover { text-decoration: none; }
.cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  min-height: 44px;
  padding: 0 18px;
  border-radius: 999px;
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  font-weight: 600;
  font-size: 16px;
}
.cta:hover { background: var(--ion-color-primary-shade); text-decoration: none; }
.layout {
  display: grid;
  grid-template-columns: 176px minmax(0, 1fr);
  gap: 36px;
  width: min(1120px, calc(100% - 40px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
  margin: 0 auto;
  padding-bottom: max(72px, env(safe-area-inset-bottom, 0px));
}
main { min-width: 0; }
.sidenav {
  position: sticky;
  top: 72px;
  align-self: start;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: calc(100vh - 88px);
  overflow: auto;
  padding: 12px 0 32px;
}
.toc-disclosure { display: none; }
.toc a {
  display: flex;
  align-items: center;
  min-height: 40px;
  padding: 0 12px;
  border-radius: 12px;
  color: var(--ion-text-color);
  font-size: 15px;
  font-weight: 500;
  line-height: 1.3;
}
.toc a:hover { color: var(--ion-text-color); background: rgba(120, 120, 128, .12); text-decoration: none; }
body:has(#start:target) .toc a[href="#start"],
body:has(#use:target) .toc a[href="#use"],
body:has(#faq:target) .toc a[href="#faq"],
body:has(#contact:target) .toc a[href="#contact"] {
  color: var(--ion-text-color);
  background: rgba(0, 102, 214, .12);
}
.kicker { margin: 0 0 8px; color: var(--link); font-size: 13px; font-weight: 600; }
h1 {
  margin: 0 0 12px;
  font-size: clamp(40px, 5vw, 56px);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.08;
}
.hero {
  display: grid;
  grid-template-columns: minmax(0, 40em);
  gap: 28px 40px;
  align-items: center;
  padding: 28px 0 8px;
  scroll-margin-top: 72px;
}
.lede { margin: 0; max-width: 28em; font-size: 20px; line-height: 1.45; }
.quiet, .note { margin: 12px 0 0; color: var(--sel-muted); font-size: 15px; line-height: 1.5; }
.hero-actions { margin: 22px 0 0; }
.shot-note { margin: 10px 0 0; color: var(--sel-muted); font-size: 14px; line-height: 1.4; text-align: center; }
.contact-qr { margin: 16px 0 0; max-width: 390px; }
.contact-qr img { display: block; width: 100%; height: auto; border-radius: 22px; background: #000; }
.cards + .group { margin-top: 14px; }
.device {
  margin: 0;
  padding: 8px;
  border-radius: 36px;
  background: linear-gradient(180deg, #3a3a3c 0%, #1c1c1e 30%);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .16), 0 18px 44px rgba(0, 0, 0, .2);
}
.device img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 28px;
  background: #f2f2f7;
}
section { scroll-margin-top: 72px; }
.section-head { margin: 64px 0 16px; }
.section-head h2 {
  margin: 0 0 8px;
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.15;
}
.section-head p { margin: 0; max-width: 40em; }
.url { margin-top: 8px; font-size: 15px; }
.cards { display: flex; flex-direction: column; gap: 36px; }
.card {
  display: grid;
  grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
  gap: 20px 28px;
  align-items: start;
  min-width: 0;
  padding: 0;
  background: transparent;
  border-radius: 22px;
}
.card-copy {
  align-self: start;
  padding: 22px 24px;
  background: var(--ion-item-background);
  border-radius: 22px;
}
.cards > .card:nth-child(even):not(.card-wide):not(.card-note) {
  grid-template-columns: minmax(0, 1fr) minmax(240px, 320px);
}
.cards > .card:nth-child(even):not(.card-wide):not(.card-note) .device { order: 2; }
.card-wide { grid-template-columns: minmax(0, 1.15fr) minmax(220px, .85fr); }
.card-note {
  grid-template-columns: 1fr;
  padding: 22px 24px;
  background: var(--ion-item-background);
}
.card-note .card-copy { padding: 0; background: transparent; }
.card-note .card-copy p + p { margin-top: 8px; }
.card-copy h3 { margin: 0 0 6px; font-size: 22px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.25; }
.card-copy p { margin: 0; }
.soon {
  display: inline-block;
  margin: 0 0 8px;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(0, 102, 214, .12);
  color: var(--link);
  font-size: 13px;
  font-weight: 600;
}
.diagram { margin: 0; padding: 8px; border-radius: 16px; background: #f2f2f7; color: #1c1c1e; }
.diagram svg { display: block; width: 100%; height: auto; }
.diagram figcaption { margin: 8px 4px 0; color: #3a3a3c; font-size: 13px; line-height: 1.45; }
.group { margin: 0; background: var(--ion-item-background); border-radius: 16px; overflow: hidden; }
.group > div { padding: 14px 16px; }
.group > div + div { border-top: 1px solid var(--sel-line); }
.group dt { margin: 0 0 4px; font-size: 17px; font-weight: 600; }
.group dd { margin: 0; color: var(--sel-muted); font-size: 15px; line-height: 1.5; }
footer { margin-top: 56px; color: var(--sel-muted); font-size: 15px; }
footer p { margin: 0 0 6px; }
@media (max-width: 860px) {
  .layout {
    grid-template-columns: 1fr;
    gap: 0;
    width: min(720px, calc(100% - 24px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
  }
  .sidenav { display: none; }
  .toc-disclosure { display: block; margin-top: 12px; }
  .toc-disclosure summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 44px;
    padding: 0 16px;
    border-radius: 14px;
    background: var(--ion-item-background);
    color: var(--ion-text-color);
    font-weight: 600;
    font-size: 16px;
    list-style: none;
    cursor: pointer;
  }
  .toc-disclosure summary::-webkit-details-marker { display: none; }
  .toc-disclosure summary::after {
    content: "";
    width: 8px;
    height: 8px;
    border-right: 2px solid var(--sel-muted);
    border-bottom: 2px solid var(--sel-muted);
    transform: rotate(45deg) translateY(-2px);
  }
  .toc-disclosure[open] summary::after { transform: rotate(225deg) translateY(-2px); }
  .toc-disclosure .toc {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 8px;
    padding: 6px;
    background: var(--ion-item-background);
    border-radius: 16px;
  }
  .toc-disclosure .toc a { min-height: 44px; }
  .hero { grid-template-columns: 1fr; gap: 18px; padding-top: 18px; }
  .device-hero { max-width: 340px; margin: 0 auto; }
  .section-head { margin-top: 40px; }
  .section-head h2 { font-size: 28px; }
  .cards { gap: 28px; }
  .card-copy { order: -1; padding: 18px; }
  .card,
  .card-wide,
  .cards > .card:nth-child(even):not(.card-wide):not(.card-note) { grid-template-columns: 1fr; }
  .cards > .card:nth-child(even):not(.card-wide):not(.card-note) .device { order: 0; }
  .card .device { order: 0; max-width: 340px; margin: 0 auto; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
}
</style>
</head>
<body>
<a class="skip" href="#start">跳到第一次用</a>
<header class="top">
  <a class="brand" href="/help/">超级错题本</a>
  <a class="cta" href="${STUDY_URL}register">去注册</a>
</header>
<div class="layout">
  <nav class="sidenav toc" aria-label="目录">${TOC_LINKS}</nav>
  <main>
    <details class="toc-disclosure">
      <summary>目录</summary>
      <nav class="toc" aria-label="目录">${TOC_LINKS}</nav>
    </details>

    <section class="hero" id="product">
      <div class="hero-copy">
        <p class="kicker">产品是什么</p>
        <h1>超级错题本</h1>
        <p class="lede">学生自己注册，拍一张批改过的卷子，做错的题就收进错题本。</p>
        <p class="quiet">家长只看到完成情况和掌握程度这些汇总，看不到题目，也看不到错因。目前支持数学、物理、化学。</p>
        <p class="hero-actions"><a class="cta" href="${STUDY_URL}register">去注册</a> <a href="${STUDY_URL}">已有邀请码，去登录</a></p>
      </div>
    </section>

    <section id="start">
      <div class="section-head">
        <p class="kicker">第一次用</p>
        <h2>三步就能开始</h2>
        <p data-testid="start-steps">打开注册页，填好 Name、手机号和找回码 → 把邀请码保存下来 → <strong>拍一张批改过的卷子</strong>。</p>
      </div>
      <div class="cards">
        ${card('register.webp', '注册页：Name、手机号、找回码，以及找回码跟手机号仅用于找回账户。', '注册', '打开 <a href="' + STUDY_URL + 'register">注册页</a>，填写 Name、手机号和找回码。页面上写着「找回码跟手机号仅用于找回账户」。已经有邀请码的，点「已有邀请码，直接登录」。')}
        ${card('register-done.webp', '注册成功页。邀请码已隐去，只在这一页完整显示一次。', '保存邀请码', '注册成功后会显示 12 位邀请码，只在这一页完整显示一次。请截图或点「复制邀请码」，不要发给别人。邀请码 60 天内可以反复登录。图里的邀请码已隐去。')}
        ${card('notebook-empty.webp', '错题本里点新增后的选择：单页、多页，然后开始。', '拍卷子', '点「新增」。一张纸用「单页」。试卷和答题卡不在同一页，用「多页」。再点「开始」。放平、拍全、光线均匀。')}
        ${card('intake-pick.webp', '录入页列出真实题目。这页没有批改痕迹，勾出做错的题再加入。', '收进错题本', '老师打了叉、或能看出批改痕迹的题，会自动收进来。这页看不出批改痕迹时，勾出做错的题，再点「加入」。认出来的字如果和照片不一样，以照片为准。')}
      </div>
      <p class="note">第一次进入会问初中还是高中。选好以后，错题按这个学段整理。</p>
    </section>

    <section id="use">
      <div class="section-head">
        <p class="kicker">经常用</p>
        <h2>看错题，放到桌面</h2>
        <p>收进来的题在错题本里，按章节和知识点排好。添加到手机桌面、换手机，都在这一节。</p>
      </div>
      <div class="cards">
        ${card('notebook-list.webp', '错题本列出真实题目，标题是章节，下面是题目原文。', '错题本', '点进一道题就能看整张原图和认出来的文字。右上角可以筛选，左下角可以搜索。')}
        ${card('item-detail.webp', '题目详情最上面是拍下的整张试卷，下面是这道题的原文。', '看整张原图', '最上面是你拍的整张照片，点开可以放大。字认错了，点「识别错了？改」，以照片为准。')}
        ${card('item-answer.webp', '详情下半：章节、知识点，以及正确答案。解答标着仅供参考。', '章节和答案', '章节与知识点写在题目下面。正确答案和解题过程标着「仅供参考」。也可以拍照录入答案，或在备注里打字、按一下说。')}
        ${card('item-menu.webp', '题目详情右上角菜单：修改分类、改题目文字、不是错题就移除。', '改错字或移出', '右上角「…」里可以修改分类，或改题目文字。这道不该在错题本里，点「不是错题，移除」。')}
        <article class="card card-note">
          <div class="card-copy">
            <h3>添加到手机桌面</h3>
            <p>错题本是网页，可以放到手机桌面上。请用系统浏览器打开，不要在微信里添加：微信里先点右上角「…」，选「在浏览器打开」或「在 Safari 中打开」。</p>
            <p class="url"><a href="${STUDY_URL}">${STUDY_URL}</a></p>
          </div>
        </article>
        <article class="card card-note">
          <div class="card-copy">
            <h3>iPhone（Safari）</h3>
            <p>1. 用 Safari 打开学习页。微信里打开的，先点右上角「…」，选「在 Safari 中打开」。</p>
            <p>2. 点屏幕下方的「分享」（方框里一个向上的箭头）。</p>
            <p>3. 往下找「添加到主屏幕」，点它，再点右上角「添加」。</p>
            <p>4. 以后从主屏幕上的「超级错题本」打开。如果又要登录，输入自己的邀请码，学习记录都在。</p>
          </div>
        </article>
        ${card('iphone-confirm.webp', 'iPhone 添加到主屏幕的确认页。名称是超级错题本，地址是学习页，作为网页 App 打开是开着的。', '确认添加', '名称是「超级错题本」，地址是 <a href="' + STUDY_URL + '">' + STUDY_URL + '</a>。「作为网页 App 打开」保持打开，再点右上角「添加」。')}
        ${card('iphone-home.webp', '主屏幕上的超级错题本图标。', '在主屏幕上找到它', '添加完成以后，主屏幕上会出现「超级错题本」。以后从这里打开。')}
        <article class="card card-note">
          <div class="card-copy">
            <h3>安卓（Chrome 或系统浏览器）</h3>
            <p>用 Chrome 或系统浏览器打开学习页并登录。菜单里点「添加到桌面」或「安装应用」。桌面图标会打开浏览器页面，这样拍照和从相册选图才能用。点了没反应时，换 Chrome 或系统浏览器再添加一次。</p>
          </div>
        </article>
        ${card('login.webp', '登录页：输入 12 位邀请码，点进入我的错题本。', '再次登录', '已经有邀请码的，打开 <a href="' + STUDY_URL + '">学习页</a>，输入邀请码，点「进入我的错题本」。短横线、空格、大小写都不用管。登录以后常用的话不用每次输。')}
      </div>
      <p class="note">没网时打不开新内容，已经传上去的都还在。</p>
    </section>

    <section id="faq">
      <div class="section-head">
        <p class="kicker">遇到问题</p>
        <h2>常见问题</h2>
      </div>
      <div class="cards">
        ${card('recover.webp', '找回页：用姓名、手机号和找回码换一个新的邀请码。', '忘了邀请码', '打开 <a href="' + STUDY_URL + 'recover">找回页</a>，用注册时的姓名、手机号和找回码换一个新码，学习记录都在，旧码作废。对不上时页面不会告诉你是哪一项错了。没设过找回码，或找回码也忘了，找老师。')}
      </div>
      <dl class="group">
        <div><dt>换手机</dt><dd>「设置 → 我的邀请码」里的登录链接和二维码，是给学生在新手机上再用自己的码，不是开学的第一步。用新手机的相机扫一下就能登录，也可以输入同一个邀请码。打开链接本身不算登录，要点「进入我的错题本」才算。学习记录都在。</dd></div>
        <div><dt>忘了邀请码</dt><dd>打开 <a href="${STUDY_URL}recover">${STUDY_URL}recover</a>，用注册时的姓名、手机号和找回码换一个新码，记录都在，旧码作废。没设过找回码，或找回码也忘了，找老师。</dd></div>
        <div><dt>打不开相册</dt><dd>安卓上如果桌面图标打开的是一个没有文件选择器的壳，点相册没反应。改用 Chrome 或系统浏览器打开学习页再拍。小米、红米请点页面上的相册入口。</dd></div>
        <div><dt>识别错了</dt><dd>题目详情里点「识别错了？改」，或右上角「…」→「改题目文字」。以照片为准。</dd></div>
        <div><dt>不是错题</dt><dd>题目详情右上角「…」→「不是错题，移除」。录入页里不相关的题可以左滑删除。</dd></div>
        <div><dt>重复照片</dt><dd>同一张图只保存一次。微信里如果选不了相册，先换到系统浏览器或 Safari 再拍。</dd></div>
        <div><dt>微信里打开</dt><dd>可以先看。添加到桌面和选相册时，点右上角「…」，选「在浏览器打开」（iPhone 上叫「在 Safari 中打开」），再登录一次。登录页上有「复制网址」按钮，粘到浏览器地址栏也行。</dd></div>
      </dl>
    </section>

    <section id="contact">
      <div class="section-head">
        <p class="kicker">联系</p>
        <h2>联系方式</h2>
      </div>
      ${contactHtml(contact)}
    </section>

    <footer>
      <p><a href="${GITHUB_URL}">代码仓库</a></p>
      <p class="url"><a href="${GITHUB_URL}">${GITHUB_URL}</a></p>
      <p>超级错题本 · Super Error Log</p>
      <p>说明页里的题目来自真实试卷，已隐去姓名、学校、手机号和邀请码。</p>
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
  response.setHeader('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  response.setHeader('cache-control', 'public, max-age=300');
  response.removeHeader('pragma');
  response.send(helpPortalHtml(readHelpContact()));
}

function sendHelpImage(request: Request, response: Response, next: NextFunction): void {
  const raw = request.params.name;
  const name = typeof raw === 'string' ? raw : '';
  const bytes = readHelpImage(name);
  if (!bytes) { next(); return; }
  response.status(200);
  response.setHeader('content-type', 'image/webp');
  response.setHeader('cache-control', 'public, max-age=86400');
  response.setHeader('x-content-type-options', 'nosniff');
  response.removeHeader('pragma');
  response.send(bytes);
}

/**
 * 挂在 404 之前。只认路径 /help、/help/ 与 /help/img/<白名单>.webp，不认 Host。
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
  app.get('/help/img/:name', sendHelpImage);
  app.get('/help', serve);
  app.get('/help/', serve);
}
