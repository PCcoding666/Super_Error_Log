/**
 * 学生网页版的静态资源。发布包只含 dist/（见 scripts/release-whitelist.txt），所以样式、脚本、
 * Service Worker、manifest 与图标都以 TypeScript 字符串形式随 tsc 编译进 dist，不放 public/。
 * 脚本只做浏览器必须做的事（上传进度、录音、选题计数、打印、按需显隐）；关掉脚本时每屏照样能用（语音除外）。
 */
import sharp from 'sharp';

export const APP_NAME = '超级错题本';
export const APP_SHORT_NAME = '错题本';
export const THEME_COLOR = '#1F615C';
export const BACKGROUND_COLOR = '#F7F5ED';
/** 资源版本：改了样式或脚本就改这个，让浏览器与 Service Worker 换新。 */
export const ASSET_VERSION = '1';

export const STYLES = `
:root{--paper:#F7F5ED;--card:#FFFFFF;--ink:#1F3338;--muted:#5C6B6E;--teal:#1F615C;--on-teal:#FFFFFF;--mint:#DDEBDE;--line:#DBE0D6;
--gray:#5C6B6E;--blue:#2E6EDE;--orange:#B55409;--green:#1F804F;--red:#BF382B;--bar:rgba(247,245,237,.94)}
@media (prefers-color-scheme:dark){:root{--paper:#17191C;--card:#212629;--ink:#E8EDED;--muted:#9EA8A8;--teal:#6BB8AD;--on-teal:#0D1717;--mint:#263B36;--line:#3D4545;
--gray:#9EA8A8;--blue:#73A6F2;--orange:#E8A35C;--green:#6BBF8A;--red:#E07361;--bar:rgba(23,25,28,.94)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif;
padding:env(safe-area-inset-top) 0 calc(150px + env(safe-area-inset-bottom))}
a{color:var(--teal)}
.top{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 16px;min-height:48px}
.top a{text-decoration:none;font-weight:600;padding:6px 2px}
.top .title{font-weight:600;color:var(--muted);font-size:14px}
main{padding:0 16px;max-width:560px;margin:0 auto}
h1{font-size:28px;line-height:1.2;margin:4px 0 12px}
h2{font-size:18px;margin:18px 0 8px}
p{margin:6px 0}
.muted{color:var(--muted)}.small{font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px;margin:12px 0}
.flash{border-radius:12px;padding:10px 12px;margin:10px 0;background:var(--mint)}
.flash.err{background:color-mix(in srgb,var(--red) 14%,var(--card));color:var(--ink)}
.tone-gray{color:var(--gray)}.tone-blue{color:var(--blue)}.tone-orange{color:var(--orange)}.tone-green{color:var(--green)}.tone-red{color:var(--red)}
.rhythm{display:flex;gap:4px;margin:4px 0 8px}
.rhythm span{flex:1;text-align:center;font-size:12px;padding:6px 4px;border-radius:10px;background:var(--card);border:1px solid var(--line);color:var(--muted)}
.rhythm span.on{background:var(--teal);color:var(--on-teal);border-color:var(--teal)}
.rhythm b{display:block;font-size:13px}
.steps{list-style:none;margin:8px 0 0;padding:0}
.steps a,.steps .row{display:flex;gap:12px;align-items:flex-start;text-decoration:none;color:inherit;padding:10px;border-radius:12px;border:1.5px solid transparent;min-height:44px}
.steps .current{border-color:var(--teal)}
.dot{flex:0 0 26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;background:var(--mint)}
.current .dot{background:var(--teal);color:var(--on-teal)}
.done .dot{background:color-mix(in srgb,var(--green) 18%,var(--card));color:var(--green)}
.done .step-title{color:var(--muted)}
.step-body{flex:1;min-width:0}
.step-title{font-weight:600}
.chip{display:inline-block;font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;margin-left:6px;vertical-align:2px;background:var(--mint);color:var(--muted)}
.chip.now{background:color-mix(in srgb,var(--teal) 14%,var(--card));color:var(--teal)}
.chev{color:var(--muted);font-weight:700;padding-top:2px}
.list{list-style:none;margin:0;padding:0}
.list>li{border-top:1px solid var(--line)}
.list>li:first-child{border-top:0}
.list a.row,.list .row{display:flex;gap:12px;align-items:center;padding:12px 4px;text-decoration:none;color:inherit;min-height:48px}
.thumb{width:84px;height:64px;object-fit:cover;border-radius:10px;background:var(--mint);flex:0 0 auto}
.crop{display:block;width:100%;max-height:96px;object-fit:contain;object-position:left center;border-radius:10px;background:#fff;margin:6px 0}
.crop.big{max-height:none}
.excerpt{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}
.grid figure{margin:0;font-size:12px;text-align:center}
.grid img{width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:10px;background:var(--mint);display:block}
.add-tile{display:flex;align-items:center;justify-content:center;aspect-ratio:3/4;border:2px dashed var(--line);border-radius:10px;color:var(--teal);font-weight:600;cursor:pointer;text-align:center}
.choice{display:flex;gap:10px;align-items:center;padding:12px;border:1.5px solid var(--line);border-radius:12px;margin:8px 0;background:var(--card);cursor:pointer;min-height:48px}
.choice input{width:22px;height:22px;accent-color:var(--teal);flex:0 0 auto}
.choice:has(input:checked){border-color:var(--teal);background:color-mix(in srgb,var(--teal) 8%,var(--card))}
.choice.pick{align-items:flex-start}
.choice .grow{flex:1;min-width:0}
.choices-inline{display:flex;flex-wrap:wrap;gap:8px}
.choices-inline .choice{margin:0;flex:1 1 40%}
fieldset{border:0;margin:14px 0;padding:0}
legend{font-weight:600;margin-bottom:4px;padding:0}
.tag{font-size:11px;font-weight:600;color:var(--teal);background:color-mix(in srgb,var(--teal) 12%,var(--card));border-radius:999px;padding:1px 7px;margin-left:6px}
textarea,input[type=text],input[type=date],select{width:100%;font:inherit;color:var(--ink);background:var(--card);border:1.5px solid var(--line);border-radius:12px;padding:12px}
textarea{min-height:120px;resize:vertical}
.bubble{background:var(--mint);border-radius:16px 16px 16px 4px;padding:12px 14px;margin:10px 0}
.bubble .who{font-size:12px;color:var(--muted);font-weight:600}
.answer{background:var(--card);border:1px solid var(--line);border-radius:16px 16px 4px 16px;padding:10px 14px;margin:8px 0 8px 32px}
.voice{margin:8px 0}
.voice button{font:inherit;font-weight:600;border-radius:999px;border:1.5px solid var(--teal);background:var(--card);color:var(--teal);padding:10px 18px;min-height:44px}
.voice button.on{background:var(--teal);color:var(--on-teal)}
.progress{height:8px;border-radius:999px;background:var(--line);overflow:hidden;margin:8px 0}
.progress i{display:block;height:100%;background:var(--teal);width:0}
details{margin:10px 0}
summary{cursor:pointer;font-weight:600;padding:8px 0}
.compare{display:grid;grid-template-columns:1fr;gap:6px}
.compare div{border-radius:10px;padding:8px 10px;background:var(--card);border:1px solid var(--line)}
.compare .before{text-decoration:line-through;color:var(--muted)}
.notes{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 12px;color:var(--muted);font-size:14px}
.inline-form{display:inline}
.link-btn{font:inherit;background:none;border:0;color:var(--teal);font-weight:600;padding:6px 0;cursor:pointer;text-decoration:underline}
.next-bar{position:fixed;left:0;right:0;bottom:0;z-index:10;background:var(--bar);-webkit-backdrop-filter:saturate(1.6) blur(16px);backdrop-filter:saturate(1.6) blur(16px);
border-top:1px solid var(--line);padding:8px 16px calc(10px + env(safe-area-inset-bottom))}
.next-bar .inner{max-width:560px;margin:0 auto}
.next-bar .caption{font-size:13px;color:var(--muted);text-align:center;margin:0 0 6px}
.next-bar .buttons{display:flex;gap:10px;align-items:stretch}
.next-bar .buttons.stack{flex-direction:column}
.next-bar form{display:flex;margin:0;flex:1}
.btn{font:inherit;font-weight:600;display:flex;align-items:center;justify-content:center;text-align:center;text-decoration:none;border-radius:14px;min-height:50px;padding:10px 14px;cursor:pointer;
border:1.5px solid var(--teal);background:var(--card);color:var(--teal);flex:1;line-height:1.25;-webkit-tap-highlight-color:transparent}
.btn.primary{background:var(--teal);color:var(--on-teal);flex:2}
.btn[disabled],.btn.disabled{opacity:.45;cursor:default}
.btn.waiting::before{content:"";width:14px;height:14px;margin-right:8px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.btn.waiting::before{animation:none}}
.js .no-js-only{display:none!important}
.js-only{display:none!important}
.js .js-only{display:revert!important}
.js .js-only.btn{display:flex!important}
.hidden{display:none!important}
.visually-hidden{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.status{display:inline-block;font-size:12px;font-weight:600}
.a2hs{border:1.5px dashed var(--teal)}
.standalone .a2hs{display:none}
/* 练习纸（A4）：屏幕上缩放预览，打印时只印纸 */
.sheet-wrap{overflow:hidden;margin:12px 0}
.sheet{color:#111;background:#fff;font:12pt/1.55 "PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Songti SC",serif}
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
document.addEventListener('DOMContentLoaded',function(){
/* 拍照上传：选好照片立刻上传并显示进度；失败时照片还在这个页面里，可以再试一次 */
var form=$('form[data-upload]');
if(form){var bar=$('[data-upload-progress]'),msg=$('[data-upload-message]'),retry=$('[data-upload-retry]'),pending=null;
function send(file){pending=file;var data=new FormData();data.append('key',file.__key||(file.__key=uuid()));data.append('photo',file,'photo.jpg');
var xhr=new XMLHttpRequest();xhr.open('POST',form.getAttribute('action'));xhr.setRequestHeader('accept','application/json');
if(bar)bar.classList.remove('hidden');if(retry)retry.classList.add('hidden');if(msg)msg.textContent='正在上传…';
xhr.upload.onprogress=function(e){if(e.lengthComputable&&bar){var p=Math.round(e.loaded*100/e.total);$('i',bar).style.width=p+'%';msg.textContent='正在上传 '+p+'%'}};
xhr.onload=function(){var body={};try{body=JSON.parse(xhr.responseText)}catch(e){}
if(xhr.status>=200&&xhr.status<300){if(msg)msg.textContent='传上去了';location.replace(body.next||location.pathname);return}
if(msg)msg.textContent=(body.error&&body.error.message)||'没传上去。照片还在这个页面里。';if(retry&&xhr.status!==400)retry.classList.remove('hidden')};
xhr.onerror=function(){if(msg)msg.textContent='没传上去。照片还在这个页面里。';if(retry)retry.classList.remove('hidden')};xhr.send(data)}
$$('input[type=file]',form).forEach(function(input){input.addEventListener('change',function(){var f=input.files&&input.files[0];if(f)send(f);input.value=''})});
if(retry)retry.addEventListener('click',function(){if(pending)send(pending)})}
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
$$('textarea[data-count]').forEach(function(t){var out=$(t.getAttribute('data-count'));function upd(){if(out)out.textContent='还能写 '+Math.max(0,Number(t.getAttribute('maxlength'))-t.value.length)+' 字'}t.addEventListener('input',upd);upd()});
/* 等待提示：提交后按钮换字，防止连点 */
$$('form[data-wait]').forEach(function(f){f.addEventListener('submit',function(){var b=document.querySelector('button[form="'+f.id+'"]')||$('button[type=submit]',f);if(b){b.textContent=f.getAttribute('data-wait');b.classList.add('waiting');setTimeout(function(){b.disabled=true},0)}})});
/* 打印 */
var printBtn=$('[data-print]');
if(printBtn){var after=function(){var first=$('[data-testid=next-step-primary][data-print]');if(first&&$('[data-after-print]')){first.classList.add('hidden');first.setAttribute('data-testid','print-used')}
$$('[data-after-print]').forEach(function(el){el.classList.remove('hidden')});var done=$('[data-print-done]');if(done)done.setAttribute('data-testid','next-step-primary');
var cap=$('[data-testid=next-step-caption]');if(cap&&cap.getAttribute('data-after'))cap.textContent=cap.getAttribute('data-after')};
window.addEventListener('afterprint',after);$$('[data-print]').forEach(function(b){b.addEventListener('click',function(e){e.preventDefault();try{window.print()}catch(x){}setTimeout(after,600)})})}
/* 练习纸预览缩放到屏幕宽 */
$$('.sheet-wrap').forEach(function(w){var s=$('.sheet-scale',w);if(!s)return;function fit(){var k=w.clientWidth/s.scrollWidth;if(k<1){s.style.transform='scale('+k+')';w.style.height=(s.scrollHeight*k)+'px'}}fit();window.addEventListener('resize',fit)});
/* 语音：点一下开始，再点一下结束；转出来的字放进文本框，他改完自己提交 */
$$('[data-voice-for]').forEach(function(box){var target=document.getElementById(box.getAttribute('data-voice-for'));var btn=$('button',box),note=$('[data-voice-note]',box),method=$('input[name=method]',box.closest('form')||document);
var ok=target&&btn&&navigator.mediaDevices&&navigator.mediaDevices.getUserMedia&&window.MediaRecorder;
if(!ok){if(note)note.textContent='可以直接打字';return}
box.classList.remove('hidden');var rec=null,chunks=[],timer=null,stream=null;
function type(){var c=['audio/mp4','audio/webm;codecs=opus','audio/webm'];for(var i=0;i<c.length;i++){if(MediaRecorder.isTypeSupported&&MediaRecorder.isTypeSupported(c[i]))return c[i]}return ''}
function reset(){btn.classList.remove('on');btn.textContent='点一下开始说';btn.disabled=false}
function stop(){if(rec&&rec.state!=='inactive')rec.stop();if(timer){clearTimeout(timer);timer=null}}
btn.addEventListener('click',function(){if(rec&&rec.state==='recording'){stop();return}
navigator.mediaDevices.getUserMedia({audio:true}).then(function(s){stream=s;chunks=[];var t=type();rec=t?new MediaRecorder(s,{mimeType:t}):new MediaRecorder(s);
rec.ondataavailable=function(e){if(e.data&&e.data.size)chunks.push(e.data)};
rec.onstop=function(){stream.getTracks().forEach(function(x){x.stop()});var blob=new Blob(chunks,{type:(rec.mimeType||t||'audio/mp4')});btn.textContent='正在转成文字…';btn.classList.remove('on');btn.disabled=true;
fetch(box.getAttribute('data-endpoint'),{method:'POST',headers:{'content-type':blob.type.split(';')[0]||'audio/mp4'},body:blob,credentials:'same-origin'}).then(function(r){return r.json().then(function(b){return{ok:r.ok,b:b}})}).then(function(x){
if(x.ok&&x.b.text){target.value=(target.value?target.value+' ':'')+x.b.text;target.dispatchEvent(new Event('input'));if(method)method.value='voice';if(note)note.textContent='转好了，看一眼，不对就改'}
else if(x.ok){if(note)note.textContent='没听清，再说一次'}else{if(note)note.textContent=(x.b.error&&x.b.error.message)||'这次没转成文字，再说一次，或者直接打字。'}reset()}).catch(function(){if(note)note.textContent='没传上去，可以直接打字';reset()})};
rec.start();btn.classList.add('on');btn.textContent='正在听…再点一下结束';if(note)note.textContent='最多说 60 秒';timer=setTimeout(stop,60000)}).catch(function(){if(note)note.textContent='用不了麦克风，可以直接打字。';box.querySelector('button').classList.add('hidden')})})});
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
