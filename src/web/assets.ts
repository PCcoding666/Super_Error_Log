/**
 * 学生网页版的静态资源。发布包只含 dist/（见 scripts/release-whitelist.txt），所以样式、脚本、
 * Service Worker、manifest 与图标都以 TypeScript 字符串形式随 tsc 编译进 dist，不放 public/。
 * 脚本只做浏览器必须做的事（上传进度、录音、选题计数、打印、按需显隐）；关掉脚本时每屏照样能用（语音除外）。
 */
import sharp from 'sharp';
import { PHOTO_UPLOAD_SCRIPT } from './photoUpload.js';
import { UI_SHEET_SCRIPT } from './sheet.js';
export { UI_SHEET_SCRIPT } from './sheet.js';

export const APP_NAME = '超级错题本';
export const APP_SHORT_NAME = '错题本';
export const THEME_COLOR = '#F2F2F7';
/** 状态栏跟随页面底色，浏览器边缘与页面衔接。 */
export const THEME_COLOR_DARK = '#000000';
export const BACKGROUND_COLOR = '#F2F2F7';
/** 资源版本：改了样式或脚本就改这个，让浏览器与 Service Worker 换新。 */
export const ASSET_VERSION = '5';

export const STYLES = `
/* ---------- HIG 网页适配：系统字体、中性分组底、蓝色交互、实色内容 ----------
   --line 只负责分组；--field 为需要辨认的输入边界。正文、次要和语义文字、
   输入边界与焦点的对比度由预览验收计算；材质只用于底部操作层。 */
:root{color-scheme:light dark;
--paper:#F2F2F7;--card:#FFFFFF;--ink:#1C1C1E;--muted:#63636B;--accent:#0066D6;--teal:var(--accent);--on-teal:#FFFFFF;--mint:#EDF4FF;--line:#DFDFE5;--field:#85858D;
--gray:var(--muted);--blue:var(--accent);--orange:#974B06;--green:#257345;--red:#B22932;
--bar:rgba(255,255,255,.94);--bar-solid:#FFFFFF;--disabled-bg:#E5E5EA;--disabled-ink:#63636B;--focus:var(--accent);--surround:#E5E5EA;--photo-dim:none;
--surface-shadow:none;--bar-shadow:0 3px 18px rgba(0,0,0,.065);
--fs-1:.8125rem;--fs-2:.9375rem;--fs-3:1.0625rem;--fs-4:1.375rem;--fs-5:2.125rem;
--lh-text:1.6;--lh-tight:1.4;
--s-1:4px;--s-2:8px;--s-3:12px;--s-4:16px;--s-5:24px;--s-6:32px;--page-inset:20px;
--r-1:10px;--r-2:20px;--r-control:14px;--r-pill:999px;
--tap:44px}
@media (prefers-color-scheme:dark){:root{
--paper:#000000;--card:#1C1C1E;--ink:#F5F5F7;--muted:#AEAEB5;--accent:#64AAFF;--on-teal:#061D37;--mint:#172B44;--line:#38383D;--field:#8C8C94;
--gray:var(--muted);--blue:var(--accent);--orange:#F2B57C;--green:#79D79B;--red:#FF9FA4;
--bar:rgba(36,36,39,.96);--bar-solid:#242427;--disabled-bg:#36363B;--disabled-ink:#AEAEB5;--focus:var(--accent);--surround:#2C2C2E;--photo-dim:brightness(.92);
--surface-shadow:none;--bar-shadow:0 3px 20px rgba(0,0,0,.3)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-padding-bottom:calc(var(--bar-h,200px) + var(--s-5))}
body{margin:0;background:var(--paper);color:var(--ink);
font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif;
font-size:var(--fs-3);line-height:var(--lh-text);font-variant-numeric:tabular-nums;font-kerning:normal;
padding:env(safe-area-inset-top) 0 calc(var(--bar-h,200px) + var(--s-5))}
a{color:var(--teal);text-underline-offset:.18em}
button,input,select,textarea{-webkit-tap-highlight-color:transparent}
button,a,label,summary{touch-action:manipulation}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.top{display:flex;align-items:center;justify-content:space-between;gap:var(--s-2);padding:var(--s-1) var(--s-3);min-height:52px;max-width:576px;margin:0 auto}
.top-root{justify-content:flex-end}
.top a{display:inline-flex;align-items:center;gap:6px;min-height:var(--tap);min-width:var(--tap);justify-content:center;padding:0 var(--s-2);text-decoration:none;font-size:var(--fs-2);font-weight:600;border-radius:var(--r-pill)}
.top .nav-icon{width:20px;height:20px;flex:0 0 auto;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.top .settings-icon{width:19px;height:19px}
main{padding:var(--s-2) var(--page-inset) 0;max-width:576px;margin:0 auto;overflow-wrap:anywhere}
h1{font-size:var(--fs-5);font-weight:700;letter-spacing:-.025em;line-height:1.25;margin:0 0 var(--s-4);text-wrap:balance}
h2{font-size:var(--fs-4);font-weight:650;line-height:var(--lh-tight);margin:var(--s-6) 0 var(--s-3);text-wrap:balance}
p{margin:var(--s-2) 0}
p,li{text-wrap:pretty}
/* 短句（列表项、选项、标签、说明行、标题）按词组断行：字与字之间不断，只在标点、空格处换行，「「相 / 机」」这类拆词不再出现；
   一句太长、没有断点时才在任意处断。长段落照常按字换行（中文排版的惯例），其中的「」引语由 .q 保持在同一行。 */
main h1,main h2,legend,.field-label,.caption,.choice span,.steps-text li,.meta-line,.row-text,.step-detail{word-break:keep-all;overflow-wrap:anywhere}
.q{white-space:nowrap}
main p,main li{max-width:32em}
.muted{color:var(--muted)}.small{font-size:var(--fs-2)}
.lead{margin:calc(var(--s-1) * -1) 0 var(--s-5);color:var(--muted)}
.lead,.hint,.small,.steps-text li,.flash{text-wrap:balance}
.card{background:var(--card);border:1px solid transparent;border-radius:var(--r-2);padding:20px;margin:var(--s-4) 0;box-shadow:var(--surface-shadow)}
.card>:first-child{margin-top:0}.card>:last-child{margin-bottom:0}
.card-title{font-size:var(--fs-4);line-height:var(--lh-tight);font-weight:600;margin:0 0 var(--s-2)}
.flash{border-radius:var(--r-2);padding:var(--s-3) var(--s-4);margin:var(--s-3) 0;background:var(--mint)}
.flash.err{background:color-mix(in srgb,var(--red) 14%,var(--card));color:var(--ink)}
.tone-teal{color:var(--teal)}.tone-gray{color:var(--gray)}.tone-blue{color:var(--blue)}.tone-orange{color:var(--orange)}.tone-green{color:var(--green)}.tone-red{color:var(--red)}
.rhythm{display:flex;gap:var(--s-1);margin:var(--s-2) 0 var(--s-5);padding:var(--s-1);border-radius:var(--r-control);background:var(--line);list-style:none}
.rhythm li{flex:1;min-width:0;text-align:center;font-size:var(--fs-1);line-height:1.5;padding:var(--s-2) var(--s-1);border-radius:var(--r-1);border:1px solid transparent;color:var(--muted)}
.rhythm li.on{background:var(--card);color:var(--teal);box-shadow:var(--surface-shadow)}
.rhythm b{display:block;font-size:var(--fs-2);font-weight:650;margin-bottom:2px}
.steps-head{display:flex;justify-content:space-between;align-items:baseline;gap:var(--s-2);margin:0}
.steps{list-style:none;margin:var(--s-3) calc(var(--s-2) * -1) calc(var(--s-1) * -1);padding:0}
.steps a,.steps .row{display:flex;gap:var(--s-3);align-items:flex-start;text-decoration:none;color:inherit;padding:var(--s-4) var(--s-2);border-radius:var(--r-control);border:1px solid transparent;min-height:var(--tap)}
.steps .current{background:var(--mint)}
.dot{flex:0 0 1.75rem;height:1.75rem;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:var(--fs-2);font-weight:650;background:var(--paper);color:var(--muted);line-height:1}
.current .dot{background:var(--teal);color:var(--on-teal)}
.done .dot{background:color-mix(in srgb,var(--green) 18%,var(--card));color:var(--green)}
.done .step-title{color:var(--muted)}
.step-body{flex:1;min-width:0;line-height:var(--lh-tight)}
.step-title{font-weight:600}
.step-detail{display:block;font-size:var(--fs-2);margin-top:var(--s-1)}
.step-min{color:var(--muted);white-space:nowrap}
.step-detail{text-wrap:balance}
.ph{display:inline-block}
.steps .chev{align-self:center;flex:0 0 auto}
.chip{display:inline-block;font-size:var(--fs-1);font-weight:600;line-height:var(--lh-tight);padding:1px var(--s-2);border-radius:var(--r-pill);margin-left:var(--s-2);vertical-align:1px;background:var(--mint);color:var(--muted);white-space:nowrap}
.chip.now{background:color-mix(in srgb,var(--teal) 14%,var(--card));color:var(--teal)}
.chev{color:var(--muted);font-size:var(--fs-4);font-weight:400;line-height:1}
.list{list-style:none;margin:0;padding:0}
.list>li{border-top:1px solid var(--line)}
.list>li:first-child{border-top:0}
.list a.row,.list .row{display:flex;gap:var(--s-3);align-items:center;padding:var(--s-4) 0;text-decoration:none;color:inherit;min-height:56px}
.list .row-text{flex:1;min-width:0}
.list .row-block{display:block}
.flush{margin:0}
.pre{white-space:pre-wrap}
.eyebrow{font-size:var(--fs-2);color:var(--muted);margin:var(--s-1) 0 0;line-height:var(--lh-tight)}
.eyebrow+h1{margin-top:0}
.card-title.sub{font-size:var(--fs-3);margin-top:var(--s-4)}
.photo-link{display:block}
.flash-row{display:flex;align-items:center;justify-content:space-between;gap:var(--s-3);padding-top:0;padding-bottom:0;min-height:52px}
.thumb{width:84px;height:64px;object-fit:cover;border-radius:var(--r-1);background:var(--mint);flex:0 0 auto;filter:var(--photo-dim)}
.qrow .thumb{width:56px;height:56px}
.crop{display:block;width:100%;height:96px;object-fit:contain;object-position:left center;border-radius:var(--r-1);margin:var(--s-2) 0;filter:var(--photo-dim)}
.crop.big{height:auto;max-height:none}
.excerpt{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.meta-line{display:block;font-size:var(--fs-2);line-height:var(--lh-tight);margin-top:var(--s-1)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--s-2);margin:var(--s-3) 0}
.grid figure{margin:0;font-size:var(--fs-1);line-height:var(--lh-tight);text-align:center}
.grid figcaption{margin-top:var(--s-1)}
.grid img{width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:var(--r-1);background:var(--mint);display:block;filter:var(--photo-dim)}
.add-tile{display:flex;align-items:center;justify-content:center;aspect-ratio:3/4;border:2px dashed var(--field);border-radius:var(--r-1);color:var(--teal);font-weight:600;cursor:pointer;text-align:center;padding:var(--s-2)}
.choice{display:flex;gap:var(--s-3);align-items:center;padding:var(--s-4);border:1px solid var(--line);border-radius:var(--r-control);margin:var(--s-3) 0;background:var(--card);cursor:pointer;min-height:56px;line-height:var(--lh-tight);text-wrap:balance}
.choice input{width:22px;height:22px;margin:0;accent-color:var(--teal);flex:0 0 auto}
.choice:has(input:checked){border-color:var(--teal);box-shadow:inset 0 0 0 .5px var(--teal);background:var(--mint)}
.choice:has(input:focus-visible){outline:3px solid var(--focus);outline-offset:2px}
.choice:has(input:disabled){cursor:default;color:var(--muted);background:var(--paper)}
.choice.pick{align-items:flex-start}
.choice .grow{flex:1;min-width:0}
.choices-inline{display:flex;flex-wrap:wrap;gap:var(--s-2)}
.choices-inline .choice{margin:0;flex:1 1 40%;padding:var(--s-3) var(--s-3) var(--s-3) var(--s-3)}
fieldset{border:0;margin:var(--s-4) 0;padding:0}
legend{font-weight:600;margin-bottom:var(--s-2);padding:0;line-height:var(--lh-tight);text-wrap:balance}
.field-label{display:block;font-weight:600;line-height:var(--lh-tight);margin:var(--s-4) 0 var(--s-2)}
.hint{font-size:var(--fs-2);color:var(--muted);margin:var(--s-1) 0 var(--s-2)}
.tag{display:inline-block;font-size:var(--fs-1);font-weight:600;line-height:var(--lh-tight);color:var(--teal);background:color-mix(in srgb,var(--teal) 12%,var(--card));border-radius:var(--r-pill);padding:1px var(--s-2);margin-left:var(--s-2);vertical-align:1px;white-space:nowrap}
textarea,input[type=text],input[type=date],select{width:100%;font:inherit;line-height:var(--lh-tight);color:var(--ink);background:var(--card);border:1px solid var(--field);border-radius:var(--r-1);padding:var(--s-3) var(--s-4);min-height:52px}
textarea:focus,input[type=text]:focus,select:focus{border-color:var(--teal)}
textarea{min-height:120px;resize:vertical;line-height:var(--lh-text)}
/* 一句话总结：跟着内容长高（AI 写的那句不被截断）；不支持 field-sizing 的浏览器由脚本按 scrollHeight 调高 */
textarea.autogrow{min-height:52px;resize:none;field-sizing:content;overflow:hidden;word-break:keep-all;overflow-wrap:anywhere}
::placeholder{color:var(--muted);opacity:1}
.bubble{background:var(--mint);border-radius:var(--r-2) var(--r-2) var(--r-2) var(--r-1);padding:var(--s-3) var(--s-4);margin:var(--s-3) 0}
.bubble .who{font-size:var(--fs-1);color:var(--muted);font-weight:600}
.bubble p{margin:var(--s-1) 0 0}
.answer{background:var(--card);border:1px solid var(--line);border-radius:var(--r-2) var(--r-2) var(--r-1) var(--r-2);padding:var(--s-3) var(--s-4);margin:var(--s-2) 0 var(--s-2) var(--s-6)}
.voice{margin:var(--s-2) 0;display:flex;flex-wrap:wrap;align-items:center;gap:var(--s-2) var(--s-3)}
.voice.hidden{display:none}
.voice button{font:inherit;font-weight:600;border-radius:var(--r-pill);border:1px solid transparent;background:var(--mint);color:var(--teal);padding:var(--s-2) var(--s-4);min-height:var(--tap);cursor:pointer}
.voice button.on{background:var(--teal);color:var(--on-teal)}
.progress{height:8px;border-radius:var(--r-pill);background:var(--line);overflow:hidden;margin:var(--s-2) 0}
.progress i{display:block;height:100%;background:var(--teal);width:0}
details{margin:var(--s-3) 0}
summary{cursor:pointer;font-weight:600;min-height:var(--tap);padding:10px 0;line-height:24px}
.compare{display:grid;grid-template-columns:1fr;gap:var(--s-2)}
.compare>div{border-radius:var(--r-1);padding:var(--s-2) var(--s-3);background:var(--card);border:1px solid var(--line)}
.compare .label{display:block;font-size:var(--fs-1);color:var(--muted);line-height:var(--lh-tight)}
.compare del{color:var(--muted);text-decoration:line-through}
.notes{background:var(--paper);border:1px solid transparent;border-radius:var(--r-1);padding:var(--s-3) var(--s-4);color:var(--muted);font-size:var(--fs-2)}
.notes p{margin:var(--s-1) 0}
.inline-form{display:inline}
.link-btn{font:inherit;background:none;border:0;color:var(--teal);font-weight:600;padding:0 var(--s-2);margin:0 calc(var(--s-2) * -1);min-height:var(--tap);min-width:var(--tap);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;border-radius:var(--r-1)}
.more{display:flex;align-items:center;gap:var(--s-1);min-height:var(--tap);font-weight:600;text-decoration:none;color:var(--teal)}
.more-inline{display:inline-flex;align-items:center;min-height:var(--tap);font-weight:600;text-decoration:none;color:var(--teal)}
.actions{display:flex;flex-wrap:wrap;gap:0 var(--s-5);margin-top:var(--s-1)}
.section-label{font-size:var(--fs-2);line-height:var(--lh-tight);color:var(--muted);font-weight:400;margin:0 0 var(--s-1)}
.section-label.out{margin:var(--s-5) 0 var(--s-2)}
.steps-text{margin:var(--s-2) 0;padding-left:1.4em}
.steps-text li{margin:var(--s-2) 0}
.standalone .a2hs-row{display:none}
.callout{border-left:4px solid var(--teal)}
/* ---------- 底部下一步按钮（§4.0）：说明小字 → 次要操作一行文字按钮 → 主按钮（永远在最下面同一个位置） ---------- */
.next-bar{position:fixed;left:0;right:0;bottom:0;z-index:10;background:var(--bar-solid);
border-top:1px solid var(--line);box-shadow:var(--bar-shadow);padding:var(--s-3) var(--page-inset) calc(var(--s-3) + env(safe-area-inset-bottom))}
@supports ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){.next-bar{background:var(--bar);-webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px)}}
.next-bar .inner{max-width:536px;margin:0 auto;display:flex;flex-direction:column;gap:var(--s-2)}
.next-bar .caption{font-size:var(--fs-2);line-height:var(--lh-tight);color:var(--muted);text-align:center;margin:0;text-wrap:balance}
.next-bar .caption.tone-orange{color:var(--orange);font-weight:600}
.next-bar .caption:empty{display:none}
.next-bar form{display:flex;margin:0;flex:1}
.bar-main{display:flex}
.bar-alt{display:flex;justify-content:center;flex-wrap:wrap;gap:0 var(--s-2);margin:calc(var(--s-1) * -1) 0}
.bar-alt form{flex:0 1 auto}
.bar-stack{display:flex;flex-direction:column;gap:var(--s-2)}
.bar-after{display:flex;flex-direction:column;gap:var(--s-2)}
.btn{font:inherit;font-size:var(--fs-3);font-weight:600;line-height:var(--lh-tight);display:flex;align-items:center;justify-content:center;gap:var(--s-2);text-align:center;text-decoration:none;text-wrap:balance;
border-radius:var(--r-control);min-height:52px;min-width:0;padding:var(--s-3) var(--s-4);cursor:pointer;border:1px solid transparent;background:var(--mint);color:var(--teal);flex:1;-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:background-color .16s ease,box-shadow .16s ease,filter .16s ease}
.btn.primary{background:var(--teal);color:var(--on-teal);box-shadow:none}
.btn.alt{flex:0 1 auto;border-color:transparent;background:transparent;min-height:var(--tap);padding:var(--s-2) var(--s-3)}
.btn:active{filter:brightness(.92)}
.btn:focus-visible{outline-offset:3px}
.btn[disabled],.btn.disabled{background:var(--disabled-bg);border-color:var(--disabled-bg);color:var(--disabled-ink);cursor:default;filter:none}
.btn.waiting::before{content:"";flex:0 0 auto;width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (hover:hover){.btn:not([disabled]):not(.disabled):hover{filter:brightness(.96)}.top a:hover,.link-btn:hover{background:var(--mint)}.list a.row:hover{color:var(--teal)}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media (prefers-reduced-transparency:reduce){.next-bar{background:var(--bar-solid);-webkit-backdrop-filter:none;backdrop-filter:none}}
@media (forced-colors:active){.card,.choice,.btn,.rhythm li.on{border:1px solid CanvasText}.btn.primary,.steps .current{outline:1px solid Highlight}}
@media (max-width:360px){:root{--page-inset:16px}.card{padding:var(--s-4)}.rhythm li{padding:var(--s-2) 2px}}
body:has(#camera-input:focus-visible) label[for=camera-input],body:has(#library-input:focus-visible) label[for=library-input]{outline:3px solid var(--focus);outline-offset:3px}
.js .no-js-only{display:none!important}
.js-only{display:none!important}
.js .js-only{display:revert!important}
.js .js-only.btn{display:flex!important}
.hidden{display:none!important}
.visually-hidden{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.status{display:inline-block;font-size:var(--fs-1);font-weight:600}
.a2hs{border:1px solid var(--line);box-shadow:none}
.standalone .a2hs{display:none!important}
/* 全局导航与当前任务分开；正文只有实色分组，材质只用于悬浮导航。 */
body.has-tabbar{padding-bottom:calc(106px + env(safe-area-inset-bottom))}
html:has(body.has-tabbar){scroll-padding-bottom:calc(106px + env(safe-area-inset-bottom))}
.tab-bar{position:fixed;z-index:15;left:12px;right:12px;bottom:calc(8px + env(safe-area-inset-bottom));max-width:552px;margin:0 auto;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;padding:5px 6px;border:1px solid var(--line);border-radius:29px;background:var(--bar-solid);box-shadow:var(--bar-shadow)}
.tab-bar a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:54px;min-width:44px;padding:5px 8px;border-radius:23px;font-size:.75rem;line-height:1.3;font-weight:600;text-decoration:none;color:var(--muted)}
.tab-bar svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:none}
.tab-bar a[aria-current=page]{color:var(--accent);background:var(--mint)}
.tab-bar a[aria-current=page] svg{stroke-width:2.2}
@supports ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){.tab-bar{background:var(--bar);-webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px)}}
.next-bar-inline{position:static;padding:var(--s-4) 0 0;background:transparent;border:0;box-shadow:none;-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
.next-bar-inline .inner{max-width:none;gap:var(--s-3)}
.next-bar-inline .caption{text-align:left;font-size:var(--fs-1)}
.next-bar-inline .bar-main{order:1}
.next-bar-inline .bar-alt{order:2;justify-content:flex-start;margin:calc(var(--s-2) * -1) 0 0}
.next-bar-inline .bar-alt .btn{padding:var(--s-2) 0;justify-content:flex-start}
.next-bar-inline .btn.primary{min-height:52px}
.today-heading{margin:var(--s-1) 0 var(--s-5)}
.today-date{font-size:var(--fs-1);font-weight:600;color:var(--muted);margin:0 0 var(--s-1)}
.today-heading h1{margin-bottom:var(--s-2)}
.today-subtitle{font-size:var(--fs-2);line-height:1.5;color:var(--muted);margin:0}
.today-focus{padding:24px;margin:0;border:0;border-radius:24px;background:var(--card);box-shadow:none}
.focus-eyebrow{display:flex;align-items:center;gap:var(--s-2);font-size:var(--fs-1);font-weight:600;color:var(--muted);margin:0 0 var(--s-3)}
.focus-icon{display:flex;align-items:center;justify-content:center;width:44px;height:44px;flex:none;color:var(--accent)}
.focus-icon svg,svg.focus-icon{width:30px;height:30px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.focus-title{font-size:1.75rem;font-weight:700;letter-spacing:-.02em;line-height:1.3;margin:0 0 var(--s-3);text-wrap:balance}
.focus-detail{font-size:var(--fs-3);line-height:1.6;margin:0}
.focus-meta{font-size:var(--fs-2);line-height:1.5;color:var(--muted);margin:var(--s-2) 0 0}
.week-overview{margin:var(--s-3) 0 var(--s-6);border-bottom:1px solid var(--line)}
.week-overview>summary{list-style:none;display:flex;align-items:center;gap:var(--s-3);padding:var(--s-3) 4px;min-height:68px;font-weight:400}
.week-overview>summary::-webkit-details-marker{display:none}
.week-overview-label{font-size:var(--fs-2);font-weight:600;flex:1;min-width:0}
.week-overview-meta{font-size:var(--fs-1);font-weight:400;color:var(--muted);text-align:right}
.week-overview [data-sheet-content]{padding:var(--s-2) 0 var(--s-4)}
.week-overview [data-sheet-content] h2{margin-top:0}
.today-library{margin:0 0 var(--s-5)}
.today-library>.section-label{font-size:var(--fs-4);font-weight:700;color:var(--ink);margin:0 0 var(--s-3)}
.today-library .list{border-radius:var(--r-2);background:var(--card);padding:0 var(--s-4)}
.today-library .library-row{gap:var(--s-3);min-height:82px;padding:var(--s-4) 0}
.library-icon{display:flex;align-items:center;justify-content:center;width:36px;height:36px;flex:none;color:var(--accent)}
.library-icon svg,svg.library-icon{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.library-row .meta-line{font-size:var(--fs-1);color:var(--muted)}
.today-install{border:0;background:transparent;margin:var(--s-4) 0;color:var(--muted);font-size:var(--fs-1)}
.today-install summary{display:flex;align-items:center;gap:var(--s-2);list-style:none;font-size:var(--fs-2);font-weight:400;color:var(--accent);padding:var(--s-2) 0}
.today-install summary::-webkit-details-marker{display:none}
.today-install p{font-size:var(--fs-1)}
/* 同一个周安排节点移动到原生 dialog，浏览器提供模态焦点与背景不可交互。 */
body.sheet-is-open{overflow:hidden}
.week-sheet{position:fixed;inset:auto 0 0;width:min(100%,576px);max-width:100%;max-height:calc(100dvh - env(safe-area-inset-top) - 24px);margin:0 auto;border:0;border-radius:28px 28px 0 0;padding:0;background:var(--card);color:var(--ink);box-shadow:0 -12px 60px rgba(0,0,0,.12);overflow:auto;overscroll-behavior:contain;opacity:0;transform:translateY(calc(42px + var(--sheet-drag,0px)));transition:transform .24s cubic-bezier(.22,.75,.25,1),opacity .18s ease}
.week-sheet.sheet-visible{opacity:1;transform:translateY(var(--sheet-drag,0px))}
.week-sheet.sheet-dragging{transition:none}
.week-sheet::backdrop{background:rgba(0,0,0,.28)}
.sheet-toolbar{height:48px;position:sticky;top:0;z-index:1;background:var(--card);border-radius:28px 28px 0 0}
.sheet-grabber{position:absolute;left:50%;transform:translateX(-50%);width:88px;height:44px;padding:0;border:0;background:transparent;display:flex;align-items:center;justify-content:center;cursor:grab;touch-action:none;border-radius:12px}
.sheet-grabber span{width:36px;height:5px;border-radius:99px;background:var(--field)}
.sheet-close{position:absolute;right:12px;top:4px;min-width:56px;min-height:44px;border:0;border-radius:var(--r-pill);padding:0 12px;font:inherit;font-size:var(--fs-2);font-weight:600;color:var(--accent);background:transparent;cursor:pointer}
.week-sheet [data-sheet-content]{padding:0 24px calc(24px + env(safe-area-inset-bottom))}
.week-sheet h2{margin:0 0 var(--s-4);font-size:1.5rem;line-height:1.3}
.week-sheet .steps-head{font-size:var(--fs-2);flex-wrap:wrap}
.week-sheet .rhythm{margin:var(--s-5) 0 var(--s-3);background:var(--paper)}
.week-sheet .steps{margin-top:var(--s-4)}
.week-sheet .steps .current{background:var(--mint)}
@supports (corner-shape:squircle){.today-focus,.today-library .list,.week-sheet,.card,.btn{corner-shape:squircle}}
@media (min-width:720px){.week-sheet{inset:0;max-height:min(82dvh,780px);height:fit-content;margin:auto;border-radius:28px}.week-sheet .sheet-toolbar{border-radius:28px 28px 0 0}}
@media (max-width:360px){.today-focus{padding:20px}.week-sheet [data-sheet-content]{padding-left:20px;padding-right:20px}.week-overview>summary{gap:8px}}
@media (prefers-reduced-motion:reduce){.week-sheet{transform:none!important;opacity:1;transition:none}}
.demo-reduce-motion .week-sheet{transform:none!important;opacity:1;transition:none}
@media (prefers-reduced-transparency:reduce){.tab-bar{background:var(--bar-solid);-webkit-backdrop-filter:none;backdrop-filter:none}}
@media (prefers-contrast:more){:root{--muted:#45454D;--line:#92929A;--field:#64646C}.tab-bar,.next-bar{background:var(--bar-solid);-webkit-backdrop-filter:none;backdrop-filter:none}}
@media (prefers-color-scheme:dark) and (prefers-contrast:more){:root{--muted:#D2D2D8;--line:#777780;--field:#A9A9B2}}
@media (forced-colors:active){.tab-bar,.week-sheet{border:1px solid CanvasText}.tab-bar a[aria-current=page]{outline:2px solid Highlight}}
@media print{.tab-bar,.week-sheet{display:none!important}}
/* 练习纸预览的画框（只在屏幕上；打印时去掉，纸面版式不变） */
.sheet-frame{background:var(--surround);border-radius:var(--r-2);padding:var(--s-3);margin:var(--s-3) 0}
.sheet-frame .sheet-wrap{margin:0}
@media screen{.sheet-frame .sheet{background:transparent}.sheet-frame .sheet .page{filter:var(--photo-dim)}}
/* 练习纸（A4）：屏幕上缩放预览，打印时只印纸 */
.sheet-wrap{overflow:hidden;margin:12px 0}
.sheet{color:#111;background:#fff;font:12pt/1.55 "PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Songti SC",serif}
/* 练习纸版式不在本轮范围：把页面上通用的段落规则（间距、行长、换行策略）挡在纸外面，纸上保持原来的 6px 段距。 */
.sheet p{margin:6px 0;max-width:none;text-wrap:wrap;word-break:normal;overflow-wrap:normal}
.sheet .page{background:#fff;width:210mm;min-height:297mm;padding:16mm 16mm 18mm;margin:0 0 12px;box-shadow:0 1px 4px rgba(0,0,0,.18)}
.sheet h3{font-size:20pt;margin:0 0 6mm}
.sheet .item{break-inside:avoid;page-break-inside:avoid;border-top:1px solid #bbb;padding:5mm 0 4mm}
.sheet .item:first-child{border-top:0}
.sheet .item-head b{margin-right:3mm}
.sheet .stem{white-space:pre-wrap;margin:2mm 0}
.sheet .note{font-size:9pt;color:#555}
.sheet img{max-width:100%;max-height:110mm;display:block;margin:2mm 0}
.sheet .blank{height:30mm;border-bottom:1px dashed #999;margin-bottom:3mm}
.sheet .boxes{display:flex;flex-wrap:wrap;gap:3mm 6mm;font-size:11pt}
.sheet .answer-entry{break-inside:avoid;page-break-inside:avoid;margin:0 0 5mm}
.sheet .answers{break-before:page;page-break-before:always}
@media screen{.sheet-scale{transform-origin:top left}}
@media print{
  @page{size:A4;margin:0}
  body{background:#fff;padding:0;color:#000}
  .top,.next-bar,main>*:not(.print-root){display:none!important}
  main{padding:0;max-width:none;margin:0}
  .sheet-frame{padding:0;margin:0;background:none;border-radius:0}
  .sheet-wrap{overflow:visible;height:auto!important;margin:0}
  .sheet-scale{transform:none!important;width:auto!important}
  .sheet .page{box-shadow:none;margin:0;break-after:page;page-break-after:always}
  .sheet .page:last-child{break-after:auto;page-break-after:auto}
}
`;

/** 浏览器脚本：同步加载（head 里），先给 <html> 加 .js，再在 DOMContentLoaded 后挂各个小功能。 */
export const CLIENT_SCRIPT = String.raw`(function(){
var root=document.documentElement;root.classList.add('js');
var standalone=window.navigator.standalone===true||(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches);
if(standalone)root.classList.add('standalone');
function $(s,el){return (el||document).querySelector(s)}function $$(s,el){return Array.prototype.slice.call((el||document).querySelectorAll(s))}
function uuid(){if(window.crypto&&crypto.randomUUID)return crypto.randomUUID();var b=new Uint8Array(16);crypto.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h=Array.prototype.map.call(b,function(x){return(x+256).toString(16).slice(1)}).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20)}
if('serviceWorker' in navigator&&location.protocol==='https:'||('serviceWorker' in navigator&&/^(localhost|127\.0\.0\.1)$/.test(location.hostname))){window.addEventListener('load',function(){navigator.serviceWorker.register('/s/sw.js',{scope:'/s/'}).catch(function(){})})}
/* 互动记录（docs/web-interaction-trail.md）：只记「在哪一页、点了哪个按钮的标识」，不记任何内容。
   先放进短命 cookie sel_tap，随下一个请求交给服务器写进审计日志；不跳页的点按（打印、录音、拍照）立刻发一个 HEAD 把它带过去。 */
function trailAdd(role,key){try{var id=Math.random().toString(36).slice(2,8);var entry=id+'.'+role+'.'+String(key).replace(/[^A-Za-z0-9_-]/g,'').slice(0,40)+'@'+location.pathname;
var m=document.cookie.match(/(?:^|; )sel_tap=([^;]*)/);var list=m?decodeURIComponent(m[1]).split('|'):[];list.push(entry);list=list.slice(-6);
document.cookie='sel_tap='+encodeURIComponent(list.join('|'))+'; path=/s; max-age=120; samesite=lax'+(location.protocol==='https:'?'; secure':'')}catch(e){}}
function trailSend(){try{fetch(location.pathname,{method:'HEAD',credentials:'same-origin',cache:'no-store',keepalive:true}).catch(function(){})}catch(e){}}
window.__trail={add:trailAdd,send:trailSend};
document.addEventListener('click',function(e){var t=e.target;if(!t||!t.closest)return;var el=t.closest('a[href],button,label[for],summary');if(!el||el.disabled)return;
var role=el.closest('.next-bar')?(el.getAttribute('data-testid')==='next-step-primary'?'primary':'secondary'):el.closest('header.top')?'top':'content';
var key=el.getAttribute('data-key')||el.getAttribute('data-testid')||(el.tagName==='SUMMARY'?'summary':'unnamed');trailAdd(role,key);
var href=el.getAttribute('href')||'';var nav=(el.tagName==='A'&&!el.hasAttribute('data-print')&&href.charAt(0)!=='#'&&el.target!=='_blank')||(el.tagName==='BUTTON'&&el.type==='submit');
if(!nav)trailSend()},true);
document.addEventListener('DOMContentLoaded',function(){
${UI_SHEET_SCRIPT}
/* 底栏多高，内容下面就留多高（最后一行能滚到底栏上面） */
var nbar=$('.next-bar');function barH(){root.style.setProperty('--bar-h',(nbar?nbar.offsetHeight:0)+'px')}barH();if(nbar&&window.ResizeObserver)new ResizeObserver(barH).observe(nbar);
/* 等 AI 的页面自己刷新：只在页面看得见、他没在输入的时候刷新（关掉脚本时由 <noscript> 里的 meta refresh 接手） */
var every=Number(document.body.getAttribute('data-refresh')||0);
if(every>0){var due=Date.now()+every*1000;setInterval(function(){if(Date.now()<due||document.visibilityState!=='visible')return;var a=document.activeElement;if(a&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))return;due=Infinity;trailAdd('auto','refresh');location.reload()},500)}
/* 拍照上传：浏览器里先转成 JPEG 再传（HEIC、超大像素在服务器读不了）；细节见 src/web/photoUpload.ts */
${PHOTO_UPLOAD_SCRIPT}
/* 选题：数字跟着变，最多 8 道 */
var pick=$('form[data-pick-count]');
if(pick){var max=Number(pick.getAttribute('data-max')||'8'),min=Number(pick.getAttribute('data-min')||'1'),btn=$('[data-count-label]'),warn=$('[data-max-warning]');
function upd(e){var boxes=$$('input[type=checkbox][name=itemIds],input[type=checkbox][name=questionIds]',pick);var n=boxes.filter(function(b){return b.checked}).length;
if(n>max&&e&&e.target&&e.target.checked){e.target.checked=false;n=max;if(warn)warn.classList.remove('hidden')}else if(warn&&n<max)warn.classList.add('hidden');
if(btn){var t=n<min?btn.getAttribute('data-empty'):btn.getAttribute('data-template').replace('{n}',n);btn.textContent=t;btn.disabled=n<min;btn.classList.toggle('disabled',n<min)}}
pick.addEventListener('change',upd);upd()}
/* 「其他…」做练习的时间 */
$$('[data-slot-other]').forEach(function(box){var input=$('input[type=text]',box.parentNode);function upd(){var other=$('input[value="__other"]',box.parentNode);if(input&&other)input.closest('.choice').classList.toggle('hidden',!other.checked)}box.parentNode.addEventListener('change',upd);upd()});
/* 录结果：选了前三种才问对不对；没做出来才问卡在哪 */
$$('[data-record-item]').forEach(function(f){function upd(){var c=$('input[name=completion]:checked',f);var v=c?c.value:'';var k=$('[data-correct]',f),s=$('[data-stuck]',f);
if(k)k.classList.toggle('hidden',!(v==='independent'||v==='hint1'||v==='hint2'));if(s)s.classList.toggle('hidden',v!=='not_solved')}f.addEventListener('change',upd);upd()});
/* 说说为什么错：缺项提示 */
$$('form[data-reflection]').forEach(function(f){var line=$('[data-missing]'),btn=document.querySelector('button[form="'+f.id+'"]');function upd(){var miss=[];
if(!$('input[name=attemptState]:checked',f))miss.push('当时怎么了');if(!$('input[name=cause]:checked',f))miss.push('错在哪');if(!$('input[name=masteryFeeling]:checked',f))miss.push('有没有把握');
if(line){line.textContent=miss.length?'还差：'+miss.join('、'):'';}if(btn){btn.disabled=miss.length>0;btn.classList.toggle('disabled',miss.length>0)}}f.addEventListener('change',upd);upd()});
/* 字数 */
/* 一句话总结：一行话，回车不换行；跟着内容长高 */
$$('textarea[data-single-line]').forEach(function(t){t.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.isComposing)e.preventDefault()});if(window.CSS&&CSS.supports&&CSS.supports('field-sizing','content'))return;function fit(){t.style.height='auto';t.style.height=(t.scrollHeight+3)+'px'}t.addEventListener('input',fit);fit()});
$$('textarea[data-count]').forEach(function(t){var out=$(t.getAttribute('data-count'));function upd(){if(out)out.textContent='还能写 '+Math.max(0,Number(t.getAttribute('maxlength'))-t.value.length)+' 字'}t.addEventListener('input',upd);upd()});
/* 等待提示：提交后按钮换字，防止连点 */
$$('form[data-wait]').forEach(function(f){f.addEventListener('submit',function(){var b=document.querySelector('button[form="'+f.id+'"]')||$('button[type=submit]',f);if(b){b.textContent=f.getAttribute('data-wait');b.classList.add('waiting');setTimeout(function(){b.disabled=true},0)}})});
/* 打印 */
var printBtn=$('[data-print]');
if(printBtn){var after=function(){var first=$('[data-testid=next-step-primary][data-print]');if(first&&$('[data-after-print]')){(first.closest('.bar-main')||first).classList.add('hidden');first.setAttribute('data-testid','print-used')}
$$('[data-after-print]').forEach(function(el){el.classList.remove('hidden')});var done=$('[data-print-done]');if(done)done.setAttribute('data-testid','next-step-primary');
var cap=$('[data-testid=next-step-caption]');if(cap&&cap.getAttribute('data-after'))cap.textContent=cap.getAttribute('data-after')};
window.addEventListener('afterprint',after);$$('[data-print]').forEach(function(b){b.addEventListener('click',function(e){e.preventDefault();try{window.print()}catch(x){}setTimeout(after,600)})})}
/* 练习纸预览缩放到屏幕宽 */
$$('.sheet-wrap').forEach(function(w){var s=$('.sheet-scale',w);if(!s)return;function fit(){var k=w.clientWidth/s.scrollWidth;if(k<1){s.style.transform='scale('+k+')';w.style.height=(s.scrollHeight*k)+'px'}}fit();window.addEventListener('resize',fit)});
/* 语音：点一下开始，再点一下结束；转出来的字放进文本框，他改完自己提交 */
$$('[data-voice-for]').forEach(function(box){var target=document.getElementById(box.getAttribute('data-voice-for'));var btn=$('button',box),note=$('[data-voice-note]',box),method=$('input[name=method]',box.closest('form')||document);
var ok=target&&btn&&navigator.mediaDevices&&navigator.mediaDevices.getUserMedia&&window.MediaRecorder;
if(!ok){if(note)note.textContent='可以直接打字';return}
box.classList.remove('hidden');var rec=null,chunks=[],timer=null,stream=null,starting=false;
function type(){var c=['audio/mp4','audio/webm;codecs=opus','audio/webm'];for(var i=0;i<c.length;i++){if(MediaRecorder.isTypeSupported&&MediaRecorder.isTypeSupported(c[i]))return c[i]}return ''}
function reset(){btn.classList.remove('on');btn.textContent='点一下开始说';btn.disabled=false}
function stop(){if(rec&&rec.state!=='inactive')rec.stop();if(timer){clearTimeout(timer);timer=null}}
btn.addEventListener('click',function(){if(rec&&rec.state==='recording'){stop();return}
/* 打开麦克风要一会儿（第一次还会问权限）：马上给反馈，这期间再点不会开第二个录音 */
if(starting)return;starting=true;btn.disabled=true;btn.textContent='正在打开麦克风…';
navigator.mediaDevices.getUserMedia({audio:true}).then(function(s){starting=false;btn.disabled=false;stream=s;chunks=[];var t=type();rec=t?new MediaRecorder(s,{mimeType:t}):new MediaRecorder(s);
rec.ondataavailable=function(e){if(e.data&&e.data.size)chunks.push(e.data)};
rec.onstop=function(){stream.getTracks().forEach(function(x){x.stop()});var blob=new Blob(chunks,{type:(rec.mimeType||t||'audio/mp4')});btn.textContent='正在转成文字…';btn.classList.remove('on');btn.disabled=true;
fetch(box.getAttribute('data-endpoint'),{method:'POST',headers:{'content-type':blob.type.split(';')[0]||'audio/mp4'},body:blob,credentials:'same-origin'}).then(function(r){return r.json().then(function(b){return{ok:r.ok,status:r.status,b:b}})}).then(function(x){
if(x.ok&&x.b.text){target.value=(target.value?target.value+' ':'')+x.b.text;target.dispatchEvent(new Event('input'));if(method)method.value='voice';if(note)note.textContent='转好了，看一眼，不对就改'}
else if(x.ok){if(note)note.textContent='没听清，再说一次';trailAdd('error','voice_empty');trailSend()}else{if(note)note.textContent=(x.b.error&&x.b.error.message)||'这次没转成文字，再说一次，或者直接打字。';trailAdd('error','voice_'+x.status);trailSend()}reset()}).catch(function(){if(note)note.textContent='没传上去，可以直接打字';trailAdd('error','voice_network');reset()})};
rec.start();btn.classList.add('on');btn.textContent='正在听…再点一下结束';if(note)note.textContent='最多说 60 秒';timer=setTimeout(stop,60000)}).catch(function(){starting=false;reset();if(note)note.textContent='用不了麦克风，可以直接打字。';box.querySelector('button').classList.add('hidden');trailAdd('error','mic_denied');trailSend()})})});
/* 离线页：真没联网时换标题 */
var off=$('[data-offline-title]');if(off&&navigator.onLine===false){off.textContent='没联网';var d=$('[data-offline-detail]');if(d)d.textContent='连上 Wi-Fi 或流量后点「再试一次」。拍过的照片和错题都在服务器上，不会丢。'}
});})();
`;

/** Service Worker：只缓存外壳（离线页、样式、脚本、图标），学生数据一律不缓存（只在导航失败时换成离线页）。 */
export const SERVICE_WORKER = `const CACHE='sel-shell-${ASSET_VERSION}';
const SHELL=['/s/offline','/s/assets/app.css?v=${ASSET_VERSION}','/s/assets/app.js?v=${ASSET_VERSION}','/s/assets/icon-192.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const r=e.request;
  if(r.mode==='navigate'){e.respondWith(fetch(r).then(res=>res.status>=502&&res.status<=504?caches.match('/s/offline').then(o=>o||res):res).catch(()=>caches.match('/s/offline').then(o=>o||Response.error())));return}
  if(r.method==='GET'&&SHELL.some(p=>new URL(r.url).pathname+new URL(r.url).search===p)){e.respondWith(caches.match(r).then(c=>c||fetch(r)))}
});
`;

export function manifest(): Record<string, unknown> {
  return {
    name: APP_NAME, short_name: APP_SHORT_NAME, lang: 'zh-CN', dir: 'ltr',
    description: '纸错题延迟重做：周末拍卷子、选题打印，周中在纸上做，下个周末录结果。',
    start_url: '/s/', scope: '/s/', id: '/s/', display: 'standalone', orientation: 'portrait',
    background_color: BACKGROUND_COLOR, theme_color: THEME_COLOR,
    icons: [
      { src: '/s/assets/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/s/assets/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/s/assets/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

// ---------- 图标（与 iOS 的 App 图标同一设计：纸上的红叉 + 右下角的「重做」环形箭头） ----------

const rad = (d: number): number => (d * Math.PI) / 180;
function loop(cx: number, cy: number, r: number, w: number, color: string): string {
  const a1 = -35, a2 = 250;
  const p = (a: number): [number, number] => [cx + r * Math.cos(rad(a)), cy + r * Math.sin(rad(a))];
  const [x1, y1] = p(a1); const [x2, y2] = p(a2);
  const t = [-Math.sin(rad(a2)), Math.cos(rad(a2))]; const n = [Math.cos(rad(a2)), Math.sin(rad(a2))];
  const L = w * 1.5, H = w * 1.2;
  const tip = [x2 + t[0]! * L, y2 + t[1]! * L];
  const b1 = [x2 + n[0]! * H, y2 + n[1]! * H]; const b2 = [x2 - n[0]! * H, y2 - n[1]! * H];
  return `<path d="M ${x1} ${y1} A ${r} ${r} 0 1 1 ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`
    + `<path d="M ${tip[0]} ${tip[1]} L ${b1[0]} ${b1[1]} L ${b2[0]} ${b2[1]} Z" fill="${color}" stroke="${color}" stroke-width="${w * 0.22}" stroke-linejoin="round"/>`;
}

/** padding：maskable 图标四周留安全区（缩到 80%）。 */
export function iconSvg(padding = 0): string {
  const scale = 1 - padding * 2;
  const offset = 1024 * padding;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2B7F77"/><stop offset="1" stop-color="#174E4A"/></linearGradient></defs>
<rect width="1024" height="1024" fill="url(#bg)"/>
<g transform="translate(${offset} ${offset}) scale(${scale})">
<g transform="rotate(-6 512 512)"><rect x="222" y="160" width="540" height="696" rx="58" fill="#FBFAF5"/>
<g stroke="#D5DAD0" stroke-width="18" stroke-linecap="round"><line x1="292" y1="622" x2="692" y2="622"/><line x1="292" y1="702" x2="692" y2="702"/><line x1="292" y1="782" x2="560" y2="782"/></g>
<g stroke="#C8402F" stroke-width="72" stroke-linecap="round"><line x1="380" y1="286" x2="604" y2="510"/><line x1="604" y1="286" x2="380" y2="510"/></g></g>
<circle cx="744" cy="744" r="182" fill="#174E4A"/><circle cx="744" cy="744" r="154" fill="#DEEBDE"/>${loop(744, 744, 80, 32, '#1F615C')}
</g></svg>`;
}

const iconCache = new Map<string, Promise<Buffer>>();
/** 按需渲染 PNG 图标（sharp 渲染 SVG，无文字、不依赖字体），进程内缓存。 */
export function iconPng(size: number, maskable = false): Promise<Buffer> {
  const key = `${size}:${maskable}`;
  let cached = iconCache.get(key);
  if (!cached) {
    cached = sharp(Buffer.from(iconSvg(maskable ? 0.1 : 0))).resize(size, size).flatten({ background: '#174E4A' }).png().toBuffer();
    cached.catch(() => iconCache.delete(key));
    iconCache.set(key, cached);
  }
  return cached;
}
