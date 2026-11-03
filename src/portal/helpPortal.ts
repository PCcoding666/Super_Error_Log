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
  'practice-home.webp',
  'practice-question.webp',
  'practice-print.webp',
  'practice-record.webp',
  'practice-submit.webp',
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

function shot(file: string, alt: string, caption: string): string {
  return `<figure class="shot"><img src="/help/img/${file}" width="390" height="844" alt="${alt}" loading="lazy" decoding="async"><figcaption>${caption}</figcaption></figure>`;
}

const ANDROID_DIAGRAM = `<figure class="diagram">
<svg viewBox="0 0 640 300" role="img" aria-labelledby="android-diagram-title">
  <title id="android-diagram-title">安卓浏览器菜单示意图</title>
  <rect x="8" y="8" width="176" height="284" rx="22" fill="#fff" stroke="#eaeaea"/>
  <rect x="20" y="24" width="152" height="28" rx="6" fill="#f6f6f6"/>
  <text x="32" y="43" font-size="13" fill="#171717">错题本</text>
  <circle cx="148" cy="38" r="2.4" fill="#171717"/><circle cx="156" cy="38" r="2.4" fill="#171717"/><circle cx="164" cy="38" r="2.4" fill="#171717"/>
  <text x="32" y="90" font-size="12" fill="#4d4d4d">学习页已打开</text>
  <path d="M188 38h36" stroke="#0070f3" stroke-width="1.5" marker-end="url(#arrow)"/>
  <rect x="240" y="48" width="220" height="168" rx="14" fill="#fff" stroke="#eaeaea"/>
  <text x="258" y="84" font-size="16" fill="#171717">添加到桌面</text>
  <line x1="258" y1="100" x2="442" y2="100" stroke="#eaeaea"/>
  <text x="258" y="132" font-size="16" fill="#171717">安装应用</text>
  <line x1="258" y1="148" x2="442" y2="148" stroke="#eaeaea"/>
  <text x="258" y="180" font-size="16" fill="#888">刷新</text>
  <text x="480" y="92" font-size="14" fill="#4d4d4d">菜单</text>
  <text x="480" y="116" font-size="13" fill="#666">字可能是</text>
  <text x="480" y="136" font-size="13" fill="#666">上面两种</text>
  <text x="480" y="156" font-size="13" fill="#666">里的一种</text>
  <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#0070f3"/></marker></defs>
</svg>
<figcaption>示意图。小米、红米自带浏览器和 Chrome 的菜单位置不一样，不是真机截图。</figcaption>
</figure>`;

const IPHONE_DIAGRAM = `<figure class="diagram">
<svg viewBox="0 0 640 300" role="img" aria-labelledby="iphone-diagram-title">
  <title id="iphone-diagram-title">iPhone Safari 添加到主屏幕示意图</title>
  <rect x="8" y="8" width="176" height="284" rx="22" fill="#fff" stroke="#eaeaea"/>
  <text x="32" y="40" font-size="13" fill="#171717">Safari</text>
  <rect x="20" y="250" width="152" height="28" rx="8" fill="#f6f6f6"/>
  <path d="M96 258 v12 M90 264 h12" stroke="#0070f3" stroke-width="1.6" fill="none"/>
  <rect x="70" y="266" width="14" height="12" rx="2" fill="none" stroke="#0070f3" stroke-width="1.6"/>
  <path d="M188 268h36" stroke="#0070f3" stroke-width="1.5"/>
  <rect x="240" y="36" width="230" height="220" rx="16" fill="#fff" stroke="#eaeaea"/>
  <text x="258" y="68" font-size="14" fill="#888">分享</text>
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
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="超级错题本使用说明：注册登录、拍照收错题、打印练习、记录结果。">
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
aside{position:sticky;top:64px;height:calc(100vh - 64px);padding:32px 24px 48px 28px;border-right:1px solid var(--line);overflow:auto}
.side-label{margin:0 0 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--faint);letter-spacing:.06em}
aside a{display:block;padding:7px 0;color:var(--muted);font-size:14px}
aside a:hover{color:var(--ink);text-decoration:none}
body:has(#product:target) a[href="#product"],
body:has(#home:target) a[href="#home"],
body:has(#start:target) a[href="#start"],
body:has(#capture:target) a[href="#capture"],
body:has(#pick:target) a[href="#pick"],
body:has(#practice:target) a[href="#practice"],
body:has(#faq:target) a[href="#faq"],
body:has(#contact:target) a[href="#contact"]{color:var(--ink);font-weight:600}
main{max-width:760px;padding:72px 56px 96px}
h1{margin:0 0 16px;font-size:44px;line-height:1.15;font-weight:600;letter-spacing:-.04em}
.lede{margin:0;max-width:38em;color:var(--muted);font-size:20px;line-height:1.6}
h2{margin:72px 0 16px;font-size:28px;line-height:1.3;font-weight:600;letter-spacing:-.03em;scroll-margin-top:88px}
h2 .num{margin-right:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;font-weight:400;color:var(--faint);letter-spacing:0}
h3{margin:28px 0 8px;font-size:18px;font-weight:600;letter-spacing:-.02em}
p{margin:0 0 16px}
.quiet{color:var(--muted)}
ol.steps{list-style:none;margin:8px 0 0;padding:0}
ol.steps li{padding:22px 0;border-top:1px solid var(--line)}
ol.steps strong{display:block;margin-bottom:4px;font-size:18px;font-weight:600;letter-spacing:-.02em}
ol.steps strong span{margin-right:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;font-weight:400;color:var(--faint)}
.cta{display:inline-flex;align-items:center;min-height:44px;margin:8px 0 16px;padding:0 18px;border-radius:8px;background:#000;color:#fff;font-weight:500}
.cta:hover{background:#333;text-decoration:none}
.url{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px}
dl.contact,dl.faq{margin:8px 0 0;border-top:1px solid var(--line)}
dl.contact div,dl.faq div{display:grid;grid-template-columns:8em 1fr;gap:16px;padding:14px 0;border-bottom:1px solid var(--line)}
dl.contact dt,dl.faq dt{margin:0;color:var(--muted)}
dl.contact dd,dl.faq dd{margin:0}
dl.contact dd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px}
figure.shot,figure.diagram{margin:8px 0 22px}
figure.shot img{display:block;width:min(100%,280px);height:auto;border:1px solid var(--line);border-radius:28px;background:#f6f6f6}
figure.diagram svg{display:block;width:min(100%,560px);height:auto}
figcaption{margin-top:8px;color:var(--faint);font-size:13px;line-height:1.5}
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
  dl.contact div,dl.faq div{grid-template-columns:6.5em 1fr}
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
      <a href="#home">添加到手机桌面</a>
      <a href="#start">注册与登录</a>
      <a href="#capture">怎么拍照</a>
      <a href="#pick">怎么选错题</a>
      <a href="#practice">练习</a>
      <a href="#faq">常见问题</a>
      <a href="#contact">联系方式</a>
    </nav>
  </aside>
  <main>
    <h1>超级错题本</h1>
    <p class="lede">把卷子上做错的题收好，隔几天在纸上再做一遍。</p>

    <h2 id="product"><span class="num">01</span>产品是什么</h2>
    <p>超级错题本帮你把做错的题收好，打印出来再做一遍，记下结果，直到真的会了。</p>
    <p class="quiet">照片里的题目由 AI 抽出，建议也由 AI 给出，最后保存什么由你决定。家长只看到完成情况和掌握程度这些汇总，看不到题目，也看不到错因。</p>
    <p>用手机浏览器打开学习页。目前支持数学、物理、化学。第一次进入会问你读初中还是高中，以后可以在设置里改。</p>

    <h2 id="home"><span class="num">02</span>添加到手机桌面</h2>
    <p>错题本是网页，同时带了主屏幕用的清单（Web App Manifest）、图标和离线壳。学习页地址：</p>
    <p class="url"><a href="${STUDY_URL}">${STUDY_URL}</a></p>
    <p>请用系统浏览器打开，不要在微信里添加。微信里先点右上角「…」，选「在浏览器打开」或「在 Safari 中打开」。设置里也有一页「添加到主屏幕」，写的是 iPhone 的步骤。</p>
    ${shot('install.webp', '设置里的添加到主屏幕说明，只写了 Safari', '合成示例。这是应用里「设置 → 添加到主屏幕」打开的页面，目前只写了 iPhone Safari。')}

    <h3>安卓（小米、红米浏览器和 Chrome）</h3>
    <ol class="steps">
      <li><strong><span>01</span>用浏览器打开</strong>小米、红米用自带浏览器或 Chrome，打开上面的学习页并登录。</li>
      <li><strong><span>02</span>打开菜单</strong>自带浏览器一般在菜单里找「添加到桌面」。Chrome 点右上角「⋮」，找「添加到主屏幕」；如果写成「安装应用」，点它也行。</li>
      <li><strong><span>03</span>从桌面图标打开</strong>图标名是「错题本」。安卓上的清单故意用浏览器方式打开（manifest 的 display 是 browser），桌面图标会进浏览器标签，不会变成一个单独的全屏壳。这样点相册和拍照时，系统选择器才能弹出来。如果某个「添加到桌面」的壳打不开相册，改用 Chrome 或系统浏览器打开学习页，再添加一次。</li>
    </ol>
    ${ANDROID_DIAGRAM}

    <h3>iPhone（Safari）</h3>
    <ol class="steps">
      <li><strong><span>01</span>用 Safari 打开</strong>必须是 Safari。微信里先点右上角「…」→「在 Safari 中打开」。</li>
      <li><strong><span>02</span>分享</strong>点屏幕下方的「分享」（方框里一个向上的箭头）。</li>
      <li><strong><span>03</span>添加到主屏幕</strong>往下找「添加到主屏幕」，点它，再点右上角「添加」。图标名是「错题本」。</li>
      <li><strong><span>04</span>以后从图标打开</strong>iPhone 上清单是独立应用方式（display 为 standalone，页面也标记了可添加到主屏幕）。从主屏幕打开是全屏，像一个 App。如果又要你登录，输入自己的邀请码，学习记录都在。</li>
    </ol>
    ${IPHONE_DIAGRAM}
    <p class="quiet">清单地址是 /s/manifest.webmanifest，图标和名称都是「错题本」。Service Worker 只缓存页面外壳，不缓存你的错题和照片。没网时打不开新内容；已经传上去的都在服务器上。</p>

    <h2 id="start"><span class="num">03</span>注册与登录</h2>
    <ol class="steps">
      <li><strong><span>01</span>注册</strong>用手机浏览器打开 <a href="${STUDY_URL}register">${STUDY_URL}register</a>，填姓名和手机号，自己设一个 4 位数字找回码（不要用 1234、0000 这种）。老师给了班级注册码的，页面上会出现这一格，一并填上；没给就没有这一格，不用找。不用密码，也不发短信。姓名可以写化名，手机号可以填家长的。</li>
      <li><strong><span>02</span>保存邀请码</strong>注册成功后会显示你的 12 位邀请码，只在这一页完整显示一次，请截图或点「复制邀请码」，不要发给别人。邀请码 60 天内可以反复登录。</li>
      <li><strong><span>03</span>选学段</strong>第一次进入会问初中还是高中。错题按这个学段整理章节。目前只支持数学、物理、化学。</li>
      <li><strong><span>04</span>登录</strong>打开 <a href="${STUDY_URL}">${STUDY_URL}</a>，输入邀请码，点「进入我的错题本」。短横线、空格、大小写都不用管。登录后常用的话不用每次输。</li>
      <li><strong><span>05</span>查看或换邀请码</strong>登录后打开「设置 → 我的邀请码」，可以查看、复制，或重新生成。重新生成后旧码立刻作废，其他设备要再用新码登录，学习记录都在。快到期时设置页会提醒你换码。</li>
    </ol>
    ${shot('register.webp', '注册页：姓名、手机号、4 位找回码', '合成示例。注册页。老师发了班级注册码时，姓名上面会多出一格。')}
    ${shot('register-done.webp', '注册成功页，邀请码只显示这一次', '合成示例。图里的邀请码是临时编出来的，不能用来登录。请保存你自己的那一串。')}
    ${shot('stage.webp', '第一次选择初中或高中', '合成示例。第一次进入时选学段。')}
    ${shot('login.webp', '输入 12 位邀请码的登录页', '合成示例。登录页。短横线和空格可以保留。')}
    ${shot('settings.webp', '设置页：学段、添加到主屏幕、我的邀请码', '合成示例。登录后的设置。练习一行写着「即将推出」，账号一节里有「我的邀请码」。')}
    ${shot('account.webp', '我的邀请码页面，可以复制或重新生成', '合成示例。图里的邀请码不能用来登录。重新生成后旧码作废。')}
    <p><a class="cta" href="${STUDY_URL}">开始使用</a></p>
    <p class="url"><a href="${STUDY_URL}">${STUDY_URL}</a></p>

    <h2 id="capture"><span class="num">04</span>怎么拍照</h2>
    <p>登录后的错题本右下角有两个圆钮：上面是拍照，下面是相册。还没有错题时，中间也有「去拍照」和「从相册选择」。录入页底部同样有这两个入口。</p>
    <ol class="steps">
      <li><strong><span>01</span>拍卷子</strong>拍题目、你的作答、老师的批改和答案页，顺序不限，之后还能补拍。一页拍一张，放平、拍全、光线均匀。相册可以一次选多张。小米、红米手机点相册圆钮或「从相册选择」即可选图。</li>
      <li><strong><span>02</span>等它找题</strong>选好后会进入「录入」。照片已经在传，AI 在后台找题，不用一直停在这一页。传完点「完成」回到错题本。</li>
    </ol>
    ${shot('notebook-empty.webp', '空错题本，有去拍照和从相册选择', '合成示例。还没有错题时的错题本。右下角圆钮和中间两个按钮都能拍照或选相册。')}
    ${shot('intake-auto.webp', '录入页，底部有拍照和从相册选择', '合成示例。录入页底部可以继续拍照或从相册补一张。')}
    <p class="quiet">同一张图只保存一次。微信里如果选不了相册，先换到系统浏览器或 Safari 再拍。</p>

    <h2 id="pick"><span class="num">05</span>怎么选错题</h2>
    <ol class="steps">
      <li><strong><span>01</span>收进错题本</strong>老师打了叉、或能看出批改痕迹的题，会自动收进来。录入页写着「已加入错题本」。不相关的，在那一行上左滑，点「删除」。</li>
      <li><strong><span>02</span>自己勾</strong>这页没有批改痕迹时，页面写「勾出做错的题」。做错或没把握的勾上，再点「加入 N 道」。做对的不用勾。</li>
      <li><strong><span>03</span>看整张原图</strong>在错题本点进题目。详情最上面是你拍的整张照片，点开可以放大。下面是识别出的题目文字。</li>
      <li><strong><span>04</span>改错字或移出</strong>字认错了，点「识别错了？改」，或右上角「…」里的「改题目文字」。以照片为准。这道不该在错题本里，点「…」里的「不是错题，移除」。详情往下还有你写的、批改痕迹、章节与知识点、正确答案（可拍照录入答案）和错因备注（可以打字，也可以按一下说）。</li>
    </ol>
    ${shot('intake-pick.webp', '录入页：打叉的题已加入，没批改的题可以勾选', '合成示例。上面几道已自动加入；下面没有批改痕迹的，勾上后点「加入 1 道」。')}
    ${shot('notebook-list.webp', '错题本列表', '合成示例。收进来的题按学科列在错题本里。右上角可以筛选，左下角可以搜索。')}
    ${shot('item-detail.webp', '题目详情，上面是整张原图', '合成示例。详情页展示整张原图，题干旁边可以改识别结果。')}
    ${shot('item-menu.webp', '题目详情右上角菜单：改题目文字、不是错题', '合成示例。右上角「…」：修改分类、改题目文字、不是错题就移除。')}
    ${shot('item-answer.webp', '详情下半：章节、正确答案、错因备注', '合成示例。可以拍照录入答案，也可以自己写或说出备注。AI 给出的答案和解题过程标为仅供参考。')}

    <h2 id="practice"><span class="num">06</span>练习：打印、纸上做、记结果</h2>
    <p>错题本首页的「设置」里，练习一行写着「即将推出」，这一页没有练习标签。练习页仍然可以打开：登录后访问 <a href="${STUDY_URL}practices">${STUDY_URL}practices</a>。</p>
    <ol class="steps">
      <li><strong><span>01</span>看建议</strong>练习页列出建议练的题，每道都写了为什么练。可以点「调整题目和题量」，再点「开始做这几道」。</li>
      <li><strong><span>02</span>打印练习</strong>进入这一次练习后，点「打印练习」。可以附上答案与解析，然后打印，或在打印预览里存成 PDF。做的时候先不要看答案。</li>
      <li><strong><span>03</span>纸上做</strong>不看答案，自己做。每道题写上做题日期，并标明是独立做出、看了提示，还是没做出来。</li>
      <li><strong><span>04</span>记结果</strong>回到练习，点「记录纸上结果」。按纸上写的填写做题日期，看过提示或答案就勾上，再点「做对了」或「做错了」。也可以点「拍照交练习」：拍清题号和完整过程，AI 核对后由你确认。隔 3 天以上还能独立做对，才算真的会了。当天做对，不算会。</li>
    </ol>
    ${shot('practice-home.webp', '练习页：建议的题目、调整题量、开始做', '合成示例。练习页。建议和「为什么练」由 AI 给出，开始前可以调整。')}
    ${shot('practice-question.webp', '一次练习：打印、对答案、拍照交练习', '合成示例。一次练习里可以打印、在页面上对答案，或整份拍照交给 AI 核对。')}
    ${shot('practice-print.webp', '打印练习纸', '合成示例。打印前可以看第一道印出来的样子，再点「打印」。')}
    ${shot('practice-record.webp', '记录纸上的做题日期和对错', '合成示例。纸上做完后在这里记日期和对错。图中的参考答案带有测试字样，正式使用时不会这样写。')}
    ${shot('practice-submit.webp', '拍照交练习', '合成示例。把写好的纸拍下来交给 AI 核对，最后仍由你确认。')}

    <h2 id="faq"><span class="num">07</span>常见问题</h2>
    <dl class="faq">
      <div><dt>换手机</dt><dd>用同一个邀请码在新手机登录，学习记录都在。</dd></div>
      <div><dt>忘了邀请码</dt><dd>打开 <a href="${STUDY_URL}recover">${STUDY_URL}recover</a>，用注册时的姓名、手机号和找回码换一个新码，记录都在，旧码作废。没设过找回码，或找回码也忘了，找老师重发。</dd></div>
      <div><dt>打不开相册</dt><dd>安卓上如果桌面图标打开的是一个没有文件选择器的壳，点相册没反应。改用 Chrome 或系统浏览器打开学习页再拍。小米、红米请点页面上的相册入口。</dd></div>
      <div><dt>AI 认错字</dt><dd>题目详情里点「识别错了？改」，或右上角「…」→「改题目文字」。以照片为准。</dd></div>
      <div><dt>不是错题</dt><dd>题目详情右上角「…」→「不是错题，移除」。录入页里不相关的题可以左滑删除。</dd></div>
      <div><dt>重复照片</dt><dd>同一张图只保存一次。</dd></div>
      <div><dt>微信里打开</dt><dd>可以先看，但添加到桌面、打印和相册都更稳妥的做法是：点右上角「…」，在系统浏览器或 Safari 里打开，再用邀请码登录一次。</dd></div>
    </dl>
    ${shot('recover.webp', '用姓名、手机号和找回码找回邀请码', '合成示例。找回页。对不上时页面不会告诉你是哪一项错了。')}

    <h2 id="contact"><span class="num">08</span>联系方式</h2>
    <dl class="contact">
      <div><dt>邮箱</dt><dd>待补充</dd></div>
      <div><dt>微信</dt><dd>待补充</dd></div>
    </dl>

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
