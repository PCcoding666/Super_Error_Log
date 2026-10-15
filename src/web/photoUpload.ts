/**
 * 拍照/相册上传的浏览器端准备与上传（2026-10-15 线上修复）：
 * 服务器 sharp 读不了 HEIC、40MP 以上直接拒收，所以照片先在浏览器里用 Image + canvas
 * 转成 JPEG（最长边 4096、不放大小图、去掉位置等拍摄信息）再上传。
 * 常量在这里定义并插进脚本字符串，单元测试直接验纯函数，E2E 验真实浏览器行为。
 */

/** 转换后最长边（像素）。服务端解码上限 40MP，4096×4096 以内一定够。 */
export const MAX_UPLOAD_EDGE = 4096;
/** 上传字节上限（与服务端 MAX_PHOTO_BYTES 一致）。 */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
/** JPEG 质量阶梯：先高质量，超过字节上限再逐级降。 */
export const JPEG_QUALITY_LADDER = [0.92, 0.85, 0.78, 0.7];
/** 准备（解码 + 转换）有界超时：大图在旧手机上也不无限等。 */
export const PREPARE_TIMEOUT_MS = 30_000;
/** XHR 有界超时：弱网传 15MB 也够。 */
export const UPLOAD_TIMEOUT_MS = 120_000;

/** 最长边不超过 maxEdge 的等比尺寸；小图不放大。 */
export function targetSize(width: number, height: number, maxEdge: number = MAX_UPLOAD_EDGE): { width: number; height: number } {
  if (width <= 0 || height <= 0) throw new Error('Invalid image dimensions');
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * 嵌入 CLIENT_SCRIPT 的 DOMContentLoaded 段里运行（依赖同作用域的 $、$$、uuid、trailAdd）。
 * 行为约定（E2E 断言）：
 * - 选好照片立刻「正在准备照片…」；转换成功才发请求；传完 100% 显示「上传完成，正在处理照片…」。
 * - 2xx 但响应不是 {ok:true, jobId} 不算成功；网络/超时/服务/图片错误文案分开。
 * - 图片本身的问题（读不了、转完仍太大）不出「再试一次」，重选入口始终在；其余失败可重试，同一张用同一幂等 key。
 * - 一次只允许一个准备/上传（busy），避免竞态与重复提交。
 */
export const PHOTO_UPLOAD_SCRIPT = `
/* 拍照上传：先在浏览器里转成 JPEG（最长边 ${MAX_UPLOAD_EDGE}、去拍摄信息）再上传；失败可重试或可重选。 */
var form=$('form[data-upload]');
if(form){var bar=$('[data-upload-progress]'),msg=$('[data-upload-message]'),retry=$('[data-upload-retry]'),pending=null,busy=false;
var inputs=$$('input[type=file]',form),labels=$$('label',form);
var MAX_EDGE=${MAX_UPLOAD_EDGE},MAX_BYTES=${MAX_UPLOAD_BYTES},PREPARE_MS=${PREPARE_TIMEOUT_MS},UPLOAD_MS=${UPLOAD_TIMEOUT_MS},QUALITIES=${JSON.stringify(JPEG_QUALITY_LADDER)};
function say(t){if(msg)msg.textContent=t}
function showBar(on){if(bar)bar.classList.toggle('hidden',!on)}
function resetBar(){if(bar&&$('i',bar))$('i',bar).style.width='0%'}
function showRetry(on){if(retry)retry.classList.toggle('hidden',!on)}
function setBusy(on){busy=on;inputs.forEach(function(i){i.disabled=on});labels.forEach(function(l){l.setAttribute('aria-disabled',String(on))});if(retry)retry.disabled=on}
function fail(kind,text,retryable){setBusy(false);showBar(false);say(text);showRetry(!!retryable);trailAdd('error',kind);trailSend()}
function isHeic(f){var t=(f.type||'').toLowerCase();return t.indexOf('heic')>=0||t.indexOf('heif')>=0||/\\.hei[cf]$/i.test(f.name||'')}
function prepare(file){return new Promise(function(resolve,reject){
var url=null,img=new Image(),canvas=null,done=false;
var timer=setTimeout(function(){finish(new Error('prepare_timeout'))},PREPARE_MS);
function finish(err,blob){if(done)return;done=true;clearTimeout(timer);img.onload=img.onerror=null;if(url)URL.revokeObjectURL(url);if(canvas){canvas.width=0;canvas.height=0}if(err)reject(err);else resolve(blob)}
img.onload=function(){if(done)return;try{var w=img.naturalWidth,h=img.naturalHeight;
if(!w||!h){finish(new Error('decode'));return}
var scale=Math.min(1,MAX_EDGE/Math.max(w,h));
var cw=Math.max(1,Math.round(w*scale)),ch=Math.max(1,Math.round(h*scale));
canvas=document.createElement('canvas');canvas.width=cw;canvas.height=ch;
var ctx=canvas.getContext('2d');if(!ctx){finish(new Error('encode'));return}
ctx.drawImage(img,0,0,cw,ch);
var i=0;function enc(){if(done)return;try{canvas.toBlob(function(b){if(done)return;
if(!b||!b.size||b.type!=='image/jpeg'){finish(new Error('encode'));return}
if(b.size<=MAX_BYTES){finish(null,b);return}
if(i>=QUALITIES.length-1){finish(new Error('too_big'));return}
i+=1;enc()},'image/jpeg',QUALITIES[i])}catch(e){finish(new Error('encode'))}}enc()
}catch(e){finish(new Error('encode'))}};
img.onerror=function(){finish(new Error('decode'))};
try{url=URL.createObjectURL(file);img.src=url}catch(e){finish(new Error('decode'))}})}
function upload(entry){try{var data=new FormData();data.append('key',entry.key);data.append('photo',entry.blob,'photo.jpg');
var xhr=new XMLHttpRequest();xhr.open('POST',form.getAttribute('action'));xhr.setRequestHeader('accept','application/json');xhr.timeout=UPLOAD_MS;
resetBar();say('正在上传…');
xhr.upload.onprogress=function(e){if(e.lengthComputable){var p=Math.round(e.loaded*100/e.total);if(bar)$('i',bar).style.width=p+'%';say(p>=100?'上传完成，正在处理照片…':'正在上传 '+p+'%')}};
xhr.onload=function(){var body=null;try{body=JSON.parse(xhr.responseText)}catch(e){}
if(xhr.status>=200&&xhr.status<300&&body&&body.ok===true&&typeof body.jobId==='string'&&body.jobId){location.replace('/s/capture');return}
if(body&&body.error&&typeof body.error.message==='string')fail('upload_'+xhr.status,body.error.message,xhr.status!==400);
else fail(xhr.status>=500?'upload_server':'upload_bad','没传上去。过一会儿再试，照片还在这个页面里。',true)};
xhr.ontimeout=function(){fail('upload_timeout','上传超时了。照片还在这个页面里，点「再试一次」。',true)};
xhr.onerror=function(){fail('upload_network','网络没连上，没传上去。照片还在这个页面里。',true)};
xhr.send(data)}catch(e){fail('upload_network','没传上去。点「再试一次」，或者重新选择照片。',true)}}
function start(entry){pending=entry;setBusy(true);resetBar();showBar(true);showRetry(false);
if(entry.blob){upload(entry);return}say('正在准备照片…');
prepare(entry.file).then(function(blob){entry.blob=blob;upload(entry)}).catch(function(err){
if(err&&err.message==='too_big')fail('prepare_big','这张照片转出来还是太大，换一张试试。',false);
else if(err&&err.message==='prepare_timeout')fail('prepare_timeout','准备照片超时了。点「再试一次」，或者换一张。',true);
else if(err&&err.message==='encode')fail('prepare_encode','照片转换没完成。点「再试一次」，或者换一张。',true);
else if(isHeic(entry.file))fail('prepare_heic','这张照片是 HEIC 格式，这个浏览器读不了。用 iPhone 自带的 Safari 打开这个网页再选一次，或者换一张 JPEG 照片。',false);
else fail('prepare_decode','这个浏览器读不了这张照片。换 Safari 打开试试，或者选一张 JPEG 照片。',false)})}
inputs.forEach(function(input){input.addEventListener('change',function(){var f=input.files&&input.files[0];input.value='';if(!f||busy)return;start({file:f,key:uuid(),blob:null})})});
labels.forEach(function(label){label.addEventListener('click',function(e){if(busy)e.preventDefault()})});
form.addEventListener('submit',function(e){e.preventDefault()});
if(retry)retry.addEventListener('click',function(){if(pending&&!busy)start(pending)})}
`;
