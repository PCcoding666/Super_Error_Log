/**
 * 学生网页版的静态资源。发布包只含 dist/（见 scripts/release-whitelist.txt），所以样式、脚本、
 * Service Worker、manifest 与图标都以 TypeScript 字符串形式随 tsc 编译进 dist，不放 public/。
 * 脚本只做浏览器必须做的事（上传进度、录音、选题计数、打印、按需显隐）；关掉脚本时每屏照样能用（语音除外）。
 */
import crypto from 'node:crypto';
import sharp from 'sharp';
import { CLIENT_SCRIPT } from './clientScript.js';
import { ITEM_LEARNING_STYLES } from './itemLearningStyles.js';
export { UI_SHEET_SCRIPT } from './sheet.js';

export const APP_NAME = '超级错题本';
export const APP_SHORT_NAME = '错题本';
export const THEME_COLOR = '#F2F2F7';
/** 状态栏跟随页面底色，浏览器边缘与页面衔接。 */
export const THEME_COLOR_DARK = '#000000';
export const BACKGROUND_COLOR = '#F2F2F7';

export const STYLES = `${ITEM_LEARNING_STYLES}

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
--tap:44px;
--dur-1:150ms;--dur-2:220ms;--dur-3:300ms;--ease:cubic-bezier(.2,.8,.2,1)}
@media (prefers-color-scheme:dark){:root{
--paper:#000000;--card:#1C1C1E;--ink:#F5F5F7;--muted:#AEAEB5;--accent:#64AAFF;--on-teal:#061D37;--mint:#172B44;--line:#38383D;--field:#8C8C94;
--gray:var(--muted);--blue:var(--accent);--orange:#F2B57C;--green:#79D79B;--red:#FF9FA4;
--bar:rgba(36,36,39,.96);--bar-solid:#242427;--disabled-bg:#36363B;--disabled-ink:#AEAEB5;--focus:var(--accent);--surround:#2C2C2E;--photo-dim:brightness(.92);
--surface-shadow:none;--bar-shadow:0 3px 20px rgba(0,0,0,.3)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-padding-bottom:calc(var(--bar-h,200px) + var(--keyboard-inset,0px) + var(--s-5))}
body{margin:0;background:var(--paper);color:var(--ink);line-break:strict;
font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif;
font-size:var(--fs-3);line-height:var(--lh-text);font-variant-numeric:tabular-nums;font-kerning:normal;
padding:env(safe-area-inset-top) 0 calc(var(--bar-h,200px) + var(--keyboard-inset,0px) + var(--s-5))}
a{color:var(--teal);text-underline-offset:.18em}
button,input,select,textarea{-webkit-tap-highlight-color:transparent}
button,a,label,summary{touch-action:manipulation}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.top{display:flex;align-items:center;justify-content:space-between;gap:var(--s-2);padding:var(--s-1) var(--s-3);min-height:52px;max-width:576px;margin:0 auto}
.top-root{justify-content:flex-end}
.top a{display:inline-flex;align-items:center;gap:6px;min-height:var(--tap);min-width:var(--tap);justify-content:center;padding:0 var(--s-2);text-decoration:none;font-size:var(--fs-2);font-weight:600;border-radius:var(--r-pill)}
/* 独立导航操作有自己的表面；符号与点击容器分离。 */
.top a.toolbar-button{width:44px;height:44px;flex:0 0 44px;padding:0;border-radius:50%;color:var(--ink);background:var(--bar-solid);border:1px solid var(--line);box-shadow:var(--bar-shadow);transition:background-color var(--dur-1),filter var(--dur-1)}
.top a.toolbar-button:active{filter:brightness(.88)}
@supports ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){.top a.toolbar-button{background:var(--bar);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px)}}
@media (prefers-reduced-transparency:reduce),(prefers-contrast:more){.top a.toolbar-button{background:var(--bar-solid);-webkit-backdrop-filter:none;backdrop-filter:none}}
@media (forced-colors:active){.top a.toolbar-button{border:1px solid ButtonText;background:ButtonFace;color:ButtonText}}
.top .nav-icon{width:20px;height:20px;flex:0 0 auto;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.top .settings-icon{width:19px;height:19px}
.category-filter{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.category-filter select{width:auto;flex:1;min-width:88px;min-height:44px}
.chapter-group>.choice{margin:0}.chapter-group details{margin:0}.chapter-group summary{min-height:44px;padding-top:12px}
.toolbar-group{display:flex;align-items:center;background:var(--bar-solid);border:1px solid var(--line);border-radius:var(--r-pill);box-shadow:var(--bar-shadow);padding:0 2px}
.top .toolbar-group>.toolbar-button,.top .toolbar-group>a.toolbar-button,.toolbar-group summary{width:44px;height:44px;border:0;box-shadow:none;background:transparent;border-radius:22px;padding:0;margin:0}
@supports ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){.toolbar-group{background:var(--bar);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px)}}
@media (prefers-reduced-transparency:reduce),(prefers-contrast:more){.toolbar-group{background:var(--bar-solid);-webkit-backdrop-filter:none;backdrop-filter:none}}
.subject-switch{position:relative;display:inline-block;max-width:100%;min-width:0;color:var(--ink);vertical-align:top}
.subject-switch>summary{display:inline-flex;align-items:center;gap:4px;width:auto;max-width:100%;list-style:none;padding:0;min-height:var(--tap);font-size:inherit;font-weight:inherit;letter-spacing:inherit;line-height:inherit;border-radius:var(--r-1);color:var(--ink)}
.subject-switch>summary::-webkit-details-marker,.filter-chip>summary::-webkit-details-marker,.filter-pop>summary::-webkit-details-marker{display:none}
.subject-switch>summary>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.subject-switch>summary .nav-icon{width:22px;height:22px}
.subject-options,.menu{position:absolute;z-index:30;max-height:70vh;overflow:auto;background:var(--card);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.16)}
.subject-options{top:calc(100% + 4px);left:0;width:220px;max-width:calc(100vw - 32px);padding:6px}
.subject-options a{display:flex;justify-content:space-between;gap:12px;border-radius:8px;padding:8px 12px;min-height:44px;overflow-wrap:anywhere;color:var(--ink);text-decoration:none}
.subject-options a[aria-current=page]{background:var(--mint)}
.notebook-page .top{position:relative;z-index:20}
.notebook-page .top,.notebook-page main{max-width:960px}
.notebook-page.has-tabbar{padding-bottom:calc(11rem + env(safe-area-inset-bottom))}
.notebook-title{position:relative;min-height:44px}
.notebook-title h1{display:flex;margin-bottom:0}
.page-subtitle{margin:2px 0 16px;color:var(--muted);font-size:var(--fs-2);line-height:1.4}
.notebook-page .link-btn{display:inline-flex;align-items:center;min-height:44px;min-width:44px;padding:8px 12px}
.practice-fab{position:fixed;right:max(16px,calc(50vw - 460px));bottom:calc(6.9rem + env(safe-area-inset-bottom));z-index:14;width:auto;flex:0 0 auto;min-height:52px;padding:0 22px;box-shadow:0 8px 24px rgba(0,102,214,.28)}
.notebook-selection-page .practice-fab{display:none}
.notebook-filters{margin:0 0 12px}
.search-field{display:flex;align-items:center;gap:8px;min-height:44px;padding:0 14px;background:var(--surround);border-radius:var(--r-pill)}
.search-field input{flex:1;min-width:0;min-height:44px;border:0;background:transparent;font:inherit;color:var(--ink);padding:0}
.search-field input:focus{outline:none}
.search-field:focus-within{outline:3px solid var(--focus);outline-offset:2px}
.search-icon{width:18px;height:18px;flex:none;stroke:var(--muted);fill:none;stroke-width:2;stroke-linecap:round}
.filter-chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 8px}
.filter-chip{position:relative}
.filter-chip>summary,.filter-pop>summary{display:inline-flex;align-items:center;justify-content:center;gap:4px;list-style:none;cursor:pointer}
.filter-chip>summary{min-height:44px;padding:0 14px;border-radius:var(--r-pill);background:var(--card);color:var(--ink);font-size:var(--fs-2);font-weight:600}
.filter-chip>summary .nav-icon{width:16px;height:16px}
.filter-chip.chip-on>summary{background:var(--mint);color:var(--accent)}
.filter-pop{position:relative}
.filter-pop>summary{color:var(--ink)}
.menu{top:calc(100% + 8px);right:0;left:auto;width:min(300px,calc(100vw - 32px));padding:6px 0 8px}
.filter-chip>.menu{left:0;right:auto}
.menu-section{padding:4px 0}
.menu-section+.menu-section{border-top:1px solid var(--line)}
.menu-label{margin:6px 16px 2px;font-size:var(--fs-1);color:var(--muted)}
/* 菜单在顶栏里：撤掉 .top a 的居中、粗体和胶囊圆角，行首对齐，勾号占固定前导列。 */
.menu a{display:flex;align-items:center;justify-content:flex-start;gap:8px;min-height:44px;min-width:0;padding:8px 16px;border-radius:0;color:var(--ink);font-size:var(--fs-3);font-weight:400;text-align:left;text-decoration:none}
.menu a[aria-current=true]{font-weight:600}
.menu .mark{width:1.25em;flex:none;text-align:center}
.group-label{margin:18px 0 8px;font-size:var(--fs-2);font-weight:400;color:var(--muted)}
.inset-group{background:var(--card);border-radius:var(--r-2);overflow:hidden}
.notebook-list{list-style:none;margin:0;padding:0}
.notebook-list>li{max-width:none;border:0}
.notebook-entry{position:relative;min-width:0;background-image:linear-gradient(var(--line),var(--line));background-repeat:no-repeat;background-size:calc(100% - 80px) 1px;background-position:right top}
.notebook-entry:first-child{background-image:none}
.notebook-card{display:flex;align-items:center;width:100%;min-height:68px;padding:8px 16px;color:var(--ink);background:transparent;border:0;border-radius:0;text-decoration:none;text-align:left;font:inherit;cursor:pointer;scroll-margin-top:16px}
.notebook-line{display:flex;align-items:center;gap:12px;width:100%;min-width:0}
.notebook-thumb{width:52px;height:52px;flex:none;object-fit:cover;border-radius:10px;background:var(--surround)}
.notebook-card .row-text{min-width:0;flex:1}
.notebook-card .excerpt{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:var(--fs-3)}
.notebook-card .meta-line,.choose-list .meta-line,.list .meta-line{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-wrap:nowrap}
.notebook-status{flex:none;font-size:var(--fs-1);font-weight:600;white-space:nowrap}
.notebook-selection-page{padding-bottom:calc(max(var(--bar-h,0px),12rem) + env(safe-area-inset-bottom))}
.notebook-selection-page .caption-flow{display:none}
.notebook-selection-page .next-bar .bar-caption{display:block}.notebook-bar-hint{text-align:center;margin:0}
.notebook-selection-page .chev{display:none}
.notebook-selection-page .notebook-card{padding-right:56px}
.notebook-choice{position:absolute;right:6px;top:0;bottom:0;margin:auto;width:44px;height:44px;display:flex;align-items:center;justify-content:center}
.notebook-choice input{position:absolute;inset:0;margin:0;opacity:0}
.notebook-choice input:focus{outline:3px solid var(--focus);outline-offset:2px}
.notebook-choice .mark{color:var(--accent);font-size:1.25rem;font-weight:700;visibility:hidden}
.notebook-choice:has(input:checked) .mark{visibility:visible}
.notebook-choice:has(input:disabled){opacity:.45}
.notebook-choice:has(input:focus-visible){outline:3px solid var(--focus);outline-offset:2px;border-radius:10px}
.notebook-note{display:block;padding:0 16px 10px 80px}
.notebook-chapters{border:1px solid var(--line);border-radius:var(--r-1);padding:8px 12px;min-width:0;margin:16px 0}
.notebook-chapters legend{font-size:var(--fs-2);padding:0 4px}
main{padding:var(--s-2) var(--page-inset) 0;max-width:576px;margin:0 auto;overflow-wrap:anywhere}
h1{font-size:var(--fs-5);font-weight:700;letter-spacing:-.025em;line-height:1.25;margin:0 0 var(--s-4);text-wrap:balance}
h2{font-size:var(--fs-4);font-weight:650;line-height:var(--lh-tight);margin:var(--s-6) 0 var(--s-3);text-wrap:balance}
p{margin:var(--s-2) 0}
p,li{text-wrap:pretty}
/* 短句（列表项、选项、标签、说明行、标题）按词组断行：字与字之间不断，只在标点、空格处换行，「「相 / 机」」这类拆词不再出现；
   一句太长、没有断点时才在任意处断。长段落照常按字换行（中文排版的惯例），其中的「」引语由 .q 保持在同一行。 */
legend,.field-label,.steps-text li,.row-text{word-break:keep-all;overflow-wrap:anywhere}
/* 小字说明行（科目 · 知识点、状态）：按字断行再平衡成两行，长词（「一元一次方程」）在窄的地方不会被硬拆出一个字 */
.meta-line{word-break:normal;overflow-wrap:anywhere;text-wrap:balance}
/* 题干摘录、底栏说明：正常按字断行（keep-all 放不下时会硬拆，把「：」「，」拆到行首），标点规则由 line-break: strict 管 */
.meta-line.excerpt,.caption,.caption-flow{word-break:normal;overflow-wrap:normal}
.meta-line.excerpt{text-wrap:wrap}
/* 卡片标题、清单行的步骤名和说明、按钮、链接：用 Phrased 按词组分段（phrases.ts），段内正常断行，标点不落行首（line-break: strict） */
/* 大标题只有一行放不下时才换行（页面缩放 200% 时）：按字断再平衡成两行，不会剩一个字（「说说为什么 / 错」→「说说为 / 什么错」） */
/* 选项文字不用 keep-all（一个词组放不下时会被硬拆出单字）：由 ChoiceText 按词组分成不可拆的小块，再平衡成一到两行 */
.choice-text{text-wrap:balance;overflow-wrap:anywhere}
.q{white-space:nowrap}
main p,main li{max-width:32em}
.muted{color:var(--muted)}.small{font-size:var(--fs-2)}
.lead{margin:calc(var(--s-1) * -1) 0 var(--s-5);color:var(--muted)}
.lead.practice-intro{margin-top:var(--s-3)}
.submission-photos{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px}.submission-photos figure{margin:0;min-width:0}.submission-photos img{width:100%;max-height:240px;object-fit:contain;border-radius:12px}.submission-photos figcaption{font-size:.85rem;color:var(--muted);margin:6px 0 12px}
.practice-task-actions{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}
.practice-task-actions>.btn,.practice-task-actions>form{flex:1 1 180px;min-width:0}
.practice-task-actions form .btn{width:100%}
.practice-task-actions .more{flex-basis:100%}
/* 短的中文说明按词组和标点断行（keep-all），平衡行宽时不会把「完成」拆成两行；没有标点的长串仍可在任意处换行。
   底栏说明不用：无脚本时底栏按固定高度留位，大字下多折一行会盖住页面最后一行。 */
.lead,.hint,.small,.steps-text li,.flash{text-wrap:balance}
.lead,.hint,.small,.flash,.page-subtitle,.group-footer{word-break:keep-all;overflow-wrap:anywhere}
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
.ph{display:inline-block;word-break:normal}
/* 链接后面的「›」贴在最后一个词组里，不单独换到下一行 */
.chev-i{margin-left:var(--s-1)}
.sheet-toggle .when-open,.sheet-toggle[aria-expanded=true] .when-closed{display:none}
.sheet-toggle[aria-expanded=true] .when-open{display:inline}
/* 底栏那行说明的第二份，平时不显示（视口很矮时才显示，见底栏那一段） */
.caption-flow{display:none}
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
.settings-page{--bar-h:0px}
.settings-list{margin:var(--s-4) 0 0;padding:0}
.settings-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--s-2) var(--s-4);min-height:56px;padding:var(--s-2) 0;border-bottom:1px solid var(--line)}
.settings-row dd{margin:0 0 0 auto;max-width:100%;color:var(--muted);text-align:right}
.settings-connection{display:flex;align-items:center;gap:var(--s-2)}
.settings-connection .link-btn{margin:0;min-height:var(--tap)}
.settings-link{display:flex;align-items:center;justify-content:space-between;gap:var(--s-4);min-height:56px;padding:var(--s-2) 0;border-bottom:1px solid var(--line);text-decoration:none;color:inherit}
.settings-logout{margin:var(--s-5) 0}
.settings-logout .link-btn{min-height:var(--tap);padding:0;margin:0;color:var(--red)}
.settings-logout .hint{margin:var(--s-1) 0}
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
/* 追加入口不随照片说明拉高；各列可收缩，避免宽高比反向撑宽列并溢出网格。 */
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));align-items:start;gap:var(--s-2);margin:var(--s-3) 0}
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
textarea,input[type=text],input[type=tel],input[type=date],select{width:100%;font:inherit;line-height:var(--lh-tight);color:var(--ink);background:var(--card);border:1px solid var(--field);border-radius:var(--r-1);padding:var(--s-3) var(--s-4);min-height:52px;scroll-margin-top:12px;scroll-margin-bottom:calc(var(--bar-h,200px) + var(--keyboard-inset,0px) + 16px)}
textarea:focus,input[type=text]:focus,input[type=tel]:focus,select:focus{border-color:var(--teal)}
textarea[aria-invalid=true],input[aria-invalid=true],select[aria-invalid=true]{border-color:var(--red);box-shadow:inset 0 0 0 1px var(--red)}
.field-error{color:var(--red);font-size:var(--fs-2);font-weight:600;line-height:var(--lh-tight);margin:var(--s-1) 0 var(--s-2)}
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
.voice .voice-note,.voice .voice-wait{flex-basis:100%}
.voice .voice-wait:empty{display:none}
.voice .voice-note+.voice-wait{margin-top:calc(var(--s-2) * -1)}
.voice .voice-note:empty{display:none}
.voice button.hidden{display:none}
/* 开着麦克风：音量条（7 根，按音量分 6 档，只动 transform）+ 计时 */
.voice-live{display:inline-flex;align-items:center;gap:var(--s-2) var(--s-3);flex-wrap:wrap}
.voice-live.hidden{display:none}
.meter{display:inline-flex;align-items:center;gap:3px;height:28px}
.meter i{display:block;width:4px;height:28px;border-radius:2px;background:var(--teal);transform:scaleY(.12);transition:transform var(--dur-1) var(--ease)}
.meter[data-level="0"] i{opacity:.45}
.meter[data-level="0"] i:nth-child(1){transform:scaleY(0.12)}
.meter[data-level="0"] i:nth-child(2){transform:scaleY(0.12)}
.meter[data-level="0"] i:nth-child(3){transform:scaleY(0.12)}
.meter[data-level="0"] i:nth-child(4){transform:scaleY(0.12)}
.meter[data-level="0"] i:nth-child(5){transform:scaleY(0.12)}
.meter[data-level="0"] i:nth-child(6){transform:scaleY(0.12)}
.meter[data-level="0"] i:nth-child(7){transform:scaleY(0.12)}
.meter[data-level="1"] i:nth-child(1){transform:scaleY(0.15)}
.meter[data-level="1"] i:nth-child(2){transform:scaleY(0.24)}
.meter[data-level="1"] i:nth-child(3){transform:scaleY(0.3)}
.meter[data-level="1"] i:nth-child(4){transform:scaleY(0.21)}
.meter[data-level="1"] i:nth-child(5){transform:scaleY(0.27)}
.meter[data-level="1"] i:nth-child(6){transform:scaleY(0.18)}
.meter[data-level="1"] i:nth-child(7){transform:scaleY(0.12)}
.meter[data-level="2"] i:nth-child(1){transform:scaleY(0.25)}
.meter[data-level="2"] i:nth-child(2){transform:scaleY(0.4)}
.meter[data-level="2"] i:nth-child(3){transform:scaleY(0.5)}
.meter[data-level="2"] i:nth-child(4){transform:scaleY(0.35)}
.meter[data-level="2"] i:nth-child(5){transform:scaleY(0.45)}
.meter[data-level="2"] i:nth-child(6){transform:scaleY(0.3)}
.meter[data-level="2"] i:nth-child(7){transform:scaleY(0.2)}
.meter[data-level="3"] i:nth-child(1){transform:scaleY(0.35)}
.meter[data-level="3"] i:nth-child(2){transform:scaleY(0.56)}
.meter[data-level="3"] i:nth-child(3){transform:scaleY(0.7)}
.meter[data-level="3"] i:nth-child(4){transform:scaleY(0.49)}
.meter[data-level="3"] i:nth-child(5){transform:scaleY(0.63)}
.meter[data-level="3"] i:nth-child(6){transform:scaleY(0.42)}
.meter[data-level="3"] i:nth-child(7){transform:scaleY(0.28)}
.meter[data-level="4"] i:nth-child(1){transform:scaleY(0.42)}
.meter[data-level="4"] i:nth-child(2){transform:scaleY(0.68)}
.meter[data-level="4"] i:nth-child(3){transform:scaleY(0.85)}
.meter[data-level="4"] i:nth-child(4){transform:scaleY(0.59)}
.meter[data-level="4"] i:nth-child(5){transform:scaleY(0.77)}
.meter[data-level="4"] i:nth-child(6){transform:scaleY(0.51)}
.meter[data-level="4"] i:nth-child(7){transform:scaleY(0.34)}
.meter[data-level="5"] i:nth-child(1){transform:scaleY(0.5)}
.meter[data-level="5"] i:nth-child(2){transform:scaleY(0.8)}
.meter[data-level="5"] i:nth-child(3){transform:scaleY(1)}
.meter[data-level="5"] i:nth-child(4){transform:scaleY(0.7)}
.meter[data-level="5"] i:nth-child(5){transform:scaleY(0.9)}
.meter[data-level="5"] i:nth-child(6){transform:scaleY(0.6)}
.meter[data-level="5"] i:nth-child(7){transform:scaleY(0.4)}
.voice-time{font-weight:600;font-variant-numeric:tabular-nums;min-width:2.6em}
.heard{display:none}
@media (prefers-reduced-motion:reduce){.meter{display:none}.heard{display:inline}}
.progress{height:8px;border-radius:var(--r-pill);background:var(--line);overflow:hidden;margin:var(--s-2) 0}
.progress i{display:block;height:100%;background:var(--teal);transform-origin:left center;transform:scaleX(0);transition:transform var(--dur-3) var(--ease)}
.upload-list{list-style:none;padding:0;margin:var(--s-3) 0}
.upload-item{padding:var(--s-2) 0;border-bottom:1px solid var(--line)}
.upload-name{font-weight:600;overflow-wrap:anywhere}
[data-photo-grid] figcaption{overflow-wrap:anywhere}
label[aria-disabled=true]{opacity:.6;cursor:default}
.wait-line{color:var(--muted);margin:var(--s-2) 0 0;font-variant-numeric:tabular-nums}
details{margin:var(--s-3) 0}
summary{cursor:pointer;font-weight:600;min-height:var(--tap);padding:10px 0;line-height:24px}
/* 展开控件：系统实心 ▶ 换成行首 chevron，收起向右、展开向下。菜单、弹层和自带样式的 .disclosure 不受影响。 */
:where(details:not(.pop-menu,.week-overview,.today-install))>summary{display:flex;align-items:center;gap:10px;list-style:none}
:where(details:not(.pop-menu,.week-overview,.today-install))>summary::-webkit-details-marker{display:none}
:where(details:not(.pop-menu,.week-overview,.today-install,.disclosure))>summary::before{content:"";width:7px;height:7px;flex:none;margin:0 2px;border-right:1.8px solid var(--muted);border-bottom:1.8px solid var(--muted);transform:rotate(-45deg);transition:transform var(--dur-1) var(--ease)}
:where(details[open]:not(.pop-menu,.week-overview,.today-install,.disclosure))>summary::before{transform:rotate(45deg)}
@media (forced-colors:active){:where(details:not(.pop-menu,.week-overview,.today-install,.disclosure))>summary::before{border-color:CanvasText}}
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
.next-bar{position:fixed;left:0;right:0;bottom:var(--keyboard-inset,0px);z-index:10;background:var(--bar-solid);
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
border-radius:var(--r-pill);min-height:52px;min-width:0;padding:var(--s-3) var(--s-5);cursor:pointer;border:1px solid transparent;background:var(--mint);color:var(--teal);flex:1;-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:background-color .16s ease,box-shadow .16s ease,filter .16s ease}
.btn.primary{background:var(--teal);color:var(--on-teal);box-shadow:none}
.btn.secondary{background:var(--surround);color:var(--ink);border-color:transparent}
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
/* 状态变化时的小动效；跨文档跳页保持浏览器原生行为。 */
/* 很窄的视口（页面缩放 200% 时只剩约 195 CSS px）：内边距收一点，节奏条三格竖着排，A4 缩略图放到说明下面——
   给文字留出一行四五个字的宽度，标题、清单行按词组断行时不会剩一个字 */
@media (max-width:300px){
  main{padding:0 var(--s-2)}
  .card{padding:var(--s-3)}
  .steps a,.steps .row{gap:var(--s-2);padding:var(--s-2) var(--s-1)}
  .rhythm{flex-direction:column}
  .rhythm li{display:flex;justify-content:center;gap:var(--s-2)}
  .sheet-box[data-open=false]>.sheet-frame{grid-column:1/-1;grid-row:auto;margin-top:var(--s-2)}
  .choices-inline .choice{flex-basis:100%}
}
/* 视口很矮（页面缩放 200%、横着拿手机）：底栏只留按钮，说明挪到内容最后；按钮紧凑一点。底栏不超过视口的一半，主按钮一直在 */
@media (max-height:560px){
  .next-bar{padding-top:var(--s-1)}
  .next-bar .inner{gap:var(--s-1)}
  .next-bar .bar-caption{display:none}
  .caption-flow{display:block;margin:var(--s-4) 0 0}
  .caption-flow:empty{display:none}
  .next-bar .btn{min-height:var(--tap);padding:var(--s-2) var(--s-3)}
}
/* 新出现的内容（结果、找到的题、换上来的状态）：从下往上浮现 */
@keyframes rise{from{opacity:0;transform:translateY(8px)}}
/* 打勾：✓ 弹出来 */
@keyframes pop{0%{opacity:0;transform:scale(.3)}60%{opacity:1;transform:scale(1.15)}100%{opacity:1;transform:none}}
/* 点了一下：轻轻按下去 */
@keyframes press{50%{transform:scale(.97)}}
/* 主按钮换了字：新字从下面滑进来 */
@keyframes swap{from{opacity:0;transform:translateY(6px)}}
.tick{display:inline-block}
.m-rise{animation:rise var(--dur-3) var(--ease) both}
.m-pop{animation:pop var(--dur-3) var(--ease) both}
.m-press{animation:press var(--dur-1) var(--ease)}
.m-swap{animation:swap var(--dur-2) var(--ease) both}
.m-stagger>*{animation:rise var(--dur-3) var(--ease) both}
.m-stagger>:nth-child(2){animation-delay:60ms}.m-stagger>:nth-child(3){animation-delay:120ms}.m-stagger>:nth-child(4){animation-delay:180ms}.m-stagger>:nth-child(n+5){animation-delay:240ms}
/* 减少动态效果：全部关掉（页与页之间也是普通跳转）。转圈换成不动的圆环，录音的音量条换成一行字。 */
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation:none!important;transition:none!important}
}
body:has(#camera-input:focus-visible) label[for=camera-input],body:has(#library-input:focus-visible) label[for=library-input]{outline:3px solid var(--focus);outline-offset:3px}
/* 只在有 / 没有脚本时出现的东西：按浏览器的 scripting 媒体特性判断（脚本 defer 加载，不等它加 .js 类，首屏不跳）；老浏览器退回 .js 类 */
.js .no-js-only{display:none!important}
.js-only{display:none!important}
.js .js-only{display:revert!important}
.js .js-only.btn{display:flex!important}
@media (scripting:enabled){.no-js-only{display:none!important}.js-only{display:revert!important}.js-only.btn{display:flex!important}}
.hidden{display:none!important}
.visually-hidden{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.status{display:inline-block;font-size:var(--fs-1);font-weight:600}
.a2hs{border:1px solid var(--line);box-shadow:none}
.standalone .a2hs{display:none!important}
/* 全局导航与当前任务分开；正文只有实色分组，材质只用于悬浮导航。 */
/* 保留常规字号下的 106px；放大文字时同步增加留白，让末尾操作能滚到导航上方。 */
body.has-tabbar{padding-bottom:calc(6.625rem + env(safe-area-inset-bottom))}
html:has(body.has-tabbar){scroll-padding-bottom:calc(6.625rem + env(safe-area-inset-bottom))}
.tab-bar{position:fixed;z-index:15;left:12px;right:12px;bottom:calc(8px + env(safe-area-inset-bottom));max-width:552px;margin:0 auto;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;padding:5px 6px;border:1px solid var(--line);border-radius:29px;background:var(--bar-solid);box-shadow:var(--bar-shadow)}
.tab-bar a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:54px;min-width:44px;padding:5px 8px;border-radius:23px;font-size:.75rem;line-height:1.3;font-weight:600;text-decoration:none;color:var(--muted)}
.tab-bar svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:none}
.tab-bar a[aria-current=page]{color:var(--accent);background:var(--mint)}
.tab-bar a[aria-current=page] svg{stroke-width:2.2}
@supports ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){.tab-bar{background:var(--bar);-webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px)}}
.next-bar-inline{position:static;padding:var(--s-4) 0 0;background:transparent;border:0;box-shadow:none;-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
.next-bar-inline .inner{max-width:none;gap:var(--s-3)}
.next-bar-inline .caption{display:block;text-align:left;font-size:var(--fs-1)}
.next-bar-inline .bar-main{order:1}
.next-bar-inline .bar-alt{order:2;justify-content:flex-start;margin:calc(var(--s-2) * -1) 0 0}
.next-bar-inline .bar-alt .btn{padding:var(--s-2) 0;justify-content:flex-start}
.next-bar-inline .btn.primary{min-height:52px}

/* 新增录入：工具栏符号 + 底部同尺寸主次按钮。历史照片单独一页。 */
.capture-page .top{position:relative;z-index:20}
.capture-page.has-tabbar{padding-bottom:calc(18rem + env(safe-area-inset-bottom))}
.capture-actions{position:fixed;z-index:12;left:0;right:0;bottom:calc(6.625rem + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:12px;width:min(536px,100%);margin:0 auto;padding:8px var(--page-inset) 4px;background:linear-gradient(transparent,var(--paper) 28%)}
.capture-actions .btn{width:100%;flex:none}
.tip-list{list-style:none;margin:8px 0;padding:0}
.tip-list li{display:flex;gap:12px;align-items:flex-start;padding:12px 16px;min-height:64px}
.tip-list li+li{box-shadow:inset 0 1px 0 var(--line)}
.tip-icon{width:32px;height:32px;flex:none;display:flex;align-items:center;justify-content:center;border-radius:8px;margin-top:2px}
.tip-icon svg{width:18px;height:18px;stroke:#fff;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.tip-list b{display:block;font-weight:600}
.tip-list span{display:block;color:var(--muted);font-size:var(--fs-2)}
.popup-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:4px 16px}
.popup-row label{font-weight:600}
.popup-value{position:relative;display:flex;align-items:center}
.popup-value select{appearance:none;-webkit-appearance:none;width:auto;max-width:12rem;border:0;background:transparent;color:var(--muted);font:inherit;text-align:right;min-height:44px;padding:0 22px 0 8px}
.popup-value select:focus{border-color:transparent}
/* 弹出按钮的上下箭头：画出来的一对 chevron，和系统弹出按钮一致；不用两个文字符号拼。 */
.popup-value::after{content:"";position:absolute;right:2px;top:50%;width:9px;height:14px;margin-top:-7px;background:var(--muted);pointer-events:none;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 9 14'%3E%3Cpath d='M1.5 5 4.5 2l3 3M1.5 9l3 3 3-3' fill='none' stroke='%23000' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 9 14'%3E%3Cpath d='M1.5 5 4.5 2l3 3M1.5 9l3 3 3-3' fill='none' stroke='%23000' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/contain no-repeat}
@media (forced-colors:active){.popup-value::after{background:CanvasText}}
.settings-page .inset-group{margin:12px 0}
.settings-page .settings-list,.settings-page .settings-link{margin:0}
/* 分组里的行和其他分组列表一样左右各留 16px，分隔线从文字处开始；最后一行不画线。 */
.settings-page .inset-group .settings-row,.settings-page .inset-group .settings-link{padding:var(--s-2) 16px;border-bottom:0;background-image:linear-gradient(var(--line),var(--line));background-repeat:no-repeat;background-size:calc(100% - 16px) 1px;background-position:right bottom}
.settings-page .inset-group>:last-child,.settings-page .inset-group .settings-list:last-child>.settings-row:last-child{background-image:none}
.settings-page .settings-link .chev{color:var(--muted);font-size:var(--fs-4);line-height:1}
.settings-page .group-footer{margin:6px 16px 16px}
.choose-list .choice.pick{align-items:center;margin:0;padding:10px 12px;border:0;border-radius:0;background:transparent;box-shadow:none}
.choose-list .choice.pick+.choice.pick{box-shadow:inset 0 1px 0 var(--line)}
.choose-list .choice.pick:has(input:checked){border-color:transparent;background:transparent;box-shadow:inset 0 1px 0 var(--line)}
.choose-list .choice.pick:first-child:has(input:checked){box-shadow:none}
.choose-list .choice.pick .grow{display:flex;align-items:center;gap:12px;min-width:0}
.choose-list .choice.pick .row-text{min-width:0}
.choose-list .excerpt{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.choose-list .choice.pick .notebook-thumb{margin:0}
.choose-list .mark{width:28px;flex:none;text-align:center;color:var(--accent);font-size:1.35rem;font-weight:700;visibility:hidden}
.choose-list .choice.pick:has(input:checked) .mark{visibility:visible}
.choose-list .choice.pick input{position:absolute;width:44px;height:44px;opacity:0}
.choose-list .choice.pick{position:relative}
.group-footer{margin:8px 16px 0;color:var(--muted);font-size:var(--fs-2)}
/* 学习材料：叠放胶囊按钮留 12px（间距刻度 8–12）；去下一屏用内嵌列表行，展开用披露行，不再用裸蓝字或系统 ▶。 */
.material-surface .btn-stack{display:flex;flex-direction:column;align-items:stretch;gap:var(--s-3);margin:var(--s-4) 0}
.material-surface .btn-stack>.btn{width:100%;flex:none}
.material-surface .inset-group{margin:12px 0}
.material-surface .group-label{margin:22px 16px 8px}
.material-surface .group-footer{margin:6px 16px 18px}
.material-surface .group-pad{padding:16px 16px 4px}
.material-surface .group-pad>h2{margin:0 0 8px;font-size:var(--fs-4)}
.material-surface .group-pad .btn{margin:12px 0 8px}
/* 待收录分组：隐藏字段不算一行；只在照片与照片之间画分隔线。 */
.material-surface .inset-group.group-pad>*+*:not(.row-detail){background-image:none}
.material-surface .group-pad>div+div{margin-top:4px;padding-top:12px;border-top:1px solid var(--line)}
.material-surface .nav-title{margin:0;font-size:inherit;font-weight:inherit;line-height:inherit}
.material-surface a.nav-row,.material-surface button.nav-row{display:flex;align-items:center;gap:12px;width:100%;min-height:52px;padding:12px 16px;border:0;background:transparent;color:var(--ink);font:inherit;font-weight:600;line-height:var(--lh-tight);text-align:left;text-decoration:none;cursor:pointer}
.material-surface .nav-row .row-text{flex:1;min-width:0}
.material-surface .nav-row .chev{flex:none}
.material-surface .asset-row{display:flex;align-items:center;gap:12px;min-height:84px;padding:12px 16px;text-decoration:none;color:inherit}
.material-surface .asset-row h3{margin:0;font-size:var(--fs-3);font-weight:600;line-height:var(--lh-tight)}
.material-surface .asset-thumb{width:64px;height:64px;flex:none;object-fit:contain;object-position:center;border-radius:10px;background:var(--surround)}
.material-surface .asset-row .meta-line{white-space:normal;overflow:visible;text-overflow:clip;text-wrap:pretty}
.material-surface .break-anywhere{overflow-wrap:anywhere}
.material-surface .row-detail{padding:0 16px 10px}
.material-surface .row-detail p{margin:4px 0}
.material-surface .inset-group>*+*:not(.row-detail){background-image:linear-gradient(var(--line),var(--line));background-repeat:no-repeat;background-size:calc(100% - 16px) 1px;background-position:right top}
.material-surface .disclosure>summary{display:flex;align-items:center;gap:12px;min-height:52px;padding:12px 16px;list-style:none;cursor:pointer;font-weight:600;color:var(--ink)}
.material-surface .disclosure>summary::-webkit-details-marker{display:none}
.material-surface .disclosure>summary::after{content:"";width:7px;height:7px;margin-left:auto;flex:none;border-right:1.8px solid var(--muted);border-bottom:1.8px solid var(--muted);transform:rotate(-45deg)}
.material-surface .disclosure[open]>summary::after{transform:rotate(45deg)}
.material-surface .disclosure-body{padding:4px 16px 16px}
.material-surface .disclosure-body>:first-child{margin-top:0}
.material-surface .disclosure .disclosure{margin:8px 0 4px;background:var(--paper);border-radius:var(--r-control);overflow:hidden}
.material-surface .card>.nav-row,.material-surface .card>.disclosure{margin-left:-20px;margin-right:-20px}
.material-surface .card>.nav-row,.material-surface .card>.disclosure>summary{background-image:linear-gradient(var(--line),var(--line));background-repeat:no-repeat;background-size:calc(100% - 16px) 1px;background-position:right top}
.material-surface .disclosure-body .btn-stack{margin:12px 0 0}
.material-surface .disclosure-body .btn-stack>.btn{margin-top:0}
.material-surface .disclosure-body form>.btn,.material-surface .disclosure-body>.btn{margin-top:12px}
.material-surface .disclosure-body>.nav-row{margin:8px -16px 0;background-image:linear-gradient(var(--line),var(--line));background-repeat:no-repeat;background-size:calc(100% - 16px) 1px;background-position:right top}
.material-surface .inset-group>form .btn{margin:12px 16px;width:calc(100% - 32px)}
.material-surface .retry-card>.row-detail{padding:12px 16px 0}
.material-surface .retry-card>.btn-stack{padding:0 16px 16px;margin:0}
@media (hover:hover){.material-surface a.nav-row:hover,.material-surface .asset-row:hover,.material-surface .disclosure>summary:hover{background-color:color-mix(in srgb,var(--ink) 4%,transparent)}}
.material-surface a.nav-row:active,.material-surface .asset-row:active,.material-surface .disclosure>summary:active{background-color:color-mix(in srgb,var(--ink) 8%,transparent)}
@media (forced-colors:active){.material-surface .inset-group{border:1px solid CanvasText}}
/* 学习材料：内容在前（原图裁切 + 文字），工具收进默认折叠的分组；整理工具整组折叠。 */
.material-surface .tools{margin:12px 0}
.material-surface .tools>summary{background:var(--card);border-radius:var(--r-2)}
.material-surface .tools[open]>summary{margin-bottom:4px}
.material-surface .tools>summary .row-text{flex:1;min-width:0}
.material-surface .summary-detail{display:block;margin-top:2px;font-weight:400;font-size:var(--fs-2);color:var(--muted)}
.material-surface .material-block>h2{margin:0 0 8px;font-size:var(--fs-4)}
.material-surface .material-block figure{margin:0}
.material-surface .material-block .crop{height:auto;max-height:240px}
.material-surface .material-block figure+figure{margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
.material-surface .material-block figcaption{margin:4px 0 0}
.material-surface .material-block .hint{margin:4px 0 0}
.material-surface .capture-count{font-weight:600;margin:16px 0 4px}
.capture-thumbs{display:flex;gap:8px;list-style:none;margin:8px 0;padding:0;overflow-x:auto}
.capture-thumbs img{display:block;width:56px;height:72px;object-fit:cover;border-radius:var(--r-1);background:var(--card)}
.capture-page:not(.has-tabbar){padding-bottom:calc(11rem + env(safe-area-inset-bottom))}
.capture-page:not(.has-tabbar) .capture-actions{bottom:0;padding-bottom:calc(12px + env(safe-area-inset-bottom))}
.practice-adjust{display:flex;align-items:center;justify-content:space-between;min-height:52px;margin:8px 0 12px;padding:0 16px;background:var(--card);border-radius:var(--r-2);color:var(--accent);text-decoration:none;font-weight:600}
.practice-cta{position:fixed;z-index:12;left:0;right:0;bottom:calc(6.625rem + env(safe-area-inset-bottom));width:min(536px,100%);margin:0 auto;padding:8px var(--page-inset) 4px}
.practice-cta .btn{width:100%}
body.has-tabbar:has(.practice-cta){padding-bottom:calc(13rem + env(safe-area-inset-bottom))}
.capture-page .upload-list{max-height:260px;overflow:auto;overscroll-behavior:contain}
.capture-page .upload-item{display:flow-root;min-height:72px}
.capture-page .upload-thumb{float:left;width:48px;height:60px;object-fit:contain;margin:0 var(--s-3) var(--s-2) 0;border-radius:var(--r-1);background:var(--card)}
.capture-page .upload-item p{margin:0 0 var(--s-1)}
.capture-examples{margin:var(--s-3) 0 var(--s-4)}
.capture-example-row{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);gap:var(--s-2);align-items:start}
.capture-example-row img{width:100%;height:auto;border-radius:var(--r-1);background:#fff;border:1px solid var(--line);display:block}
.capture-examples figcaption{margin:var(--s-2) 0 0;text-align:center}
.photo-record{display:flex;align-items:flex-start;gap:var(--s-3);padding:var(--s-4) 0}
.photo-preview{display:block;flex:0 0 84px;border-radius:var(--r-1)}
.photo-preview img{display:block;width:84px;height:104px;object-fit:contain;border-radius:var(--r-1);background:var(--mint);filter:var(--photo-dim)}
.photo-record-content{min-width:0;flex:1;overflow-wrap:anywhere}
.photo-record-content .more{margin-top:var(--s-2)}

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
.pending-photo-row{display:flex;align-items:center;justify-content:space-between;gap:var(--s-3);min-height:64px;margin-top:var(--s-4);padding:var(--s-3) 0;border-top:1px solid var(--line);color:var(--ink);text-decoration:none;border-radius:var(--r-1)}
.pending-photo-row>span:first-child{min-width:0;flex:1}
.pending-photo-title{font-weight:600}
.pending-photo-row:active{background:var(--mint)}
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
@supports (corner-shape:squircle){.today-focus,.today-library .list,.week-sheet,.card,.material-surface .inset-group{corner-shape:squircle}}
@media (min-width:720px){.week-sheet{inset:0;max-height:min(82dvh,780px);height:fit-content;margin:auto;border-radius:28px}.week-sheet .sheet-toolbar{border-radius:28px 28px 0 0}}
@media (max-width:360px){.today-focus{padding:20px}.week-sheet [data-sheet-content]{padding-left:20px;padding-right:20px}.week-overview>summary{gap:8px}}
@media (max-width:240px){.week-overview>summary{flex-wrap:wrap}.week-overview-label{flex-basis:100%}.week-overview-meta{flex:1;text-align:left}}
@media (prefers-reduced-motion:reduce){.week-sheet{transform:none!important;opacity:1;transition:none}}
.demo-reduce-motion .week-sheet{transform:none!important;opacity:1;transition:none}
@media (prefers-reduced-transparency:reduce){.tab-bar{background:var(--bar-solid);-webkit-backdrop-filter:none;backdrop-filter:none}}
@media (prefers-contrast:more){:root{--muted:#45454D;--line:#92929A;--field:#64646C}.tab-bar,.next-bar{background:var(--bar-solid);-webkit-backdrop-filter:none;backdrop-filter:none}}
@media (prefers-color-scheme:dark) and (prefers-contrast:more){:root{--muted:#D2D2D8;--line:#777780;--field:#A9A9B2}}
@media (forced-colors:active){.tab-bar,.week-sheet{border:1px solid CanvasText}.tab-bar a[aria-current=page]{outline:2px solid Highlight}}
@media print{.tab-bar,.week-sheet,.practice-fab,.capture-actions,.practice-cta{display:none!important}}
/* 打印页的首屏（纸面本身不变）：第 1 道按纸上的原样、原大小排出来；整张 A4 先是缩略图，点开看整张 */
.sheet-peek{background:transparent;margin-top:var(--s-3)}
.sheet-peek .peek-page{background:#fff;border-radius:var(--r-1);padding:0 4mm;box-shadow:0 1px 4px rgba(0,0,0,.18);overflow:hidden}
@media screen{.sheet-peek .peek-page{filter:var(--photo-dim)}}
@media screen{
  .sheet-box{background:var(--card);border:1px solid var(--line);border-radius:var(--r-2);padding:var(--s-4);margin:var(--s-3) 0;display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:var(--s-3);align-items:center}
  .sheet-box>.sheet-box-text{grid-column:1;margin:0}
  .sheet-box>.sheet-toggle{grid-column:1;justify-self:start;margin:0}
  .sheet-box>.sheet-frame{grid-column:1/-1;margin:var(--s-3) 0 0}
}
@media screen and (scripting:enabled){
  .sheet-box[data-open=false]>.sheet-frame{grid-column:2;grid-row:1/span 2;width:clamp(56px,25vw,96px);margin:0;padding:4px;cursor:zoom-in}
  .sheet-box[data-open=false] .sheet-wrap{height:auto!important;aspect-ratio:210/297}
}
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
  main>[data-live=print]{display:block!important}
  main>[data-live=print]>*:not(.print-root){display:none!important}
  main>[data-live=print]{animation:none!important}
  main{padding:0;max-width:none;margin:0}
  .sheet-frame{padding:0;margin:0;background:none;border-radius:0}
  .sheet-wrap{overflow:visible;height:auto!important;margin:0}
  .sheet-scale{transform:none!important;width:auto!important}
  .sheet .page{box-shadow:none;margin:0;break-after:page;page-break-after:always}
  .sheet .page:last-child{break-after:auto;page-break-after:auto}
  .print-root>:not(.sheet-frame){display:none!important}
}
`;

/** 浏览器脚本见 clientScript.ts（结构与各个小功能的说明都在那里）。 */
export { CLIENT_SCRIPT };

/**
 * 带内容指纹的静态资源（/s/assets/app.<10 位 sha256>.css|js）：内容变了文件名就变，所以可以让浏览器缓存一年（immutable）；
 * 页面、Service Worker 的外壳清单都引用带指纹的名字。ASSET_VERSION 由两个指纹算出，Service Worker 的缓存名跟着换。
 */
const fingerprint = (text: string): string => crypto.createHash('sha256').update(text).digest('hex').slice(0, 10);
// 保留脚本原文，避免用正则去注释误改字符串/正则字面量。指纹缓存仍减少重复下载。
export const STYLES_SERVED = STYLES;
export const SCRIPT_SERVED = CLIENT_SCRIPT;
export const STYLES_HASH = fingerprint(STYLES_SERVED);
export const SCRIPT_HASH = fingerprint(SCRIPT_SERVED);
export const ASSET_VERSION = fingerprint(`${STYLES_HASH}:${SCRIPT_HASH}`);
export const CSS_PATH = `/s/assets/app.${STYLES_HASH}.css`;
export const JS_PATH = `/s/assets/app.${SCRIPT_HASH}.js`;
/** 带指纹的资源：一年、不变。 */
export const IMMUTABLE = 'public, max-age=31536000, immutable';

/** 发布重启时代理返回空 5xx：Service Worker 合成的「正在更新」页多久自动重试一次。 */
export const SW_UPDATING_RETRY_SECONDS = 15;
/** Service Worker：只缓存外壳（离线页、样式、脚本、图标），学生数据一律不缓存（只在导航失败时换成离线页）。 */
export const SERVICE_WORKER = `const CACHE='sel-shell-${ASSET_VERSION}';
const SHELL=['/s/offline','${CSS_PATH}','${JS_PATH}','/s/assets/icon-192.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
// Only a real network failure of a GET navigation shows the offline page. A 5xx with a body (e.g. "人有点多") is shown as is;
// an empty 5xx means the proxy reached no app (restart during a release): say so and retry by itself.
// Form POST navigations (register, login, recover) are not intercepted. fetch() inside the worker
// replays a one-shot body and, on some Android browsers, rejects even while the radio is up.
// That catch used to replace the server's 400 validation page with the cached offline shell.
const UPDATING='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="${SW_UPDATING_RETRY_SECONDS}"><title>正在更新</title><style>body{font:17px/1.6 -apple-system,system-ui,sans-serif;margin:0;padding:24px 16px;background:#f2f2f7;color:#1c1c1e}@media (prefers-color-scheme:dark){body{background:#000;color:#f2f2f7}}a{display:inline-block;margin-top:12px;padding:12px 20px;border-radius:12px;background:#0a84ff;color:#fff;text-decoration:none}</style></head><body><h1 data-testid="updating-title">服务器正在更新</h1><p>一般不到一分钟就好。这一页每 ${SW_UPDATING_RETRY_SECONDS} 秒会自己重试，不用一直点。</p><p>传上去的照片和错题都在服务器上；还没传完的照片先存在这台手机上，回到拍照页会接着传。</p><a href="__URL__">现在重试</a></body></html>';
function updating(url,status){const safe=new URL(url).pathname.startsWith('/s')?new URL(url).pathname+new URL(url).search:'/s/';return new Response(UPDATING.replace('__URL__',safe.replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';')),{status:status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}})}
self.addEventListener('fetch',e=>{const r=e.request;
  if(r.mode==='navigate'&&r.method!=='GET')return;
  if(r.mode==='navigate'){e.respondWith(fetch(r).then(res=>res.status>=500?res.clone().text().then(t=>t.trim()?res:updating(r.url,res.status)).catch(()=>res):res).catch(()=>caches.match('/s/offline').then(o=>o||Response.error())));return}
  if(r.method==='GET'&&SHELL.some(p=>new URL(r.url).pathname+new URL(r.url).search===p)){e.respondWith(caches.match(r).then(c=>c||fetch(r)))}
});
`;

export type ManifestDisplay = 'standalone' | 'browser';
/**
 * display 按平台给：iOS 用 standalone（主屏幕图标全屏打开）；安卓给 browser。
 * 小米浏览器这类「添加到桌面」出来的壳没有实现文件选择器——文件框能拿到焦点，相册和相机却都弹不出来
 * （2026-10-25 红米实录）。发 browser 以后，桌面图标会在浏览器标签里打开，选择器才正常。
 */
export function manifest(display: ManifestDisplay = 'standalone'): Record<string, unknown> {
  return {
    name: APP_NAME, short_name: APP_SHORT_NAME, lang: 'zh-CN', dir: 'ltr',
    description: '纸错题延迟重做：周末拍卷子、选题打印，周中在纸上做，下个周末录结果。',
    start_url: '/s/', scope: '/s/', id: '/s/', display, orientation: 'portrait',
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
