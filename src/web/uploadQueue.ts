import { PHOTO_PREPARE_SCRIPT, UPLOAD_TIMEOUT_MS } from './photoUpload.js';

/** 服务器 5xx / 网络断开 / 超时后的自动重试（P0-13）：指数退避的起点、上限与次数。 */
export const UPLOAD_RETRY_BASE_MS = 2_000;
export const UPLOAD_RETRY_MAX_MS = 60_000;
/** 连续自动重试这么多次仍不行，就停下来等学生点「全部重试」（联网或回到页面时也会再试）。 */
export const UPLOAD_RETRY_MAX_ATTEMPTS = 10;

/**
 * 第 attempt 次自动重试前等多久（毫秒）：2 s 起翻倍、上限 60 s、±20% 抖动，
 * 服务器给了 Retry-After 时不早于它。单独成串，单元测试直接取出来算。
 */
export const UPLOAD_BACKOFF_SCRIPT = `function backoffDelay(attempt,retryAfter,rand){var base=Math.min(${UPLOAD_RETRY_MAX_MS},${UPLOAD_RETRY_BASE_MS}*Math.pow(2,Math.max(0,attempt-1)));var d=Math.round(base*(0.8+0.4*(typeof rand==='number'?rand:Math.random())));if(retryAfter>0)d=Math.max(d,retryAfter);return Math.max(1000,d)}`;

/** Browser-only queue. IndexedDB contains private pending blobs, never a claim of server persistence. */
export const UPLOAD_QUEUE_SCRIPT = `
(function(){
var capture=$('[data-material-capture]'),box=$('[data-upload-queue]'),message=$('[data-queue-message]'),warning=$('[data-queue-warning]');
var namespace=capture?capture.dataset.draftNamespace:(document.body.dataset.draftNamespace||null),db=null,rows=[],active=null,stopped=false,expired=false,running=false,adding=Promise.resolve(),preparing=0,memory=false,ready=false,cooldownUntil=0,transientCooldown=false,saved=capture?Number(capture.dataset.savedCount):0,batchDone=0,dupes=0,dupesShown=0;
var channel=typeof BroadcastChannel==='function'?new BroadcastChannel('sel-material-drafts'):null;
${PHOTO_PREPARE_SCRIPT}
${UPLOAD_BACKOFF_SCRIPT}
var RETRY_MAX=${UPLOAD_RETRY_MAX_ATTEMPTS};
function say(s){if(message)message.textContent=s}
function warn(s){if(warning)warning.textContent=s}
function openDb(){return new Promise(function(resolve,reject){var req;try{req=indexedDB.open('sel-material-drafts',1)}catch(e){reject(e);return}req.onupgradeneeded=function(){req.result.createObjectStore('uploads',{keyPath:'uploadId'})};req.onerror=function(){reject(req.error)};req.onblocked=function(){reject(new Error('blocked'))};req.onsuccess=function(){db=req.result;db.onversionchange=function(){db.close();db=null};resolve(db)}})}
function transaction(mode,work){return new Promise(function(resolve,reject){if(!db){reject(new Error('unavailable'));return}var tx=db.transaction('uploads',mode),result;try{result=work(tx.objectStore('uploads'))}catch(e){reject(e);return}tx.oncomplete=function(){resolve(result&&result.result)};tx.onerror=tx.onabort=function(){reject(tx.error||new Error('storage'))}})}
function all(){return transaction('readonly',function(s){return s.getAll()}).then(function(rs){return rs.filter(function(r){return r.namespace===namespace})})}
function put(row){return transaction('readwrite',function(s){return s.put(row)})}
function remove(id){return transaction('readwrite',function(s){return s.delete(id)})}
function clear(ns){try{localStorage.setItem('sel-discard-'+ns,'1')}catch(e){}if(!db)return Promise.resolve();return transaction('readwrite',function(s){var req=s.openCursor();req.onsuccess=function(){var c=req.result;if(c){if(c.value.namespace===ns)c.delete();c.continue()}}}).then(function(){try{localStorage.removeItem('sel-discard-'+ns)}catch(e){}})}
function broadcast(ns){var v={namespace:ns,at:Date.now(),nonce:uuid()};if(channel)channel.postMessage(v);try{localStorage.setItem('sel-draft-clear',JSON.stringify(v))}catch(e){}}
// Account changed: stop and forget this account's drafts here. Session expired (same account): stop but keep them,
// including photos chosen after the expiry, so the same student finds them again after logging in (P1-3).
function stopForIdentity(clearRows){if(!clearRows){expire();return}stopped=true;expired=false;if(active)active.abort();say('登录状态已变化，上传已暂停。请重新登录后再打开。');var old=namespace;rows=[];void clear(old).catch(function(){});render()}
function expire(){if(stopped)return;stopped=true;expired=true;if(active)active.abort();render()}
function receive(v){if(v&&v.namespace===namespace)stopForIdentity(true)}
if(channel)channel.onmessage=function(e){receive(e.data)};
window.addEventListener('storage',function(e){if(e.key==='sel-draft-clear'){try{receive(JSON.parse(e.newValue))}catch(x){}}});
function retryDelay(response){var value=response.headers.get('retry-after');return Math.max(1000,value&&/^\\d+$/.test(value)?Number(value)*1000:value?Date.parse(value)-Date.now():5000)||5000}
function unreachable(status,retryAfter){var e=new Error('暂时连不上服务器，稍后自动重试。');e.status=status;e.transient=true;e.retryAfter=retryAfter||0;return e}
async function identity(){var response;try{response=await fetch('/s/materials/session',{headers:{accept:'application/json'},cache:'no-store',credentials:'same-origin'})}catch(e){throw unreachable(0)}if(response.status===429){var busy=new Error('rate_limited');busy.status=429;busy.retryAfter=retryDelay(response);cooldownUntil=Date.now()+busy.retryAfter;transientCooldown=false;setTimeout(drain,busy.retryAfter);throw busy}if(response.status===401||response.status===403)throw new Error('session');// An expired cookie is simply gone: the gateway then answers with its HTML login page, not JSON.
if(response.ok&&!/json/i.test(response.headers.get('content-type')||''))throw new Error('session');if(response.status>=500)throw unreachable(response.status,response.headers.get('retry-after')?retryDelay(response):0);var value;try{value=await response.json()}catch(e){throw unreachable(response.status)}
if(!response.ok||!value.draftNamespace){throw new Error('暂时连不上，请稍后重试。')}
if(namespace&&namespace!==value.draftNamespace){broadcast(namespace);stopForIdentity(true);throw new Error('identity')}
if(!namespace)namespace=value.draftNamespace;
try{var previous=localStorage.getItem('sel-active-draft');if(previous&&previous!==namespace){broadcast(previous);await clear(previous)}localStorage.setItem('sel-active-draft',namespace)}catch(e){}
if(typeof value.assetCount==='number')saved=value.assetCount;return value}
function permanent(row){return row.state==='failed'&&row.broken===true}
function retryNow(row){row.state='pending';row.lastError='';row.retryAt=0;row.waiting=false;row.attempts=0}
function retryAll(){cooldownUntil=0;transientCooldown=false;var changed=rows.filter(function(r){return !permanent(r)&&!r.noRetry&&(r.state==='failed'||r.retryAt)});changed.forEach(function(r){retryNow(r);void persist(r)});render();drain()}
var retryButton=null;if(capture&&message){retryButton=document.createElement('button');retryButton.type='button';retryButton.className='btn hidden';retryButton.dataset.retryAll='';retryButton.textContent='全部重试';retryButton.onclick=retryAll;message.after(retryButton)}
var relogin=null;if(capture&&message){relogin=document.createElement('a');relogin.className='btn primary hidden';relogin.href='/s/';relogin.dataset.relogin='';relogin.textContent='重新登录';(retryButton||message).after(relogin)}
// The way out (「拍完了，查看材料」), the count and the status appear only once something was taken.
var barLink=capture?$('[data-material-capture] [data-key="materials"]'):null,barText=barLink?($('[data-done-text]',barLink)||barLink):null,barTitle=barLink?barLink.getAttribute('aria-label'):'';
var progress=$('[data-capture-progress]'),done=$('[data-capture-done]'),cameraLabel=$('[data-capture-label]'),thumbs=$('[data-capture-thumbs]'),THUMBS_MAX=8;
if(barLink)barLink.addEventListener('click',function(e){if(barLink.getAttribute('aria-disabled')==='true'){e.preventDefault();warn('这台手机存不下待传照片，离开这一页就要重新选。等传完再去看材料。')}});
function setBar(text,blocked){if(memory)$$('[data-testid="next-step-caption"],[data-caption-flow]').forEach(function(c){c.textContent='这台手机存不下待传照片，传完前请留在这一页。'});if(!barLink)return;barLink.setAttribute('aria-label',text);barText.textContent=text;if(blocked)barLink.setAttribute('aria-disabled','true');else barLink.removeAttribute('aria-disabled')}
// Thumbnails of the photos saved from this page, from the local copy (no extra download). Oldest are dropped.
function addThumb(blob){if(!thumbs||!blob||typeof URL.createObjectURL!=='function')return;var li=document.createElement('li'),img=document.createElement('img');img.alt='刚拍的照片';img.src=URL.createObjectURL(blob);img.onload=img.onerror=function(){URL.revokeObjectURL(img.src)};li.appendChild(img);thumbs.prepend(li);while(thumbs.children.length>THUMBS_MAX)thumbs.lastElementChild.remove();thumbs.classList.remove('hidden')}
function seconds(ms){return Math.max(1,Math.round(ms/1000))}
function render(){if(!box)return;box.replaceChildren();rows.forEach(function(row){var li=document.createElement('li'),p=document.createElement('p');var waitingFor=row.state==='pending'&&row.retryAt&&row.retryAt>Date.now()?row.retryAt-Date.now():0;
p.textContent=row.filename+' · '+(row.state==='uploading'?'正在上传…':permanent(row)?'传不上去：'+(row.lastError||'这张照片用不了。'):row.state==='failed'?(row.lastError||'没传上去'):waitingFor&&row.waiting?(row.lastError||'暂时连不上服务器。')+' 约 '+seconds(waitingFor)+' 秒后自动重试。':'等待上传');if(permanent(row))p.className='tone-red';li.appendChild(p);
if(!permanent(row)&&!row.noRetry&&(row.state==='failed'||(row.waiting&&waitingFor))){var retry=document.createElement('button');retry.type='button';retry.className='btn';retry.textContent='重试';retry.onclick=function(){retryNow(row);cooldownUntil=0;transientCooldown=false;void persist(row).then(drain);render()};li.appendChild(retry)}
if(row.state!=='uploading'){var del=document.createElement('button');del.type='button';del.className='link-btn';del.textContent='删除待传';del.onclick=async function(){try{if(db)await remove(row.uploadId);rows=rows.filter(function(r){return r!==row});render()}catch(e){warn('没能删除，请重试。')}};li.appendChild(del)}box.appendChild(li)});
var count=$('[data-testid="photo-count"]');if(count)count.textContent='已拍 '+saved+' 张';var examples=$('[data-testid="capture-examples"]');if(examples)examples.classList.toggle('hidden',saved>0);
var taken=saved>0||rows.length>0||preparing>0;if(progress)progress.classList.toggle('hidden',!taken&&!stopped);if(done)done.classList.toggle('hidden',!taken);if(cameraLabel)cameraLabel.textContent=taken?'继续拍照':'拍照';
var broken=rows.filter(permanent).length,stuck=rows.filter(function(r){return r.state==='failed'&&!r.broken&&r.noRetry}).length,left=rows.length-broken-stuck+preparing,failedRows=rows.filter(function(r){return r.state==='failed'&&!r.broken&&!r.noRetry}).length,waitingRows=rows.filter(function(r){return r.waiting&&r.retryAt>Date.now()}).length;
if(retryButton)retryButton.classList.toggle('hidden',stopped||!(failedRows||waitingRows));if(relogin)relogin.classList.toggle('hidden',!expired);
var brokenNote=(broken?'有 '+broken+' 张传不了，删掉后重新选择。':'')+(stuck?'有 '+stuck+' 张需要按下面的提示处理。':'');
if(!left)batchDone=0;
if(stopped){setBar(barTitle,false);if(expired)say(memory?'登录已过期，上传已暂停。这台手机存不下待传照片'+(left?'，重新登录后需要重新选这 '+left+' 张':'')+'。':'登录已过期，上传已暂停。'+(left?'还没传的 '+left+' 张照片存在这台手机上，':'')+'重新登录后回到这一页会接着传。');return}
if(left){var total=batchDone+left;setBar('上传中 '+batchDone+'/'+total+(memory?'（先别离开）':'（可以离开）'),memory);
if(failedRows&&failedRows===left&&!preparing)say('有 '+failedRows+' 张没传上去，点「全部重试」再试。照片还在这台手机上。'+brokenNote);
else if(transientCooldown&&cooldownUntil>Date.now())say('暂时连不上服务器，约 '+seconds(cooldownUntil-Date.now())+' 秒后自动重试。还有 '+left+' 张待上传，照片都还在这台手机上。'+brokenNote);
else say('正在上传，还剩 '+left+' 张。'+(memory?'这台手机存不下待传照片，传完前请先别离开这一页。':'可以先离开，回到这一页会接着传。')+brokenNote)}
else{setBar(barTitle,false);if(broken||stuck)say((saved>0?'其他照片已保存。':'')+brokenNote);else if(ready&&saved>0){say('照片已保存，可以先离开')}else if(ready){say('还没有待上传的照片。')}}
if(dupes!==dupesShown){dupesShown=dupes;warn((dupes===1?'这张已经拍过了':'有 '+dupes+' 张已经拍过了')+'，没有重复保存，也不会重复整理。')}}
async function persist(row){if(row.memory)return;try{await put(row)}catch(e){memory=true;row.memory=true;warn('浏览器暂存不了照片，已改为逐张直传。请留在这一页直到全部上传完成；没传完的照片关页后需要重选。')}}
function upload(row){return new Promise(function(resolve,reject){var xhr=new XMLHttpRequest();active=xhr;xhr.open('POST','/s/materials/uploads');xhr.timeout=${UPLOAD_TIMEOUT_MS};xhr.setRequestHeader('accept','application/json');xhr.setRequestHeader('x-draft-namespace',namespace);xhr.setRequestHeader('x-upload-id',row.uploadId);var data=new FormData();data.append('captureId',row.captureId);data.append('hints',JSON.stringify(row.hints));data.append('photo',row.blob,'photo.jpg');
xhr.onload=function(){active=null;var b=null;try{b=JSON.parse(xhr.responseText)}catch(e){}if(xhr.status>=200&&xhr.status<300&&b&&b.ok===true&&typeof b.assetId==='string'&&b.assetId&&b.job&&typeof b.job.id==='string'&&b.job.id&&b.job.kind==='extract'&&['queued','running','succeeded','failed','interrupted','stale'].includes(b.job.state)){resolve(b);return}var error=new Error(b&&b.error?b.error.message:xhr.status>=500?'暂时连不上服务器，稍后自动重试。':'没传上去，请重试。');error.status=xhr.status;error.code=b&&b.error&&b.error.code;var delay=xhr.getResponseHeader('retry-after');error.retryAfter=delay&&/^\\d+$/.test(delay)?Number(delay)*1000:delay?Math.max(1000,Date.parse(delay)-Date.now()):5000;if(xhr.status>=500)error.transient=true;reject(error)};
xhr.onerror=function(){active=null;var e=new Error('网络没连上，稍后自动重试。');e.transient=true;reject(e)};xhr.ontimeout=function(){active=null;var e=new Error('上传超时了，稍后自动重试。');e.transient=true;reject(e)};xhr.onabort=function(){active=null;reject(new Error('上传已暂停。'))};xhr.send(data)})}
async function run(){if(running||stopped||!capture||Date.now()<cooldownUntil)return;running=true;
try{await identity();if(!memory){var latest=await all();var local=rows.filter(function(r){return r.memory});rows=latest.concat(local);rows.forEach(function(r){if(r.state==='uploading'||(!ready&&!r.terminal))r.state='pending'})}ready=true;transientCooldown=false;
while(!stopped){var row=rows.find(function(r){return r.state==='pending'&&(!r.retryAt||r.retryAt<=Date.now())});if(!row){var waiting=rows.filter(function(r){return r.state==='pending'&&r.retryAt});if(waiting.length)setTimeout(drain,Math.max(1,Math.min.apply(null,waiting.map(function(r){return r.retryAt-Date.now()}))));break;}
try{await identity();row.state='uploading';row.waiting=false;await persist(row);render();
if(!row.prepared){row.blob=await prepare(row.blob);if(stopped)break;row.prepared=true;await persist(row)}
await identity();if(!row.captureId){var c;try{c=await fetch('/s/materials/captures',{method:'POST',credentials:'same-origin',headers:{accept:'application/json','content-type':'application/json','x-draft-namespace':namespace},body:JSON.stringify({requestId:row.captureRequestId})})}catch(x){throw unreachable(0)}var b={};try{b=await c.json()}catch(x){}if(!c.ok||!b.id){var ce=c.status>=500?unreachable(c.status):new Error(b.error?b.error.message:'暂时无法上传');ce.status=c.status;ce.retryAfter=c.status===429||c.headers.get('retry-after')?retryDelay(c):0;ce.code=b.error&&b.error.code;throw ce}if(stopped)break;row.captureId=b.id;await persist(row)}
await identity();var ack=await upload(row);if(stopped)break;if(ack.duplicate)dupes+=1;else addThumb(row.blob);batchDone+=1;
// Only a durable server ack can remove a blob or advance the saved count.
if(db){try{await remove(row.uploadId)}catch(e){warn('照片已传到服务器，但浏览器没能清理待传记录。重开后会再次核对，不会重复保存。')}}
rows=rows.filter(function(r){return r.uploadId!==row.uploadId});await identity();render();
}catch(e){if(e.message==='session'||e.message==='identity'||e.status===401||e.code==='draft_identity_changed'){stopForIdentity(e.message==='identity'||e.code==='draft_identity_changed');break}if(stopped)break;
if(e.status===429){var delay=Math.max(1000,e.retryAfter||5000);row.retryAt=Date.now()+delay;cooldownUntil=row.retryAt;transientCooldown=false;row.state='pending';row.lastError=e.message;await persist(row);render();setTimeout(drain,delay);break}
// P0-13: a release restart (502/503/504), capacity 503 or a dropped connection is temporary. Back off and retry
// the same upload ID by itself; the server replays an already saved photo instead of storing it twice.
if(e.transient&&(row.attempts||0)<RETRY_MAX){row.attempts=(row.attempts||0)+1;var wait=backoffDelay(row.attempts,e.retryAfter,Math.random());row.state='pending';row.waiting=true;row.lastError=e.message;row.retryAt=Date.now()+wait;cooldownUntil=row.retryAt;transientCooldown=true;await persist(row);render();setTimeout(drain,wait);break}
row.state='failed';row.waiting=false;row.retryAt=0;row.noRetry=e.code==='upload_identity_unavailable';
// A photo the browser or server cannot read (corrupt, unsupported HEIC, too large) fails every time: no retry button.
var broken=e.message==='decode'||e.message==='too_big'||e.status===413||e.code==='invalid_image';
row.broken=broken;row.terminal=broken||e.status===400||row.noRetry;if(broken)row.noRetry=true;
row.lastError=e.message==='decode'?(isHeic({type:row.blob.type,name:row.filename})?'这张 HEIC 照片这个浏览器读不了。用 Safari 重新选，或换成 JPEG。':'这张照片读不了，可能已经损坏。请删掉后重新选择。'):e.message==='prepare_timeout'?'准备照片超时了，请重试。':e.message==='too_big'?'照片太大，转换后仍超过上限。请换一张。':e.transient?'连续几次都没连上服务器，点「全部重试」再试。':e.message;await persist(row);render()}
}
}catch(e){if(e.status===429){warn('服务器有点忙，稍后自动继续。');setTimeout(drain,e.retryAfter||5000)}else if(e.message==='session'||e.message==='identity')stopForIdentity(e.message==='identity');else if(e.transient){var later=backoffDelay(2,e.retryAfter,Math.random());cooldownUntil=Date.now()+later;transientCooldown=true;setTimeout(drain,later);warn('暂时连不上服务器，待传照片还在，稍后自动重试。')}else warn('暂时连不上，待传照片还在。重新打开或点重试。')}
finally{running=false;render()}}
function drain(){if(stopped||!capture)return;if(Date.now()<cooldownUntil){setTimeout(drain,cooldownUntil-Date.now());return;} if(navigator.locks)navigator.locks.request('sel-material-upload-'+namespace,function(){return run()}).catch(function(){warn('上传暂停，请重新打开。')});else void run()}
function selectedHints(form){var hints={},rs=$$('input[name=roles]:checked',form).map(function(i){return i.value});if(rs.length)hints.roles=rs;var m=$('[name=marking]',form),l=$('[name=label]',form);if(m&&m.value)hints.marking=m.value;if(l&&l.value.trim())hints.label=l.value.trim();['questionId','attemptId'].forEach(function(k){var field=$('[name='+k+']',form);if(field&&field.value)hints[k]=field.value});return hints}
// After a session expiry the page still belongs to the same account: keep newly chosen photos for after re-login.
if(capture){var form=$('form[data-material-upload]');var captureRequestId=uuid();$$('input[type=file]',form).forEach(function(input){input.addEventListener('change',function(){var files=Array.from(input.files||[]),hints=selectedHints(form);input.value='';preparing+=files.length;render();files.forEach(function(file){adding=adding.then(async function(){await initialized;if(stopped&&!expired){preparing-=1;render();return}var row={namespace:namespace,uploadId:uuid(),captureRequestId:captureRequestId,captureId:'',blob:file,filename:file.name,hints:hints,state:'pending',lastError:'',prepared:false,memory:memory};rows.push(row);await persist(row);preparing-=1;render();drain()})})})});form.addEventListener('submit',function(e){e.preventDefault()})}
function resume(){if(stopped)return;if(transientCooldown){cooldownUntil=0;transientCooldown=false}rows.forEach(function(r){if((r.state==='failed'&&!r.terminal)||r.waiting){retryNow(r);void persist(r)}});drain()}
window.addEventListener('online',resume);
// The queue talks to the server only on the capture page or when settings offers logout.
// Other pages must not issue a session fetch; voice and poll lifecycles count every request.
var logout=$('form[action="/s/logout"]');
var watch=!!(capture||logout);
if(watch)document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible'&&!stopped)void identity().then(function(){if(capture)resume()}).catch(function(e){if(e.message==='session'||e.message==='identity')stopForIdentity(e.message==='identity');else if(e.status!==429)warn('暂时连不上，待传照片还在。重新打开或点重试。')})});
if(logout)logout.addEventListener('submit',async function(e){if(logout.dataset.confirmed==='1')return;e.preventDefault();await initialized;if(!namespace){logout.dataset.confirmed='1';HTMLFormElement.prototype.submit.call(logout);return}try{await identity();var pending=db?await all().catch(function(){return null}):null;if(!pending||pending.length||rows.length){if($('[data-draft-logout]'))return;var panel=document.createElement('div');panel.className='card';panel.dataset.draftLogout='';var p=document.createElement('p');p.textContent=pending?'还有照片没传到服务器。':'暂时无法查看待传照片。其他拍照页面可能还有照片没上传。';var keep=document.createElement('a');keep.className='btn';keep.href='/s/capture';keep.textContent='继续上传';var discard=document.createElement('button');discard.className='btn';discard.type='button';discard.textContent='删除待传后退出';discard.onclick=async function(){await clear(namespace).catch(function(){});broadcast(namespace);logout.dataset.confirmed='1';HTMLFormElement.prototype.submit.call(logout)};panel.append(p,keep,discard);logout.before(panel);return}broadcast(namespace);logout.dataset.confirmed='1';HTMLFormElement.prototype.submit.call(logout)}catch(x){warn('登录状态已变化，请重新打开页面。')}});
var initialized=watch?(async function(){try{await openDb()}catch(e){memory=true;warn('浏览器暂存不了照片，已改为逐张直传。上传完成前请勿关页。')}
try{await identity();if(db){try{if(localStorage.getItem('sel-discard-'+namespace))await clear(namespace)}catch(e){}rows=await all();for(var row of rows){if(!row.terminal){row.state='pending';row.retryAt=0;row.waiting=false;row.attempts=0}await persist(row)}}ready=true;render();drain()}catch(e){if(e.status===429){ready=true;setTimeout(drain,e.retryAfter||5000)}else if(capture&&e.message==='session'){if(db){try{rows=await all()}catch(x){}}stopForIdentity(false)}else if(capture&&e.message==='identity')stopForIdentity(true);else if(capture&&e.transient){var later=backoffDelay(1,e.retryAfter,Math.random());cooldownUntil=Date.now()+later;transientCooldown=true;setTimeout(drain,later);warn('暂时无法恢复待传照片，稍后会自动再试。');render()}else if(capture){warn('暂时无法恢复待传照片，请重新打开页面。');render()}}})():Promise.resolve();
// Other pages (including the first page after logging in again): say plainly that photos are still waiting here.
if(!capture&&!logout&&namespace&&typeof indexedDB!=='undefined'){openDb().then(all).then(function(rs){if(!rs.length)return;var main=$('main');if(!main||$('[data-pending-uploads]'))return;var bad=rs.filter(function(r){return r.broken===true}).length,left=rs.length-bad;var card=document.createElement('section');card.className='card';card.dataset.pendingUploads='';var p=document.createElement('p');p.textContent=left?'还有 '+left+' 张照片没传完，先存在这台手机上。':'有 '+bad+' 张照片传不了，需要删掉或重新选择。';var a=document.createElement('a');a.className='btn';a.href='/s/capture';a.textContent=left?'回拍照页继续上传':'去拍照页处理';card.append(p,a);main.prepend(card)}).catch(function(){})}
})();
`;
