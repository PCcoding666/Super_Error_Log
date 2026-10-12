/**
 * 学生网页版的浏览器脚本（发布包只含 dist/，所以以字符串形式随 tsc 编译进去，由 /s/assets/app.<hash>.js 下发）。
 * 只做浏览器必须做的事：上传进度、录音、选题计数、打印、按需显隐、说明状态的动效；关掉脚本时每屏照样能用（语音除外）。
 *
 * 结构：页面级的事件用委托（点按记录、打印、选项按下），每块内容的小功能放在 enhance(scope) 里——
 * 页面加载时对整页跑一次，局部更新换上来的区域再对那一块跑一次（每个元素只挂一次）。
 */
export const CLIENT_SCRIPT = String.raw`(function(){
var root=document.documentElement;root.classList.add('js');
var standalone=window.navigator.standalone===true||(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches);
if(standalone)root.classList.add('standalone');
function $(s,el){return (el||document).querySelector(s)}function $$(s,el){return Array.prototype.slice.call((el||document).querySelectorAll(s))}
/* scope 自己和它里面所有匹配 s 的元素 */
function within(scope,s){var list=$$(s,scope);if(scope&&scope.matches&&scope.matches(s))list.unshift(scope);return list}
/* 每个元素的每个小功能只挂一次 */
function once(el,name){var k='__sel_'+name;if(el[k])return false;el[k]=true;return true}
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

/* ---------- 动效：只在状态真的变了的时候放，说明刚发生了什么（样式里的 m-* 类；减少动态效果时样式把它们全关掉） ---------- */
function play(el,cls){if(!el||!el.classList)return;el.classList.remove(cls);void el.offsetWidth;el.classList.add(cls);
el.addEventListener('animationend',function h(e){if(e.target!==el)return;el.classList.remove(cls);el.removeEventListener('animationend',h)})}
/* 点了一个选项：轻轻按下去（告诉他这一下点上了） */
document.addEventListener('change',function(e){var c=e.target&&e.target.closest&&e.target.closest('.choice');if(c)play(c,'m-press')});
/* 底部主按钮换了字、或从不能点变成能点：新字滑进来 */
function primaryOf(bar){return $('[data-testid=next-step-primary]',bar)}
function primaryState(bar){var p=primaryOf(bar);return p?p.textContent+'|'+(p.disabled||p.classList.contains('disabled')):''}
function watchPrimary(bar){if(!window.MutationObserver||!once(bar,'primary'))return;var last=primaryState(bar);
new MutationObserver(function(){var now=primaryState(bar);if(now!==last){last=now;play(primaryOf(bar),'m-swap')}}).observe(bar,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','data-testid']})}
/* 「今天」清单：和这次打开里上一次看到的比，刚做完的那步打勾（✓ 弹出来），「现在做这个」挪到下一步（那一行浮上来）；
   这周的事刚做完时，做完了的卡片浮上来、✓ 弹出来。只在本机的会话存储里记步骤名，不记任何内容。 */
function trackSteps(scope){var box=within(scope,'[data-steps]')[0];if(!box)return;
var now={stage:box.getAttribute('data-stage'),done:[],cur:null};
$$('[data-step]',box).forEach(function(r){var k=r.getAttribute('data-step');if(r.getAttribute('data-done')==='1')now.done.push(k);if(r.getAttribute('data-current')==='1')now.cur=k});
var prev=null;try{prev=JSON.parse(sessionStorage.getItem('sel-today')||'null')}catch(e){}
if(prev&&prev.stage===now.stage){now.done.forEach(function(k){if(prev.done.indexOf(k)<0){var r=$('[data-step="'+k+'"]',box);play(r&&$('.dot',r),'m-pop')}});
if(now.cur&&prev.cur!==now.cur)play($('[data-step="'+now.cur+'"]',box),'m-rise')}
else if(prev&&now.stage==='done'){play(box,'m-rise');play($('[data-done-tick]',box),'m-pop')}
try{sessionStorage.setItem('sel-today',JSON.stringify(now))}catch(e){}}

/* ---------- 打印（委托：局部更新换上来的按钮也能用） ---------- */
function afterPrint(){var first=$('[data-testid=next-step-primary][data-print]');if(first&&$('[data-after-print]')){(first.closest('.bar-main')||first).classList.add('hidden');first.setAttribute('data-testid','print-used')}
$$('[data-after-print]').forEach(function(el){el.classList.remove('hidden')});var done=$('[data-print-done]');if(done)done.setAttribute('data-testid','next-step-primary');
var cap=$('[data-testid=next-step-caption]');if(cap&&cap.getAttribute('data-after'))cap.textContent=cap.getAttribute('data-after')}
window.addEventListener('afterprint',function(){if($('[data-print]'))afterPrint()});
document.addEventListener('click',function(e){var b=e.target&&e.target.closest&&e.target.closest('[data-print]');if(!b)return;e.preventDefault();try{window.print()}catch(x){}setTimeout(afterPrint,600)});

/* ---------- 每块内容的小功能 ---------- */
function enhance(scope){
/* 底栏多高，内容下面就留多高（最后一行能滚到底栏上面）；主按钮换字时放动效 */
within(scope,'.next-bar').forEach(function(nbar){if(!once(nbar,'bar'))return;function barH(){root.style.setProperty('--bar-h',nbar.offsetHeight+'px')}barH();if(window.ResizeObserver)new ResizeObserver(barH).observe(nbar);watchPrimary(nbar)});
trackSteps(scope);
/* 拍照上传：选好照片立刻上传并显示进度；失败时照片还在这个页面里，可以再试一次 */
within(scope,'form[data-upload]').forEach(function(form){if(!once(form,'upload'))return;var bar=$('[data-upload-progress]',form),msg=$('[data-upload-message]',form),retry=$('[data-upload-retry]',form),pending=null;
function send(file){pending=file;var data=new FormData();data.append('key',file.__key||(file.__key=uuid()));data.append('photo',file,'photo.jpg');
var xhr=new XMLHttpRequest();xhr.open('POST',form.getAttribute('action'));xhr.setRequestHeader('accept','application/json');
if(bar)bar.classList.remove('hidden');if(retry)retry.classList.add('hidden');if(msg)msg.textContent='正在上传…';
xhr.upload.onprogress=function(e){if(e.lengthComputable&&bar){var p=Math.round(e.loaded*100/e.total);$('i',bar).style.width=p+'%';msg.textContent='正在上传 '+p+'%'}};
xhr.onload=function(){var body={};try{body=JSON.parse(xhr.responseText)}catch(e){}
if(xhr.status>=200&&xhr.status<300){if(msg)msg.textContent='传上去了';location.replace(body.next||location.pathname);return}
if(msg)msg.textContent=(body.error&&body.error.message)||'没传上去。照片还在这个页面里。';if(retry&&xhr.status!==400)retry.classList.remove('hidden')};
xhr.onerror=function(){if(msg)msg.textContent='没传上去。照片还在这个页面里。';if(retry)retry.classList.remove('hidden');if(bar)bar.classList.add('hidden');trailAdd('error','upload_network')};xhr.send(data)}
$$('input[type=file]',form).forEach(function(input){input.addEventListener('change',function(){var f=input.files&&input.files[0];if(f)send(f);input.value=''})});
if(retry)retry.addEventListener('click',function(){if(pending)send(pending)})});
/* 选题：数字跟着变，最多 8 道 */
within(scope,'form[data-pick-count]').forEach(function(pick){if(!once(pick,'count'))return;var max=Number(pick.getAttribute('data-max')||'8'),min=Number(pick.getAttribute('data-min')||'1'),btn=$('[data-count-label]'),warn=$('[data-max-warning]');
function upd(e){var boxes=$$('input[type=checkbox][name=itemIds],input[type=checkbox][name=questionIds]',pick);var n=boxes.filter(function(b){return b.checked}).length;
if(n>max&&e&&e.target&&e.target.checked){e.target.checked=false;n=max;if(warn)warn.classList.remove('hidden')}else if(warn&&n<max)warn.classList.add('hidden');
if(btn){var t=n<min?btn.getAttribute('data-empty'):btn.getAttribute('data-template').replace('{n}',n);if(btn.textContent!==t)btn.textContent=t;btn.disabled=n<min;btn.classList.toggle('disabled',n<min)}}
pick.addEventListener('change',upd);upd()});
/* 「其他…」做练习的时间 */
within(scope,'[data-slot-other]').forEach(function(box){if(!once(box,'slot'))return;var input=$('input[type=text]',box.parentNode);function upd(){var other=$('input[value="__other"]',box.parentNode);if(input&&other)input.closest('.choice').classList.toggle('hidden',!other.checked)}box.parentNode.addEventListener('change',upd);upd()});
/* 录结果：选了前三种才问对不对；没做出来才问卡在哪（新出现的那一组浮上来） */
within(scope,'[data-record-item]').forEach(function(f){if(!once(f,'record'))return;function upd(){var c=$('input[name=completion]:checked',f);var v=c?c.value:'';var k=$('[data-correct]',f),s=$('[data-stuck]',f);
if(k){var showK=v==='independent'||v==='hint1'||v==='hint2';if(showK&&k.classList.contains('hidden'))play(k,'m-rise');k.classList.toggle('hidden',!showK)}
if(s){var showS=v==='not_solved';if(showS&&s.classList.contains('hidden'))play(s,'m-rise');s.classList.toggle('hidden',!showS)}}f.addEventListener('change',upd);upd()});
/* 说说为什么错：缺项提示 */
within(scope,'form[data-reflection]').forEach(function(f){if(!once(f,'reflection'))return;var line=$('[data-missing]'),btn=document.querySelector('button[form="'+f.id+'"]');function upd(){var miss=[];
if(!$('input[name=attemptState]:checked',f))miss.push('当时怎么了');if(!$('input[name=cause]:checked',f))miss.push('错在哪');if(!$('input[name=masteryFeeling]:checked',f))miss.push('有没有把握');
if(line){line.textContent=miss.length?'还差：'+miss.join('、'):'';}if(btn){btn.disabled=miss.length>0;btn.classList.toggle('disabled',miss.length>0)}}f.addEventListener('change',upd);upd()});
/* 一句话总结：一行话，回车不换行；跟着内容长高 */
within(scope,'textarea[data-single-line]').forEach(function(t){if(!once(t,'single'))return;t.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.isComposing)e.preventDefault()});if(window.CSS&&CSS.supports&&CSS.supports('field-sizing','content'))return;function fit(){t.style.height='auto';t.style.height=(t.scrollHeight+3)+'px'}t.addEventListener('input',fit);fit()});
/* 字数 */
within(scope,'textarea[data-count]').forEach(function(t){if(!once(t,'count'))return;var out=$(t.getAttribute('data-count'));function upd(){if(out)out.textContent='还能写 '+Math.max(0,Number(t.getAttribute('maxlength'))-t.value.length)+' 字'}t.addEventListener('input',upd);upd()});
/* 等待提示：提交后按钮换字，防止连点 */
within(scope,'form[data-wait]').forEach(function(f){if(!once(f,'wait'))return;f.addEventListener('submit',function(){var b=document.querySelector('button[form="'+f.id+'"]')||$('button[type=submit]',f);if(b){b.textContent=f.getAttribute('data-wait');b.classList.add('waiting');setTimeout(function(){b.disabled=true},0)}})});
/* 练习纸预览缩放到容器宽（容器变宽变窄时跟着重算） */
within(scope,'.sheet-wrap').forEach(function(w){if(!once(w,'fit'))return;var s=$('.sheet-scale',w);if(!s)return;function fit(){var k=w.clientWidth/s.scrollWidth;if(k<1){s.style.transform='scale('+k+')';w.style.height=(s.scrollHeight*k)+'px'}}fit();if(window.ResizeObserver)new ResizeObserver(fit).observe(w);else window.addEventListener('resize',fit)});
/* 语音：点一下开始，再点一下结束；转出来的字放进文本框，他改完自己提交 */
within(scope,'[data-voice-for]').forEach(function(box){if(!once(box,'voice'))return;var target=document.getElementById(box.getAttribute('data-voice-for'));var btn=$('button',box),note=$('[data-voice-note]',box),method=$('input[name=method]',box.closest('form')||document);
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
rec.start();btn.classList.add('on');btn.textContent='正在听…再点一下结束';if(note)note.textContent='最多说 60 秒';timer=setTimeout(stop,60000)}).catch(function(){starting=false;reset();if(note)note.textContent='用不了麦克风，可以直接打字。';btn.classList.add('hidden');trailAdd('error','mic_denied');trailSend()})})});
/* 离线页：真没联网时换标题 */
within(scope,'[data-offline-title]').forEach(function(off){if(navigator.onLine===false){off.textContent='没联网';var d=$('[data-offline-detail]');if(d)d.textContent='连上 Wi-Fi 或流量后点「再试一次」。拍过的照片和错题都在服务器上，不会丢。'}});
}

document.addEventListener('DOMContentLoaded',function(){enhance(document.body);
/* 等 AI 的页面自己刷新：只在页面看得见、他没在输入的时候刷新（关掉脚本时由 <noscript> 里的 meta refresh 接手） */
var every=Number(document.body.getAttribute('data-refresh')||0);
if(every>0){var due=Date.now()+every*1000;setInterval(function(){if(Date.now()<due||document.visibilityState!=='visible')return;var a=document.activeElement;if(a&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))return;due=Infinity;trailAdd('auto','refresh');location.reload()},500)}
});
})();
`;
