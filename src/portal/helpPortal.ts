/**
 * 公开产品说明页，地址 https://study.pccoding666.com/help/ 。
 * 与学生应用同一进程、同一端口，按路径区分，不看 Host：
 * GET /help/ 返回本页，GET /help 301 到 /help/（查询串保留）。
 * GET /help/img/<name>.webp 返回说明页用的合成示例图（无学生数据），可缓存。
 * study.pccoding666.com 的 GET / 仍是 404；/s、/v1、/v2、/admin 不在这里处理。
 * help.pccoding666.com 子域名暂不使用（DNS 仍是 NXDOMAIN）。不要再按主机名把 GET / 换成这一页。
 * 页面是静态文案。发布包只带 dist/，HTML 随 tsc 编译进去；图片在构建时复制到 dist/portal/help-img/。
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

/** 说明页允许下发的合成示例图。名字固定，拒绝其它路径。 */
export const HELP_GUIDE_IMAGES = [
  'notebook-empty.webp',
  'notebook-list.webp',
  'intake-auto.webp',
  'intake-pick.webp',
  'item-detail.webp',
  'item-menu.webp',
  'item-answer.webp',
  'login.webp',
  'register.webp',
  'register-done.webp',
  'recover.webp',
  'stage.webp',
  'settings.webp',
  'account.webp',
  'install.webp',
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

/** 一步一张卡：手机框里的合成示例图，配一两句说明。 */
function card(file: string, alt: string, title: string, text: string): string {
  return `<article class="card"><figure class="device"><img src="/help/img/${file}" width="390" height="844" alt="${alt}" loading="lazy" decoding="async"></figure><div class="card-copy"><h3>${title}</h3><p>${text}</p></div></article>`;
}

const TOC_LINKS = `<a href="#product">产品是什么</a><a href="#start">注册与登录</a><a href="#home">添加到手机桌面</a><a href="#capture">怎么拍照</a><a href="#pick">怎么选错题</a><a href="#practice">练习</a><a href="#faq">常见问题</a><a href="#contact">联系方式</a>`;

const ANDROID_DIAGRAM = `<figure class="diagram">
<svg viewBox="0 0 640 300" role="img" aria-labelledby="android-diagram-title">
  <title id="android-diagram-title">安卓浏览器菜单示意图</title>
  <rect x="8" y="8" width="176" height="284" rx="22" fill="#fff" stroke="#eaeaea"/>
  <rect x="20" y="24" width="152" height="28" rx="6" fill="#f6f6f6"/>
  <text x="32" y="43" font-size="13" fill="#171717">错题本</text>
  <circle cx="148" cy="38" r="2.4" fill="#171717"/><circle cx="156" cy="38" r="2.4" fill="#171717"/><circle cx="164" cy="38" r="2.4" fill="#171717"/>
  <text x="32" y="90" font-size="12" fill="#4d4d4d">学习页已打开</text>
  <path d="M188 38h36" stroke="#0066d6" stroke-width="1.5" marker-end="url(#arrow)"/>
  <rect x="240" y="48" width="220" height="168" rx="14" fill="#fff" stroke="#eaeaea"/>
  <text x="258" y="84" font-size="16" fill="#171717">添加到桌面</text>
  <line x1="258" y1="100" x2="442" y2="100" stroke="#eaeaea"/>
  <text x="258" y="132" font-size="16" fill="#171717">安装应用</text>
  <line x1="258" y1="148" x2="442" y2="148" stroke="#eaeaea"/>
  <text x="258" y="180" font-size="16" fill="#6e6e73">刷新</text>
  <text x="480" y="92" font-size="14" fill="#4d4d4d">菜单</text>
  <text x="480" y="116" font-size="13" fill="#666">字可能是</text>
  <text x="480" y="136" font-size="13" fill="#666">上面两种</text>
  <text x="480" y="156" font-size="13" fill="#666">里的一种</text>
  <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#0066d6"/></marker></defs>
</svg>
<figcaption>示意图。小米、红米自带浏览器和 Chrome 的菜单位置不一样，不是真机截图。</figcaption>
</figure>`;

const IPHONE_DIAGRAM = `<figure class="diagram">
<svg viewBox="0 0 640 300" role="img" aria-labelledby="iphone-diagram-title">
  <title id="iphone-diagram-title">iPhone Safari 添加到主屏幕示意图</title>
  <rect x="8" y="8" width="176" height="284" rx="22" fill="#fff" stroke="#eaeaea"/>
  <text x="32" y="40" font-size="13" fill="#171717">Safari</text>
  <rect x="20" y="250" width="152" height="28" rx="8" fill="#f6f6f6"/>
  <path d="M96 258 v12 M90 264 h12" stroke="#0066d6" stroke-width="1.6" fill="none"/>
  <rect x="70" y="266" width="14" height="12" rx="2" fill="none" stroke="#0066d6" stroke-width="1.6"/>
  <path d="M188 268h36" stroke="#0066d6" stroke-width="1.5"/>
  <rect x="240" y="36" width="230" height="220" rx="16" fill="#fff" stroke="#eaeaea"/>
  <text x="258" y="68" font-size="14" fill="#6e6e73">分享</text>
  <rect x="256" y="84" width="198" height="40" rx="8" fill="#f3f8ff" stroke="#c5ddff"/>
  <text x="270" y="109" font-size="16" fill="#171717">添加到主屏幕</text>
  <text x="258" y="156" font-size="15" fill="#4d4d4d">拷贝</text>
  <text x="258" y="186" font-size="15" fill="#4d4d4d">加入阅读列表</text>
  <text x="490" y="100" font-size="14" fill="#4d4d4d">点这一行</text>
  <text x="490" y="124" font-size="13" fill="#666">再点右上角</text>
  <text x="490" y="144" font-size="13" fill="#666">「添加」</text>
</svg>
<figcaption>示意图。方框加向上箭头是 Safari 下方的「分享」。不是真机截图。</figcaption>
</figure>`;

export function helpPortalHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f2f2f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<meta name="description" content="超级错题本使用说明：注册登录、拍照收错题、查看详情。">
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
body:has(#product:target) .toc a[href="#product"],
body:has(#start:target) .toc a[href="#start"],
body:has(#home:target) .toc a[href="#home"],
body:has(#capture:target) .toc a[href="#capture"],
body:has(#pick:target) .toc a[href="#pick"],
body:has(#practice:target) .toc a[href="#practice"],
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
  grid-template-columns: minmax(0, 1fr) minmax(260px, 400px);
  gap: 28px 40px;
  align-items: center;
  padding: 28px 0 8px;
  scroll-margin-top: 72px;
}
.lede { margin: 0; max-width: 22em; font-size: 20px; line-height: 1.45; }
.quiet, .note { margin: 12px 0 0; color: var(--sel-muted); font-size: 15px; line-height: 1.5; }
.hero-actions { margin: 22px 0 0; }
.shot-note { margin: 10px 0 0; color: var(--sel-muted); font-size: 14px; line-height: 1.4; text-align: center; }
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
<a class="skip" href="#product">跳到正文</a>
<header class="top">
  <a class="brand" href="/help/">超级错题本</a>
  <a class="cta" href="${STUDY_URL}">开始使用</a>
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
        <p class="lede">把卷子上做错的题收进错题本，需要时再拿出来看。照片里的题目由 AI 抽出，建议也由 AI 给出，最后保存什么由你决定。</p>
        <p class="quiet">家长只看到完成情况和掌握程度这些汇总，看不到题目，也看不到错因。目前支持数学、物理、化学。</p>
        <p class="hero-actions"><a class="cta" href="${STUDY_URL}">开始使用</a></p>
      </div>
      <div class="hero-visual">
        <figure class="device device-hero">
          <img src="/help/img/notebook-list.webp" width="390" height="844" alt="合成浏览器示例，不是系统相机或相册。错题本按学科列出收进来的题，右上角可以筛选，左下角可以搜索。" loading="eager" fetchpriority="high" decoding="async">
        </figure>
        <p class="shot-note">合成浏览器示例，不是系统相机或相册。题按学科列在错题本里，右上角可以筛选，左下角可以搜索。右下角只有拍照和相册。</p>
      </div>
    </section>

    <section id="start">
      <div class="section-head">
        <p class="kicker">开始使用</p>
        <h2>注册与登录</h2>
        <p>用邀请码进入自己的错题本。没有密码，也不发短信。</p>
      </div>
      <div class="cards">
        ${card('register.webp', '合成示例。注册页：姓名、手机号和 4 位找回码', '注册', '打开 <a href="' + STUDY_URL + 'register">注册页</a>，填姓名和手机号，自己设一个 4 位数字找回码（不要用 1234、0000 这种）。老师给了班级注册码才会多出这一格；不用密码，也不发短信，姓名可以写化名，手机号可以填家长的。')}
        ${card('register-done.webp', '合成示例。注册成功页，邀请码只完整显示这一次', '保存邀请码', '注册成功后会显示你的 12 位邀请码，只在这一页完整显示一次。请截图或点「复制邀请码」，不要发给别人；邀请码 60 天内可以反复登录。')}
        ${card('stage.webp', '合成示例。第一次选择初中或高中', '选学段', '第一次进入会问初中还是高中，以后可以在设置里改。错题按这个学段整理章节，目前只支持数学、物理、化学。')}
        ${card('login.webp', '合成示例。输入 12 位邀请码的登录页', '登录', '打开 <a href="' + STUDY_URL + '">学习页</a>，输入邀请码，点「进入我的错题本」。短横线、空格、大小写都不用管，登录后常用的话不用每次输。')}
        ${card('settings.webp', '合成示例。设置页：学段、练习即将推出、添加到主屏幕、我的邀请码', '设置', '登录后打开设置，可以改学段，也能进入「我的邀请码」。练习一行写着「即将推出」。')}
        ${card('account.webp', '合成示例。我的邀请码页面，可以复制或重新生成', '查看或换邀请码', '在「设置 → 我的邀请码」可以查看、复制，或重新生成。重新生成后旧码立刻作废，其他设备要用新码登录，学习记录都在；快到期时设置页会提醒你换码。')}
      </div>
    </section>

    <section id="home">
      <div class="section-head">
        <p class="kicker">放到桌面</p>
        <h2>添加到手机桌面</h2>
        <p>错题本是网页，带了主屏幕清单、图标和离线壳。请用系统浏览器打开，不要在微信里添加：微信里先点右上角「…」，选「在浏览器打开」或「在 Safari 中打开」。</p>
        <p class="url"><a href="${STUDY_URL}">${STUDY_URL}</a></p>
      </div>
      <div class="cards">
        ${card('install.webp', '合成示例。设置里的添加到主屏幕说明，只写了 Safari', '应用里的说明', '设置里也有一页「添加到主屏幕」，目前只写了 iPhone Safari 的步骤。')}
        <article class="card card-wide">
          ${ANDROID_DIAGRAM}
          <div class="card-copy">
            <h3>安卓（小米、红米浏览器和 Chrome）</h3>
            <p>用自带浏览器或 Chrome 打开学习页并登录，在菜单里点「添加到桌面」或「安装应用」，图标名是「错题本」。安卓上的清单故意用浏览器方式打开（manifest 的 display 是 browser），桌面图标会进浏览器标签，这样点相册和拍照时系统选择器才能弹出来；如果某个壳打不开相册，改用 Chrome 或系统浏览器再添加一次。</p>
          </div>
        </article>
        <article class="card card-wide">
          ${IPHONE_DIAGRAM}
          <div class="card-copy">
            <h3>iPhone（Safari）</h3>
            <p>必须用 Safari：点屏幕下方的「分享」（方框加向上箭头），往下找「添加到主屏幕」，再点右上角「添加」，图标名是「错题本」。iPhone 上清单是独立应用方式（display 为 standalone，页面也标记了可添加到主屏幕），从主屏幕打开是全屏；如果又要你登录，输入自己的邀请码，学习记录都在。</p>
          </div>
        </article>
      </div>
      <p class="note">清单地址是 /s/manifest.webmanifest，图标和名称都是「错题本」。Service Worker 只缓存页面外壳，不缓存你的错题和照片；没网时打不开新内容，已经传上去的都在服务器上。</p>
    </section>

    <section id="capture">
      <div class="section-head">
        <p class="kicker">拍照</p>
        <h2>怎么拍照</h2>
        <p>登录后的错题本右下角有两个圆钮：上面是拍照，下面是相册。还没有错题时，中间也有「去拍照」和「从相册选择」。录入页底部同样有拍照和相册。下面的图是浏览器里的合成界面，不是手机系统相机或相册。浏览时入口旁边不放「单页 / 多页」；点拍照或相册之后再选。</p>
      </div>
      <div class="cards">
        ${card('notebook-empty.webp', '合成浏览器示例，不是系统相机或相册。空错题本只有拍照和相册', '选拍摄模式', '点拍照或相册之后再选这一次是单页还是多页。「单页」拍一张或从相册选图后立刻上传；相册仍可一次选多张，每张按单独一页处理。「多页」适合一套卷子有好几页：先留在预览条里，可标「试卷」或「答题卡」，可删掉某一张，点「完成」后整组一起上传，一次最多 8 页；点「放弃这组」会清空还没传的预览。这组还在的时候，预览旁边可以改回单页；改回之后拍照和相册先停用，要点「完成」或「放弃这组」才能再拍。')}
        ${card('intake-auto.webp', '合成浏览器示例，不是系统相机或相册。录入页底部是拍照和从相册选择', '拍卷子', '拍题目、你的作答、老师的批改和答案页，放平、拍全、光线均匀，顺序不限，之后还能补拍。选好后进入「录入」，AI 在后台找题，不用一直停在这一页；传完点「完成」回到错题本，录入页还可以按上传日筛选。录入页空着的时候也不常驻单页 / 多页，点拍照或相册后再选。')}
      </div>
      <p class="note">同一张图只保存一次。微信里如果选不了相册，先换到系统浏览器或 Safari 再拍。小米、红米手机点相册圆钮或「从相册选择」，再点「单页」或「多页」，即可选图。</p>
    </section>

    <section id="pick">
      <div class="section-head">
        <p class="kicker">收题</p>
        <h2>怎么选错题</h2>
        <p>收进来的题按学科列在错题本里，右上角可以筛选，左下角可以搜索。</p>
      </div>
      <div class="cards">
        ${card('intake-pick.webp', '合成浏览器示例，不是系统相机或相册。录入页勾出没有批改痕迹的题，底部是拍照和从相册选择', '收进错题本', '老师打了叉、或能看出批改痕迹的题会自动收进来，录入页写着「已加入错题本」；不相关的，在那一行上左滑，点「删除」。这页没有批改痕迹时，页面写「勾出做错的题」，做错或没把握的勾上，再点「加入 N 道」，做对的不用勾。')}
        ${card('item-detail.webp', '合成示例。题目详情，上面是整张原图', '看整张原图', '在错题本点进题目，最上面是你拍的整张照片，点开可以放大，下面是识别出的题目文字。字认错了，点「识别错了？改」，以照片为准。')}
        ${card('item-menu.webp', '合成示例。题目详情右上角菜单：改题目文字、不是错题', '改错字或移出', '右上角「…」里可以修改分类，或改题目文字。这道不该在错题本里，点「不是错题，移除」。')}
        ${card('item-answer.webp', '合成示例。详情下半：章节、正确答案、错因备注', '答案和备注', '详情往下还有你写的、批改痕迹、章节与知识点、正确答案和错因备注。可以拍照录入答案，也可以打字或按一下说；AI 给出的答案和解题过程标为仅供参考。')}
      </div>
    </section>

    <section id="practice">
      <div class="section-head">
        <p class="kicker">还没开放</p>
        <h2>练习</h2>
      </div>
      <article class="card card-note">
        <div class="card-copy">
          <p class="soon">即将推出</p>
          <p>设置里的「练习」一行写着「即将推出」。当前学生端没有练习入口，也不提供打印练习、纸上记结果或拍照交练习。注册与登录里的设置截图可以看到这一行。</p>
        </div>
      </article>
    </section>

    <section id="faq">
      <div class="section-head">
        <p class="kicker">答疑</p>
        <h2>常见问题</h2>
      </div>
      <div class="cards">
        ${card('recover.webp', '合成示例。用姓名、手机号和找回码找回邀请码', '忘了邀请码', '打开 <a href="' + STUDY_URL + 'recover">找回页</a>，用注册时的姓名、手机号和找回码换一个新码，学习记录都在，旧码作废。对不上时页面不会告诉你是哪一项错了；没设过找回码，或找回码也忘了，找老师重发。')}
      </div>
      <dl class="group">
        <div><dt>换手机</dt><dd>用同一个邀请码在新手机登录，学习记录都在。</dd></div>
        <div><dt>忘了邀请码</dt><dd>打开 <a href="${STUDY_URL}recover">${STUDY_URL}recover</a>，用注册时的姓名、手机号和找回码换一个新码，记录都在，旧码作废。没设过找回码，或找回码也忘了，找老师重发。</dd></div>
        <div><dt>打不开相册</dt><dd>安卓上如果桌面图标打开的是一个没有文件选择器的壳，点相册没反应。改用 Chrome 或系统浏览器打开学习页再拍。小米、红米请点页面上的相册入口。</dd></div>
        <div><dt>AI 认错字</dt><dd>题目详情里点「识别错了？改」，或右上角「…」→「改题目文字」。以照片为准。</dd></div>
        <div><dt>不是错题</dt><dd>题目详情右上角「…」→「不是错题，移除」。录入页里不相关的题可以左滑删除。</dd></div>
        <div><dt>重复照片</dt><dd>同一张图只保存一次。</dd></div>
        <div><dt>微信里打开</dt><dd>可以先看，但添加到桌面和相册都更稳妥的做法是：点右上角「…」，在系统浏览器或 Safari 里打开，再用邀请码登录一次。</dd></div>
      </dl>
    </section>

    <section id="contact">
      <div class="section-head">
        <p class="kicker">联系</p>
        <h2>联系方式</h2>
      </div>
      <dl class="group">
        <div><dt>邮箱</dt><dd>待补充</dd></div>
        <div><dt>微信</dt><dd>待补充</dd></div>
      </dl>
    </section>

    <footer>
      <p><a href="${GITHUB_URL}">GitHub</a></p>
      <p class="url"><a href="${GITHUB_URL}">${GITHUB_URL}</a></p>
      <p>超级错题本 · Super Error Log</p>
      <p>配图为合成示例，不含学生数据。</p>
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
  response.send(helpPortalHtml());
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
