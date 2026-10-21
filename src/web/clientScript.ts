import { PHOTO_UPLOAD_SCRIPT } from './photoUpload.js';
import { UPLOAD_QUEUE_SCRIPT } from './uploadQueue.js';
import { UI_SHEET_SCRIPT } from './sheet.js';

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
/* 浏览器恢复缓存页面时，只还原本次提交临时修改过的控件。 */
window.addEventListener('pageshow',function(){ $$('form[data-wait]').forEach(function(f){if(f.__sel_waitRestore)f.__sel_waitRestore()}) });

/* 页面所属的语音会话在加载时固定；旧单学生页面没有这个 meta。重试也不能换成另一个页面的会话。 */
var voiceMeta=$('meta[name="sel-voice-context"]');var voiceContext=voiceMeta?voiceMeta.getAttribute('content'):null;
/* 超时覆盖 fetch 和整个响应正文；即使底层忽略 abort，超时/取消后的结果也不会再交给调用方。 */
function boundedRequest(url,options,ms,read){var controller=window.AbortController?new AbortController():null,done=false,timer=null,settle;
if(controller)options.signal=controller.signal;
var promise=new Promise(function(resolve,reject){settle=function(error,value){if(done)return;done=true;clearTimeout(timer);if(error)reject(error);else resolve(value)};
timer=setTimeout(function(){cancel(new Error('request_timeout'))},ms);
Promise.resolve().then(function(){if(!done)return fetch(url,options)}).then(function(response){if(!done)return read(response)}).then(function(value){settle(null,value)},function(error){settle(error)})});
function cancel(error){if(done)return;settle(error||new Error('request_cancelled'));if(controller)controller.abort()}
return{promise:promise,cancel:cancel}}
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

/* 学科菜单和筛选菜单都是原生 details。点外面或按 Esc 只关掉菜单，不改当前选择。 */
document.addEventListener('keydown',function(e){if(e.key!=='Escape')return;var menu=$('.pop-menu[open]');if(!menu)return;e.preventDefault();menu.open=false;var trigger=$('summary',menu);if(trigger)trigger.focus({preventScroll:true})});
document.addEventListener('click',function(e){$$('.pop-menu[open]').forEach(function(menu){if(!menu.contains(e.target))menu.open=false})});

/* ---------- 动效：只在状态真的变了的时候放，说明刚发生了什么（样式里的 m-* 类；减少动态效果时样式把它们全关掉） ---------- */
function play(el,cls){if(!el||!el.classList)return;el.classList.remove(cls);void el.offsetWidth;el.classList.add(cls);
el.addEventListener('animationend',function h(e){if(e.target!==el)return;el.classList.remove(cls);el.removeEventListener('animationend',h)})}
/* 点了一个选项：轻轻按下去（告诉他这一下点上了） */
document.addEventListener('change',function(e){var c=e.target&&e.target.closest&&e.target.closest('.choice');if(c)play(c,'m-press')});
/* 底部主按钮换了字、或从不能点变成能点：新字滑进来 */
function primaryOf(bar){return $('[data-testid=next-step-primary]',bar)}
function primaryState(bar){var p=primaryOf(bar);return p?p.textContent+'|'+(p.disabled||p.classList.contains('disabled')):''}
function watchPrimary(bar){if(!window.MutationObserver||!once(bar,'primary'))return;var last=primaryState(bar);
new MutationObserver(function(){var primary=primaryOf(bar);if(primary)primary.setAttribute('aria-label',primary.textContent);var now=primaryState(bar);if(now!==last){last=now;play(primaryOf(bar),'m-swap')}}).observe(bar,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','data-testid']})}
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
$$('[data-testid=next-step-caption],[data-caption-flow]').forEach(function(cap){if(cap.getAttribute('data-after'))cap.textContent=cap.getAttribute('data-after')})}
window.addEventListener('afterprint',function(){if($('[data-print]'))afterPrint()});
document.addEventListener('click',function(e){var b=e.target&&e.target.closest&&e.target.closest('[data-print]');if(!b)return;e.preventDefault();try{window.print()}catch(x){}setTimeout(afterPrint,600)});

/* ---------- 每块内容的小功能 ---------- */
function enhance(scope){
/* Sheet 与内容一起局部更新；节点自身标记确保不重复绑定。 */
${UI_SHEET_SCRIPT}
/* 底栏多高，内容下面就留多高（最后一行能滚到底栏上面）；主按钮换字时放动效 */
/* 只有开着脚本才能用的主按钮（练习纸单独页的「打印」）：脚本在的时候它才是主按钮 */
within(scope,'[data-js-primary]').forEach(function(el){el.setAttribute('data-testid','next-step-primary')});
within(scope,'.next-bar').forEach(function(nbar){if(!once(nbar,'bar'))return;function barH(){root.style.setProperty('--bar-h',nbar.offsetHeight+'px')}barH();if(window.ResizeObserver)new ResizeObserver(barH).observe(nbar);watchPrimary(nbar)});
trackSteps(scope);
/* 弹出按钮：选完立刻提交。没有脚本时，同一张表单上的「保存学段」仍然可见。 */
within(scope,'form[data-submit-on-change]').forEach(function(form){if(!once(form,'autosubmit'))return;form.addEventListener('change',function(e){var target=e.target;if(!target||!target.matches||!target.matches('select'))return;try{if(form.requestSubmit)form.requestSubmit();else form.submit()}catch(err){form.submit()}})});
/* 设置页：正常连接只占一行，失败时才显示重试；不轮询、不读取学习内容。 */
within(scope,'[data-connection-status]').forEach(function(conn){if(!once(conn,'connection'))return;var retry=$('[data-connection-retry]',conn.parentNode),busy=false;if(!retry)return;
function state(ok){conn.textContent=ok?'已连接':'连接失败';conn.classList.toggle('tone-red',!ok);retry.classList.toggle('hidden',ok)}
window.addEventListener('offline',function(){if(conn.isConnected)state(false)});if(navigator.onLine===false)state(false);
retry.addEventListener('click',function(){if(busy)return;busy=true;retry.disabled=true;conn.textContent='连接中…';
var request=boundedRequest('/s/settings',{method:'HEAD',credentials:'same-origin',cache:'no-store',redirect:'error'},8000,function(r){return r.ok&&navigator.onLine!==false});
request.promise.then(state,function(){state(false)}).finally(function(){busy=false;retry.disabled=false})})});
/* 上传使用与 main 相同的图片转换、超时和重试逻辑；局部更新时只挂一次。 */
within(scope,'form[data-upload]').forEach(function(uploadForm){if(!once(uploadForm,'upload'))return;
(function(){
${PHOTO_UPLOAD_SCRIPT}
})();
});
/* 选题：数字跟着变，最多 8 道 */
within(scope,'form[data-pick-count]').forEach(function(pick){if(!once(pick,'count'))return;var max=Number(pick.getAttribute('data-max')||'8'),min=Number(pick.getAttribute('data-min')||'1'),btn=$('[data-count-label]'),warn=$('[data-max-warning]');
function upd(e){var boxes=$$('input[type=checkbox][name=itemIds],input[type=checkbox][name=questionIds]',pick);var n=boxes.filter(function(b){return b.checked}).length;
if(n>max&&e&&boxes.includes(e.target)&&e.target.checked){e.target.checked=false;n=boxes.filter(function(b){return b.checked}).length;if(warn)warn.classList.remove('hidden')}else if(warn)warn.classList.toggle('hidden',n<=max);
if(btn){var t=n<min?btn.getAttribute('data-empty'):btn.getAttribute('data-template').replace('{n}',n);if(btn.textContent!==t)btn.textContent=t;btn.disabled=n<min||n>max;btn.classList.toggle('disabled',n<min||n>max)}}
pick.addEventListener('change',upd);upd()});
/* Notebook selection never discards checked questions; the server validates the exact set. */
within(scope,'form[data-notebook-selection]').forEach(function(form){if(!once(form,'notebook'))return;
function update(){var n=$$('input[name=itemIds]:checked',form).length;var count=$('[data-testid=next-step-caption]'),limit=$('[data-notebook-limit]');
var button=$('[data-testid=next-step-primary]');if(button){button.disabled=n===0||n>8;button.classList.toggle('disabled',button.disabled)}
var countText='已选 '+n+' 道 / 最多 8 道',limitText=n>8?'超过 8 道了，请取消几道后继续。':n===0?'至少选 1 道题':'可逐题取消';
if(count&&count.textContent!==countText)count.textContent=countText;if(limit&&limit.textContent!==limitText)limit.textContent=limitText}
form.addEventListener('change',update);window.addEventListener('pageshow',update);update()});
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
within(scope,'form[data-wait]').forEach(function(f){if(!once(f,'wait'))return;var busy=false;
f.addEventListener('submit',function(e){if(busy){e.preventDefault();return}if(e.defaultPrevented)return;
var b=e.submitter||document.querySelector('button[form="'+f.id+'"]')||$('button[type=submit]',f);if(!b)return;
busy=true;var saved={html:b.innerHTML,label:b.getAttribute('aria-label'),disabled:b.disabled,waiting:b.classList.contains('waiting'),busy:f.getAttribute('aria-busy')};
function attr(el,name,value){if(value===null)el.removeAttribute(name);else el.setAttribute(name,value)}
f.__sel_waitRestore=function(){clearTimeout(timer);b.innerHTML=saved.html;attr(b,'aria-label',saved.label);b.disabled=saved.disabled;b.classList.toggle('waiting',saved.waiting);attr(f,'aria-busy',saved.busy);busy=false;f.__sel_waitRestore=null};
b.textContent=f.getAttribute('data-wait');b.setAttribute('aria-label',b.textContent);b.classList.add('waiting');f.setAttribute('aria-busy','true');
/* 留到原生表单收集 name/value 之后再禁用，当前事件内的重复提交已由 busy 阻止。 */
var timer=setTimeout(function(){b.disabled=true},0)
})});
/* 练习纸预览缩放到容器宽（容器变宽变窄时跟着重算） */
within(scope,'.sheet-wrap').forEach(function(w){if(!once(w,'fit'))return;var s=$('.sheet-scale',w);if(!s)return;function fit(){var k=w.clientWidth/s.scrollWidth;if(k<1){s.style.transform='scale('+k+')';w.style.height=(s.scrollHeight*k)+'px'}}fit();if(window.ResizeObserver)new ResizeObserver(fit).observe(w);else window.addEventListener('resize',fit)});
/* 语音：点一下开始，「说完了」结束；转出来的字放进文本框，他改完自己提交（AI 只转写，不替他提交）。
   开着麦克风时：音量条（Web Audio AnalyserNode，只动 transform）+ 计时；底部主按钮暂时不能点（先说完再提交）。
   转写时：说已经转了几秒。转写失败：刚才那段录音还留在页面里，可以「再转一次」，也可以直接打字。打开麦克风期间再点不会开第二个录音。 */
within(scope,'[data-voice-for]').forEach(function(box){if(!once(box,'voice'))return;var target=document.getElementById(box.getAttribute('data-voice-for'));
var btn=$('[data-voice-btn]',box),note=$('[data-voice-note]',box),waitEl=$('[data-voice-wait]',box),live=$('[data-voice-live]',box),meter=$('[data-voice-meter]',box),clock=$('[data-voice-time]',box),heard=$('[data-voice-heard]',box),retry=$('[data-voice-retry]',box),cancelBtn=$('[data-voice-cancel]',box);
var form=box.closest('form');var method=$('input[name=method]',form||document);var primary=form&&form.id?document.querySelector('button[form="'+form.id+'"]'):null;
var ok=target&&btn&&navigator.mediaDevices&&navigator.mediaDevices.getUserMedia&&window.MediaRecorder;
if(!ok){if(note)note.textContent='可以直接打字';return}
box.classList.remove('hidden');var rec=null,chunks=[],timer=null,stream=null,ticker=null,t0=0,ac=null,src=null,analyser=null,raf=0,lastBlob=null,saved=null;
var phase='idle',generation=0,request=null,active=true,sessionChanged=false;
function type(){var c=['audio/mp4','audio/webm;codecs=opus','audio/webm'];for(var i=0;i<c.length;i++){if(MediaRecorder.isTypeSupported&&MediaRecorder.isTypeSupported(c[i]))return c[i]}return ''}
function clockText(s){return Math.floor(s/60)+':'+('0'+(s%60)).slice(-2)}
/* 底部主按钮：录音、转写时暂时换字、不能点；结束后换回来 */
function holdPrimary(text){if(!primary)return;if(!saved)saved={t:primary.textContent,d:primary.disabled};primary.textContent=text;primary.disabled=true;primary.classList.add('disabled')}
function releasePrimary(){if(!primary||!saved)return;primary.textContent=saved.t;primary.disabled=saved.d;primary.classList.toggle('disabled',saved.d);saved=null;primary.dispatchEvent(new Event('voice-done'))}
function showCancel(on){if(cancelBtn)cancelBtn.classList.toggle('hidden',!on)}
function reset(){btn.classList.remove('on','hidden');btn.textContent='点一下开始说';btn.disabled=sessionChanged;if(waitEl)waitEl.textContent='';showCancel(false)}
function stopMeter(){if(raf)cancelAnimationFrame(raf);raf=0;if(src){try{src.disconnect()}catch(e){}src=null}if(analyser){try{analyser.disconnect()}catch(e){}analyser=null}if(meter)meter.setAttribute('data-level','0')}
function startMeter(s){if(!ac||!meter)return;try{if(ac.resume)ac.resume().catch(function(){});src=ac.createMediaStreamSource(s);analyser=ac.createAnalyser();analyser.fftSize=512;src.connect(analyser)}catch(e){return}
var buf=new Uint8Array(analyser.fftSize),last=0,lastHeard=0;function loop(ts){raf=requestAnimationFrame(loop);if(ts-last<80)return;last=ts;analyser.getByteTimeDomainData(buf);var sum=0;for(var i=0;i<buf.length;i++){var v=(buf[i]-128)/128;sum+=v*v}
var rms=Math.sqrt(sum/buf.length);var level=Math.max(0,Math.min(5,Math.round(rms*24)));meter.setAttribute('data-level',String(level));
if(heard&&ts-lastHeard>500){lastHeard=ts;heard.textContent=level>=1?'听到声音了':'没听到声音，靠近一点说'}}raf=requestAnimationFrame(loop)}
function stopClock(){if(ticker){clearInterval(ticker);ticker=null}}
function stopTracks(s){if(s)s.getTracks().forEach(function(track){try{track.stop()}catch(e){}})}
/* 清理不等于「说完」：先卸下回调再停录音，绝不由 pagehide/取消/错误自动上传。 */
function cleanupCapture(){if(timer){clearTimeout(timer);timer=null}var old=rec;rec=null;
if(old){old.onstop=old.ondataavailable=old.onerror=null;try{if(old.state!=='inactive')old.stop()}catch(e){}}
stopTracks(stream);stream=null;chunks=[];stopMeter();stopClock();if(live)live.classList.add('hidden');
if(ac){var context=ac;ac=null;try{context.close().catch(function(){})}catch(e){}}}
function discard(message){generation+=1;if(request){request.cancel();request=null}cleanupCapture();lastBlob=null;phase='idle';if(retry)retry.classList.add('hidden');reset();releasePrimary();if(message&&note)note.textContent=message}
function micFailed(id){if(id!==generation||!active)return;discard('用不了麦克风，可以直接打字。');trailAdd('error','mic_denied');trailSend()}
function stop(){if(phase!=='recording'||!rec)return;phase='stopping';btn.disabled=true;if(timer){clearTimeout(timer);timer=null}try{rec.stop()}catch(e){micFailed(generation)}}
/* 转写中：按钮先收起来（不会再点出第二次）；「正在转成文字…」读一次，「已经 N 秒」每秒更新但不读（不在 aria-live 里） */
function send(blob){if(!active||sessionChanged||phase!=='idle')return;var id=++generation;phase='sending';lastBlob=blob;if(retry)retry.classList.add('hidden');btn.classList.remove('on');btn.classList.add('hidden');showCancel(true);holdPrimary('正在转成文字…');
if(note)note.textContent='正在转成文字…';var sent=Date.now();function wait(){if(waitEl)waitEl.textContent='已经 '+Math.floor((Date.now()-sent)/1000)+' 秒，一般几秒就好'}wait();stopClock();ticker=setInterval(wait,1000);
var headers={'content-type':blob.type.split(';')[0]||'audio/mp4'};if(voiceContext!==null)headers['x-sel-voice-context']=voiceContext;
request=boundedRequest(box.getAttribute('data-endpoint'),{method:'POST',headers:headers,body:blob,credentials:'same-origin'},45000,function(r){
if(r.status===409)return{ok:false,status:409,b:null};return r.json().then(function(b){return{ok:r.ok,status:r.status,b:b}})});
function finished(){request=null;phase='idle';stopClock();reset();releasePrimary()}
request.promise.then(function(x){if(id!==generation||!active)return;
if(x.status===409){sessionChanged=true;lastBlob=null;if(retry){retry.disabled=true;retry.classList.add('hidden')}finished();if(note)note.textContent='登录已切换，请刷新页面后再录音。已输入的文字保留。';return}
finished();
if(x.ok&&x.b.text){target.value=(target.value?target.value+' ':'')+x.b.text;target.dispatchEvent(new Event('input'));play(target,'m-rise');if(method)method.value='voice';if(note)note.textContent='转好了，看一眼，不对就改';lastBlob=null}
else if(x.ok){if(note)note.textContent='没听清，再说一次';lastBlob=null;trailAdd('error','voice_empty');trailSend()}
else{var again=x.status===429||x.status>=500;if(note)note.textContent=again?'这次没转成文字。刚才的录音还在：点「再转一次」，或者直接打字。':((x.b.error&&x.b.error.message)||'这次没转成文字，再说一次，或者直接打字。');
if(again&&retry){retry.classList.remove('hidden');play(retry,'m-rise');box.scrollIntoView({block:'nearest'})}else lastBlob=null;trailAdd('error','voice_'+x.status);trailSend()}
}).catch(function(error){if(id!==generation||!active)return;finished();if(note)note.textContent=(error&&error.message==='request_timeout'?'转写超时了。':'没传上去。')+'刚才的录音还在：点「再转一次」，或者直接打字。';if(retry){retry.classList.remove('hidden');play(retry,'m-rise');box.scrollIntoView({block:'nearest'})}trailAdd('error','voice_network')})}
if(retry)retry.addEventListener('click',function(){if(lastBlob)send(lastBlob)});
if(cancelBtn)cancelBtn.addEventListener('click',function(e){e.preventDefault();discard('已取消，可以直接打字。')});
window.addEventListener('pagehide',function(){active=false;discard('录音已取消，可以重新录音或直接打字。')});
window.addEventListener('pageshow',function(){active=true});
btn.addEventListener('click',function(){if(!active||sessionChanged)return;if(phase==='recording'){stop();return}
/* 打开麦克风要一会儿（第一次还会问权限）：马上给反馈，这期间再点不会开第二个录音 */
if(phase!=='idle')return;var id=++generation;phase='starting';lastBlob=null;btn.disabled=true;btn.textContent='正在打开麦克风…';if(retry)retry.classList.add('hidden');showCancel(true);
/* 音量要在点按的这一下里建好（iOS Safari 只在用户点按时允许开声音） */
var AC=window.AudioContext||window.webkitAudioContext;if(!ac&&AC){try{ac=new AC()}catch(e){ac=null}}
Promise.resolve().then(function(){if(id===generation&&active)return navigator.mediaDevices.getUserMedia({audio:true})}).then(function(s){if(id!==generation||!active){stopTracks(s);return}btn.disabled=false;stream=s;chunks=[];var t=type();rec=t?new MediaRecorder(s,{mimeType:t}):new MediaRecorder(s);var current=rec;
rec.ondataavailable=function(e){if(id===generation&&current===rec&&e.data&&e.data.size)chunks.push(e.data)};
rec.onerror=function(){micFailed(id)};
rec.onstop=function(){if(id!==generation||!active||current!==rec)return;var blob=new Blob(chunks,{type:(current.mimeType||t||'audio/mp4')});cleanupCapture();phase='idle';send(blob)};
rec.start();phase='recording';btn.classList.add('on');btn.textContent='说完了';holdPrimary('正在听你说…');
if(live){live.classList.remove('hidden');play(live,'m-rise')}if(note)note.textContent='';if(heard)heard.textContent='';
t0=Date.now();if(clock)clock.textContent='0:00';ticker=setInterval(function(){if(clock)clock.textContent=clockText(Math.floor((Date.now()-t0)/1000))},250);
startMeter(s);timer=setTimeout(stop,60000)}).catch(function(){micFailed(id)})})});
/* 整张练习纸：先是缩略图，点「展开看整张」或点缩略图展开；再点收起 */
within(scope,'.sheet-box').forEach(function(box){if(!once(box,'sheetbox'))return;var t=$('.sheet-toggle',box),f=$('.sheet-frame',box);
function set(open){box.setAttribute('data-open',open?'true':'false');if(t)t.setAttribute('aria-expanded',String(open));if(open)play(f,'m-rise')}
if(t)t.addEventListener('click',function(){set(box.getAttribute('data-open')!=='true')});
if(f)f.addEventListener('click',function(){if(box.getAttribute('data-open')!=='true'){trailAdd('content','sheet-open');trailSend();set(true)}})});
/* 离线页：真没联网时换标题 */
within(scope,'[data-offline-title]').forEach(function(off){if(navigator.onLine===false){off.textContent='没联网';var d=$('[data-offline-detail]');if(d)d.textContent='连上 Wi-Fi 或流量后点「再试一次」。拍过的照片和错题都在服务器上，不会丢。'}});
}

/* ---------- 等多久：「已经等了 40 秒」，每秒往上数（服务器出页时写了已经等了几秒） ---------- */
function elapsedText(s){s=Math.max(0,Math.floor(s));return s<60?'已经等了 '+s+' 秒':'已经等了 '+Math.floor(s/60)+' 分 '+(s%60)+' 秒'}
var ticking=null;
function tickElapsed(){var els=$$('[data-elapsed]');if(!els.length){clearInterval(ticking);ticking=null;return}
els.forEach(function(el){if(el.__t0===undefined)el.__t0=Date.now()-Number(el.getAttribute('data-elapsed')||0)*1000;var t=elapsedText((Date.now()-el.__t0)/1000);if(el.textContent!==t)el.textContent=t})}
function startElapsed(){if(!ticking&&$('[data-elapsed]')){tickElapsed();ticking=setInterval(tickElapsed,1000)}}

/* ---------- 等 AI 的页面：局部更新（代替整页刷新） ----------
   每隔 data-poll 秒取一次同一页（带 x-sel-poll: 1，服务器不把它记成「打开了一页」），只比较标了 data-live 的区域：
   没变就什么都不动（只有「已经等了多久」在走）；变了才把那几块换掉，别的地方（标题、滚动位置、他正在看的内容）一概不动。
   换上来的：变了的那几行浮上来、进度条往前走、主按钮换字滑进来、读屏念一句；然后报一次 update（一次状态变化记一次）。
   页面不再需要等（新的一页没有 data-poll）就停。看不见的时候不取；断网时退后再试，并在等待行后面说一声。 */
function sig(el){var c=el.cloneNode(true);$$('[data-elapsed]',c).forEach(function(e){e.textContent='';e.setAttribute('data-elapsed','')});
/* 渐进增强的临时状态不属于服务器内容，避免每次轮询都重建同一份安排。 */
within(c,'[data-week-sheet]').forEach(function(details){details.removeAttribute('data-sheet-ready');details.open=false;var summary=$('summary',details);if(summary){summary.removeAttribute('aria-haspopup');summary.removeAttribute('aria-expanded')}});
within(c,'*').forEach(function(e){e.removeAttribute('style');if(e.classList)Array.prototype.slice.call(e.classList).forEach(function(k){if(/^m-/.test(k))e.classList.remove(k)})});
$$('[data-wait-net]',c).forEach(function(e){e.classList.add('hidden')});return c.innerHTML}
function swapRegion(old,nu){var keepImgs={};$$('img',old).forEach(function(i){keepImgs[i.getAttribute('src')]=i});
var node=document.importNode(nu,true);
/* 同一张图不重新下载：把原来那张（已经加载好的）挪过来 */
$$('img',node).forEach(function(i){var o=keepImgs[i.getAttribute('src')];if(o){i.replaceWith(o);delete keepImgs[i.getAttribute('src')]}});
var said=[];
$$('[data-row]',node).forEach(function(r){var key=r.getAttribute('data-row');var before=$('[data-row="'+key+'"]',old);if(!before||before.textContent!==r.textContent){said.push(r.textContent.replace(/\s+/g,' ').trim());r.__rise=true}});
var oi=$('.progress i',old),ni=$('.progress i',node),to=ni&&ni.style.transform;if(oi&&ni)ni.style.transform=oi.style.transform;
var oldPrimary=old.matches('.next-bar')?primaryState(old):null;
old.replaceWith(node);
$$('[data-row]',node).forEach(function(r){if(r.__rise)play(r,'m-rise')});
if(oi&&ni)requestAnimationFrame(function(){requestAnimationFrame(function(){ni.style.transform=to})});
if(node.getAttribute('data-announce')){said.unshift(node.getAttribute('data-announce'));play(node,'m-rise')}
if(oldPrimary!==null&&primaryState(node)!==oldPrimary){var p=primaryOf(node);play(p,'m-swap');if(p&&!p.disabled)said.push(p.textContent)}
enhance(node);return said}
function startPolling(){var body=document.body;var every=Number(body.getAttribute('data-poll')||0);if(!every||!window.fetch||!window.DOMParser)return;
var timer=null,busy=false,misses=0,request=null,active=true,generation=0;
function later(ms){clearTimeout(timer);timer=setTimeout(pollOnce,ms)}
function net(down){$$('[data-wait-net]').forEach(function(e){e.classList.toggle('hidden',!down)})}
function apply(doc){if($('form[data-upload][data-upload-pending]')||document.body.classList.contains('sheet-is-open'))return 'later';var olds=$$('[data-live]'),pairs=[],a=document.activeElement;
for(var i=0;i<olds.length;i++){var name=olds[i].getAttribute('data-live');var nu=doc.querySelector('[data-live="'+name+'"]');if(!nu)return 'reload';if(sig(olds[i])!==sig(nu))pairs.push([olds[i],nu])}
if(doc.querySelectorAll('[data-live]').length!==olds.length)return 'reload';
if(!pairs.length)return 'same';
/* 他正在输入的那块先不换，下次再看 */
for(var j=0;j<pairs.length;j++){if(a&&a!==document.body&&pairs[j][0].contains(a)&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))return 'later'}
var said=[];pairs.forEach(function(p){said=said.concat(swapRegion(p[0],p[1]))});
document.title=doc.title;var ann=$('[data-announcer]');if(ann&&said.length)ann.textContent=said.slice(0,3).join('。');
startElapsed();trailAdd('auto','update');trailSend();return 'swapped'}
function pollOnce(){if(!active||document.visibilityState!=='visible'||busy)return;busy=true;var id=++generation;
request=boundedRequest(location.pathname+location.search,{headers:{'x-sel-poll':'1'},credentials:'same-origin',cache:'no-store'},15000,function(r){
if(r.status===429||r.status>=500)throw new Error('poll_retry');
if(!r.ok||r.redirected||new URL(r.url).pathname!==location.pathname)return{gone:true};return r.text().then(function(html){return{html:html}})});
request.promise.then(function(result){if(id!==generation||!active)return;request=null;busy=false;if(result.gone){location.reload();return}misses=0;net(false);
var doc=new DOMParser().parseFromString(result.html,'text/html');result=apply(doc);if(result==='reload'){location.reload();return}
var next=Number(doc.body.getAttribute('data-poll')||0);if(result==='later'){later(every*1000);return}
if(next>0){every=next;later(every*1000)}else{body.removeAttribute('data-poll');clearTimeout(timer)}}).catch(function(){if(id!==generation||!active)return;request=null;busy=false;misses+=1;net(true);later(Math.min(every*1000*Math.pow(2,misses),30000))})}
function pause(){generation+=1;clearTimeout(timer);if(request){request.cancel();request=null}busy=false}
document.addEventListener('visibilitychange',function(){if(document.visibilityState!=='visible')pause();else if(active&&body.getAttribute('data-poll'))later(0)});
window.addEventListener('pagehide',function(){active=false;pause()});
window.addEventListener('pageshow',function(){if(!active){active=true;if(body.getAttribute('data-poll'))later(0)}});
later(every*1000)}

${UPLOAD_QUEUE_SCRIPT}
document.addEventListener('DOMContentLoaded',function(){enhance(document.body);startElapsed();startPolling()});
})();
`;
