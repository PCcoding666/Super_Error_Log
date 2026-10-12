/**
 * 学生网页版的静态资源。发布包只含 dist/（见 scripts/release-whitelist.txt），所以样式、脚本、
 * Service Worker、manifest 与图标都以 TypeScript 字符串形式随 tsc 编译进 dist，不放 public/。
 * 脚本只做浏览器必须做的事（上传进度、录音、选题计数、打印、按需显隐）；关掉脚本时每屏照样能用（语音除外）。
 */
import crypto from 'node:crypto';
import sharp from 'sharp';
import { CLIENT_SCRIPT } from './clientScript.js';

export const APP_NAME = '超级错题本';
export const APP_SHORT_NAME = '错题本';
export const THEME_COLOR = '#1F615C';
/** 深色模式下状态栏的颜色（= 深色纸色），不让青绿压在深色界面上面。 */
export const THEME_COLOR_DARK = '#17191C';
export const BACKGROUND_COLOR = '#F7F5ED';

export const STYLES = `
/* ---------- 设计 token（浅色 / 深色两套；所有颜色只从这里取） ----------
   文字对比（WCAG 公式）：浅色下 muted/blue/orange/green/red 在纸色、卡片、薄荷底上都 ≥ 4.9:1；
   深色下 ≥ 4.8:1。--field 是输入框与选项的边框（对卡片与纸色 ≥ 3:1，WCAG 1.4.11）；--line 只做分隔线。 */
:root{color-scheme:light dark;
--paper:#F7F5ED;--card:#FFFFFF;--ink:#1F3338;--muted:#56656A;--teal:#1F615C;--on-teal:#FFFFFF;--mint:#DDEBDE;--line:#DBE0D6;--field:#7F8A83;
--gray:#56656A;--blue:#2557B8;--orange:#9E4708;--green:#196B42;--red:#AE2F24;
--bar:rgba(247,245,237,.96);--disabled-bg:#E3E8E1;--disabled-ink:#56656A;--focus:#1F615C;--surround:#E4E1D5;--photo-dim:none;
/* 字阶：5 级（13 / 15 / 17 / 20 / 28 px），按 rem 写，跟着系统和浏览器的字号设置走 */
--fs-1:.8125rem;--fs-2:.9375rem;--fs-3:1.0625rem;--fs-4:1.25rem;--fs-5:1.75rem;
--lh-text:1.65;--lh-tight:1.3;
/* 间距 4/8 刻度；圆角 3 种 */
--s-1:4px;--s-2:8px;--s-3:12px;--s-4:16px;--s-5:24px;--s-6:32px;
--r-1:10px;--r-2:16px;--r-pill:999px;
--tap:44px;
/* 动效：三档时长、一条缓动曲线；只动 transform / opacity。每个动效都说明「刚发生了什么」或「下一步是什么」 */
--dur-1:150ms;--dur-2:220ms;--dur-3:300ms;--ease:cubic-bezier(.2,.8,.2,1)}
@media (prefers-color-scheme:dark){:root{
--paper:#17191C;--card:#212629;--ink:#E8EDED;--muted:#A3ADAD;--teal:#6BB8AD;--on-teal:#0D1717;--mint:#263B36;--line:#3D4545;--field:#6F7B7A;
--gray:#A3ADAD;--blue:#7DADF4;--orange:#E8A35C;--green:#6BBF8A;--red:#EE8A79;
--bar:rgba(23,25,28,.96);--disabled-bg:#2C3335;--disabled-ink:#A3ADAD;--focus:#6BB8AD;--surround:#2A2F31;--photo-dim:brightness(.88)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);
font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif;
font-size:var(--fs-3);line-height:var(--lh-text);font-variant-numeric:tabular-nums;font-kerning:normal;
padding:env(safe-area-inset-top) 0 calc(var(--bar-h,200px) + var(--s-5))}
a{color:var(--teal)}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.top{display:flex;align-items:center;justify-content:space-between;gap:var(--s-2);padding:var(--s-1) var(--s-2);min-height:52px;max-width:576px;margin:0 auto}
.top a{display:inline-flex;align-items:center;gap:var(--s-1);min-height:var(--tap);min-width:var(--tap);justify-content:center;padding:0 var(--s-2);text-decoration:none;font-weight:600;border-radius:var(--r-1)}
.top a .chev-left{font-size:var(--fs-4);line-height:1}
main{padding:0 var(--s-4);max-width:576px;margin:0 auto}
h1{font-size:var(--fs-5);line-height:var(--lh-tight);margin:var(--s-1) 0 var(--s-3);text-wrap:balance}
h2{font-size:var(--fs-4);line-height:var(--lh-tight);margin:var(--s-5) 0 var(--s-2);text-wrap:balance}
p{margin:var(--s-2) 0}
p,li{text-wrap:pretty}
/* 短句（列表项、选项、标签、说明行、标题）按词组断行：字与字之间不断，只在标点、空格处换行，「「相 / 机」」这类拆词不再出现；
   一句太长、没有断点时才在任意处断。长段落照常按字换行（中文排版的惯例），其中的「」引语由 .q 保持在同一行。 */
main h2,legend,.field-label,.caption,.steps-text li,.meta-line,.row-text,.step-detail{word-break:keep-all;overflow-wrap:anywhere}
/* 大标题只有一行放不下时才换行（页面缩放 200% 时）：按字断再平衡成两行，不会剩一个字（「说说为什么 / 错」→「说说为 / 什么错」） */
/* 选项文字不用 keep-all（一个词组放不下时会被硬拆出单字）：由 ChoiceText 按词组分成不可拆的小块，再平衡成一到两行 */
.choice-text{text-wrap:balance;overflow-wrap:anywhere}
.q{white-space:nowrap}
main p,main li{max-width:32em}
.muted{color:var(--muted)}.small{font-size:var(--fs-2)}
.lead{margin-top:0}
.lead,.hint,.small,.steps-text li,.flash{text-wrap:balance}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r-2);padding:var(--s-4);margin:var(--s-3) 0}
.card>:first-child{margin-top:0}.card>:last-child{margin-bottom:0}
.card-title{font-size:var(--fs-4);line-height:var(--lh-tight);font-weight:600;margin:0 0 var(--s-2)}
.flash{border-radius:var(--r-2);padding:var(--s-3) var(--s-4);margin:var(--s-3) 0;background:var(--mint)}
.flash.err{background:color-mix(in srgb,var(--red) 14%,var(--card));color:var(--ink)}
.tone-teal{color:var(--teal)}.tone-gray{color:var(--gray)}.tone-blue{color:var(--blue)}.tone-orange{color:var(--orange)}.tone-green{color:var(--green)}.tone-red{color:var(--red)}
.rhythm{display:flex;gap:var(--s-1);margin:var(--s-1) 0 var(--s-3);padding:0;list-style:none}
.rhythm li{flex:1;text-align:center;font-size:var(--fs-1);line-height:var(--lh-tight);padding:var(--s-2) var(--s-1);border-radius:var(--r-1);background:var(--card);border:1px solid var(--line);color:var(--muted)}
.rhythm li.on{background:var(--teal);color:var(--on-teal);border-color:var(--teal)}
.rhythm b{display:block;font-size:var(--fs-1)}
.steps-head{display:flex;justify-content:space-between;align-items:baseline;gap:var(--s-2);margin:0}
.steps{list-style:none;margin:var(--s-2) 0 0;padding:0}
.steps a,.steps .row{display:flex;gap:var(--s-3);align-items:flex-start;text-decoration:none;color:inherit;padding:var(--s-3) var(--s-2);border-radius:var(--r-1);border:1.5px solid transparent;min-height:var(--tap)}
.steps .current{border-color:var(--teal);background:color-mix(in srgb,var(--teal) 6%,var(--card))}
.dot{flex:0 0 28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:var(--fs-1);font-weight:700;background:var(--mint);line-height:1}
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
.chev{color:var(--muted);font-weight:700}
.list{list-style:none;margin:0;padding:0}
.list>li{border-top:1px solid var(--line)}
.list>li:first-child{border-top:0}
.list a.row,.list .row{display:flex;gap:var(--s-3);align-items:center;padding:var(--s-3) var(--s-1);text-decoration:none;color:inherit;min-height:52px}
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
.choice{display:flex;gap:var(--s-3);align-items:center;padding:var(--s-3);border:1.5px solid var(--field);border-radius:var(--r-2);margin:var(--s-2) 0;background:var(--card);cursor:pointer;min-height:52px;line-height:var(--lh-tight);text-wrap:balance}
.choice input{width:22px;height:22px;margin:0;accent-color:var(--teal);flex:0 0 auto}
.choice:has(input:checked){border-color:var(--teal);box-shadow:inset 0 0 0 1px var(--teal);background:color-mix(in srgb,var(--teal) 8%,var(--card))}
.choice:has(input:focus-visible){outline:3px solid var(--focus);outline-offset:2px}
.choice:has(input:disabled){cursor:default}
.choice.pick{align-items:flex-start}
.choice .grow{flex:1;min-width:0}
.choices-inline{display:flex;flex-wrap:wrap;gap:var(--s-2)}
.choices-inline .choice{margin:0;flex:1 1 40%;padding:var(--s-3) var(--s-3) var(--s-3) var(--s-3)}
fieldset{border:0;margin:var(--s-4) 0;padding:0}
legend{font-weight:600;margin-bottom:var(--s-2);padding:0;line-height:var(--lh-tight);text-wrap:balance}
.field-label{display:block;font-weight:600;line-height:var(--lh-tight);margin:var(--s-4) 0 var(--s-2)}
.hint{font-size:var(--fs-2);color:var(--muted);margin:var(--s-1) 0 var(--s-2)}
.tag{display:inline-block;font-size:var(--fs-1);font-weight:600;line-height:var(--lh-tight);color:var(--teal);background:color-mix(in srgb,var(--teal) 12%,var(--card));border-radius:var(--r-pill);padding:1px var(--s-2);margin-left:var(--s-2);vertical-align:1px;white-space:nowrap}
textarea,input[type=text],input[type=date],select{width:100%;font:inherit;line-height:var(--lh-tight);color:var(--ink);background:var(--card);border:1.5px solid var(--field);border-radius:var(--r-2);padding:var(--s-3);min-height:52px}
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
.voice button{font:inherit;font-weight:600;border-radius:var(--r-pill);border:1.5px solid var(--teal);background:var(--card);color:var(--teal);padding:var(--s-2) var(--s-4);min-height:var(--tap)}
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
.wait-line{color:var(--muted);margin:var(--s-2) 0 0;font-variant-numeric:tabular-nums}
details{margin:var(--s-3) 0}
summary{cursor:pointer;font-weight:600;min-height:var(--tap);padding:10px 0;line-height:24px}
.compare{display:grid;grid-template-columns:1fr;gap:var(--s-2)}
.compare>div{border-radius:var(--r-1);padding:var(--s-2) var(--s-3);background:var(--card);border:1px solid var(--line)}
.compare .label{display:block;font-size:var(--fs-1);color:var(--muted);line-height:var(--lh-tight)}
.compare del{color:var(--muted);text-decoration:line-through}
.notes{background:var(--card);border:1px solid var(--line);border-radius:var(--r-1);padding:var(--s-2) var(--s-3);color:var(--muted);font-size:var(--fs-2)}
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
.next-bar{position:fixed;left:0;right:0;bottom:0;z-index:10;background:var(--bar);-webkit-backdrop-filter:saturate(1.6) blur(16px);backdrop-filter:saturate(1.6) blur(16px);
border-top:1px solid var(--line);padding:var(--s-2) var(--s-4) calc(var(--s-3) + env(safe-area-inset-bottom))}
.next-bar .inner{max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:var(--s-2)}
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
border-radius:var(--r-2);min-height:52px;padding:var(--s-3) var(--s-4);cursor:pointer;border:1.5px solid var(--teal);background:var(--card);color:var(--teal);flex:1;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
.btn.primary{background:var(--teal);color:var(--on-teal)}
.btn.alt{flex:0 1 auto;border-color:transparent;background:transparent;min-height:var(--tap);padding:var(--s-2) var(--s-3)}
.btn:active{filter:brightness(.92)}
.btn:focus-visible{outline-offset:3px}
.btn[disabled],.btn.disabled{background:var(--disabled-bg);border-color:var(--disabled-bg);color:var(--disabled-ink);cursor:default;filter:none}
.btn.waiting::before{content:"";flex:0 0 auto;width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
/* ---------- 动效（只动 transform / opacity；时长与缓动只从上面的 token 取） ----------
   页与页之间：跨文档 View Transitions（浏览器不支持时就是普通跳转）。底栏单独成一层，留在原位，只换按钮上的字；内容淡出、新的一页从下往上浮现。 */
/* 只在开着脚本时启用（Chromium 在关掉脚本的页面上，跨文档过渡会一直挡着点按） */
@media (scripting:enabled){@view-transition{navigation:auto}}
.next-bar{view-transition-name:next-bar}
::view-transition-old(root){animation:vt-out 150ms cubic-bezier(.2,.8,.2,1) both}
::view-transition-new(root){animation:vt-in 300ms cubic-bezier(.2,.8,.2,1) both}
::view-transition-group(next-bar){animation-duration:220ms;animation-timing-function:cubic-bezier(.2,.8,.2,1)}
@keyframes vt-out{to{opacity:0}}
@keyframes vt-in{from{opacity:0;transform:translateY(12px)}}
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
  @view-transition{navigation:none}
  *,*::before,*::after{animation:none!important;transition:none!important}
  ::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation:none!important}
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
.a2hs{border:1.5px dashed var(--teal)}
.standalone .a2hs{display:none!important}
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
/**
 * 下发的版本去掉注释、行首空白和空行（源码里的说明留给人看，不用每次传给手机）。样式和脚本里都没有含「/*」的字符串或正则，
 * 所以按 /* … *\/ 去注释是安全的；脚本保留换行（不依赖自动补分号的规则变化）。tests/integration/webClient.test.ts 校验脚本仍能解析。
 */
const compact = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]+/gm, '').replace(/\n{2,}/g, '\n').trim() + '\n';
export const STYLES_SERVED = compact(STYLES);
export const SCRIPT_SERVED = compact(CLIENT_SCRIPT);
export const STYLES_HASH = fingerprint(STYLES_SERVED);
export const SCRIPT_HASH = fingerprint(SCRIPT_SERVED);
export const ASSET_VERSION = fingerprint(`${STYLES_HASH}:${SCRIPT_HASH}`);
export const CSS_PATH = `/s/assets/app.${STYLES_HASH}.css`;
export const JS_PATH = `/s/assets/app.${SCRIPT_HASH}.js`;
/** 带指纹的资源：一年、不变。 */
export const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Service Worker：只缓存外壳（离线页、样式、脚本、图标），学生数据一律不缓存（只在导航失败时换成离线页）。 */
export const SERVICE_WORKER = `const CACHE='sel-shell-${ASSET_VERSION}';
const SHELL=['/s/offline','${CSS_PATH}','${JS_PATH}','/s/assets/icon-192.png'];
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
