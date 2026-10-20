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
/** 与服务端唯一上传槽位一致；图片解码也在同一队列内，避免手机同时持有多张大画布。 */
export const UPLOAD_CONCURRENCY = 1;

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
 * - 相册多选后自动排队，准备/上传共用单并发；全部成功才刷新，部分失败留在本页。
 * - 每张独立保存 key 与已转换的 JPEG；重试只重新排入可重试的失败项。
 */
export const PHOTO_UPLOAD_SCRIPT = `
/* 拍照上传：先在浏览器里转成 JPEG（最长边 ${MAX_UPLOAD_EDGE}、去拍摄信息）再上传；失败可重试或可重选。 */
var form=uploadForm;
if(form){var bar=$('[data-upload-progress]',form),msg=$('[data-upload-message]',form),retry=$('[data-upload-retry]',form),uploadList=$('[data-upload-list]',form),uploadNext=$('[data-upload-next]',form),entries=[],busy=false,activeUploads=0;
var inputs=$$('input[type=file]',form);
var library=$('#library-input',form);if(library)library.multiple=!form.hasAttribute('data-work-upload')||form.hasAttribute('data-batch-work');
var photoCount=$('[data-testid="photo-count"]'),initialCount=Number(form.getAttribute('data-photo-count')||0);
var MAX_EDGE=${MAX_UPLOAD_EDGE},MAX_BYTES=${MAX_UPLOAD_BYTES},PREPARE_MS=${PREPARE_TIMEOUT_MS},UPLOAD_MS=${UPLOAD_TIMEOUT_MS},QUALITIES=${JSON.stringify(JPEG_QUALITY_LADDER)};
function setUploadBusy(on){busy=on;inputs.forEach(function(i){i.disabled=on});$$('label[for="camera-input"],label[for="library-input"]').forEach(function(l){if(l.control&&l.control.form===form)l.setAttribute('aria-disabled',String(on))});if(retry)retry.disabled=on}
function uploadFailure(kind,message,retryable){return {kind:kind,message:message,retryable:retryable}}
function progressValue(node,p){if(!node)return;node.setAttribute('aria-valuenow',String(p));$('i',node).style.transform='scaleX('+(p/100)+')'}
function renderUploads(){var successes=0,failures=0,retryable=0,totalProgress=0;
entries.forEach(function(entry){
if(entry.state==='succeeded'){successes+=1;totalProgress+=100}
else if(entry.state==='failed'){failures+=1;if(entry.retryable)retryable+=1}
else totalProgress+=Math.min(99,entry.progress);
entry.status.textContent=(entry.state==='failed'?'上传失败 · ':'')+entry.message;
entry.status.setAttribute('data-upload-state',entry.state);
entry.status.className='small '+(entry.state==='failed'?'tone-red':entry.state==='succeeded'?'tone-green':'muted');
progressValue(entry.progressBar,entry.progress)});
/* 按照片等权汇总；只有服务端确认成功才计满 100%，失败项不伪装成已上传。 */
var percent=entries.length?Math.min(successes===entries.length?100:99,Math.round(totalProgress/entries.length)):0;
if(bar){bar.classList.toggle('hidden',!busy&&entries.length<2);progressValue($('[role=progressbar]',bar),percent)}
if(msg){msg.textContent=entries.length===1?entries[0].message:'已上传 '+successes+'/'+entries.length+' 张 · 整批进度 '+percent+'%'+(failures?' · '+failures+' 张失败':'')+(busy?' · 正在处理…':'');}
if(retry){retry.classList.toggle('hidden',busy||!retryable);retry.textContent=entries.length>1?'只重试失败照片（'+retryable+' 张）':'再试一次'}
if(uploadNext)uploadNext.classList.toggle('hidden',busy||!successes);
if(photoCount&&successes){photoCount.textContent='已拍 '+(initialCount+successes)+' 张';photoCount.classList.remove('hidden')}
}
function appendUploadRow(entry){var row=document.createElement('li');row.className='upload-item';row.setAttribute('data-upload-item','');
if(form.hasAttribute('data-work-upload')){var preview=document.createElement('img');preview.className='crop';preview.alt='作答照片预览';var previewUrl=URL.createObjectURL(entry.file);preview.src=previewUrl;preview.onload=preview.onerror=function(){URL.revokeObjectURL(previewUrl)};row.appendChild(preview)}
if(form.hasAttribute('data-capture-upload')){var thumb=document.createElement('img');thumb.className='upload-thumb';thumb.alt='本次上传照片';thumb.width=48;thumb.height=60;thumb.loading='lazy';var thumbUrl=URL.createObjectURL(entry.file);thumb.src=thumbUrl;thumb.onload=thumb.onerror=function(){URL.revokeObjectURL(thumbUrl)};row.appendChild(thumb)}
var name=document.createElement('p');name.className='upload-name small';name.textContent=form.hasAttribute('data-capture-upload')?entry.name:'第 '+(entries.length+1)+' 张 · '+entry.name;
entry.status=document.createElement('p');entry.progressBar=document.createElement('div');entry.progressBar.className='progress';
entry.progressBar.setAttribute('role','progressbar');entry.progressBar.setAttribute('aria-label','第 '+(entries.length+1)+' 张上传进度');entry.progressBar.setAttribute('aria-valuemin','0');entry.progressBar.setAttribute('aria-valuemax','100');
entry.progressBar.appendChild(document.createElement('i'));row.appendChild(name);row.appendChild(entry.status);row.appendChild(entry.progressBar);if(uploadList)uploadList.appendChild(row)}
function appendUploadedPhoto(entry){var photoGrid=$('[data-photo-grid]'),tips=$('[data-testid="capture-tips"]'),camera=$('.next-bar label[for="camera-input"]'),skip=$('.next-bar [data-key="skipShoot"]');
if(tips)tips.classList.add('hidden');if(camera)camera.textContent='再拍一页';if(skip&&skip.closest('form'))skip.closest('form').classList.add('hidden');
if(!photoGrid)return;var figure=document.createElement('figure'),img=document.createElement('img'),caption=document.createElement('figcaption');
figure.setAttribute('data-testid','photo-tile');img.src='/s/img/photo/'+encodeURIComponent(entry.jobId);img.alt=entry.name;img.loading='lazy';
caption.textContent=entry.name+' · 已上传，AI 正在找题';figure.appendChild(img);figure.appendChild(caption);photoGrid.appendChild(figure)}
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
function upload(entry){return new Promise(function(resolve,reject){var settled=false;
function finish(error,jobId){if(settled)return;settled=true;if(error)reject(error);else resolve(jobId)}
try{var data=new FormData();data.append('key',entry.key);data.append('photo',entry.blob,'photo.jpg');
var xhr=new XMLHttpRequest();xhr.open('POST',form.getAttribute('action'));xhr.setRequestHeader('accept','application/json');xhr.timeout=UPLOAD_MS;
entry.state='uploading';entry.progress=0;entry.message='正在上传…';renderUploads();
xhr.upload.onprogress=function(e){if(!settled&&e.lengthComputable&&e.total>0){var p=Math.min(100,Math.round(e.loaded*100/e.total));entry.progress=p;entry.message=p>=100?'上传完成，正在处理照片…':'正在上传 '+p+'%';renderUploads()}};
xhr.onload=function(){var body=null;try{body=JSON.parse(xhr.responseText)}catch(e){}
if(xhr.status>=200&&xhr.status<300&&body&&body.ok===true&&typeof body.jobId==='string'&&body.jobId){finish(null,body.jobId);return}
if(body&&body.error&&typeof body.error.message==='string')finish(uploadFailure('upload_'+xhr.status,body.error.message,xhr.status!==400));
else finish(uploadFailure(xhr.status>=500?'upload_server':'upload_bad','没传上去。过一会儿再试，照片还在这个页面里。',true))};
xhr.ontimeout=function(){finish(uploadFailure('upload_timeout','上传超时了。照片还在这个页面里，点「再试一次」。',true))};
xhr.onerror=function(){finish(uploadFailure('upload_network','网络没连上，没传上去。照片还在这个页面里。',true))};
xhr.onabort=function(){finish(uploadFailure('upload_abort','上传中断了。照片还在这个页面里，点「再试一次」。',true))};
xhr.send(data)}catch(e){finish(uploadFailure('upload_network','没传上去。点「再试一次」，或者重新选择照片。',true))}})}
function processUpload(entry){entry.state='preparing';entry.message='正在准备照片…';renderUploads();
var ready=entry.blob?Promise.resolve(entry.blob):prepare(entry.file);
ready.then(function(blob){entry.blob=blob;return upload(entry)}).then(function(jobId){
entry.jobId=jobId;entry.state='succeeded';entry.progress=100;entry.message=form.hasAttribute('data-work-upload')?'作答已保存':'已上传 · AI 正在找题';entry.blob=null;entry.file=null;appendUploadedPhoto(entry)
}).catch(function(err){var failure;
if(err&&err.kind)failure=err;
else if(err&&err.message==='too_big')failure=uploadFailure('prepare_big','这张照片转出来还是太大，换一张试试。',false);
else if(err&&err.message==='prepare_timeout')failure=uploadFailure('prepare_timeout','准备照片超时了。点「再试一次」，或者换一张。',true);
else if(err&&err.message==='encode')failure=uploadFailure('prepare_encode','照片转换没完成。点「再试一次」，或者换一张。',true);
else if(isHeic(entry.file))failure=uploadFailure('prepare_heic','这张照片是 HEIC 格式，这个浏览器读不了。用 iPhone 自带的 Safari 打开这个网页再选一次，或者换一张 JPEG 照片。',false);
else failure=uploadFailure('prepare_decode','这个浏览器读不了这张照片。换 Safari 打开试试，或者选一张 JPEG 照片。',false);
entry.state='failed';entry.progress=0;entry.message=failure.message;entry.retryable=failure.retryable;
if(!entry.retryable){entry.file=null;entry.blob=null}trailAdd('error',failure.kind);trailSend()
}).then(function(){activeUploads-=1;pumpUploads()})}
function pumpUploads(){while(activeUploads<${UPLOAD_CONCURRENCY}){var entry=entries.find(function(e){return e.state==='queued'});if(!entry)break;activeUploads+=1;processUpload(entry)}
if(!activeUploads){setUploadBusy(false);renderUploads();if(entries.length&&entries.every(function(e){return e.state==='succeeded'}))location.replace(form.getAttribute('data-success-url')||'/s/capture')}
else renderUploads()}
inputs.forEach(function(input){input.addEventListener('change',function(){var files=Array.prototype.slice.call(input.files||[]);input.value='';if(!files.length||busy)return;
if(form.hasAttribute('data-work-upload')&&!form.hasAttribute('data-batch-work')){entries=[];if(uploadList)uploadList.textContent='';files=files.slice(0,1)}
form.setAttribute('data-upload-pending','');setUploadBusy(true);files.forEach(function(file){var entry={file:file,name:file.name||'照片',key:uuid(),blob:null,state:'queued',progress:0,message:'等待上传',retryable:false};appendUploadRow(entry);entries.push(entry)});pumpUploads()})});
document.addEventListener('click',function(e){var label=e.target&&e.target.closest&&e.target.closest('label[for="camera-input"],label[for="library-input"]');if(busy&&label&&label.control&&label.control.form===form)e.preventDefault()});
form.addEventListener('submit',function(e){e.preventDefault()});
if(retry)retry.addEventListener('click',function(){if(busy)return;var failed=entries.filter(function(e){return e.state==='failed'&&e.retryable});if(!failed.length)return;
setUploadBusy(true);failed.forEach(function(entry){entry.state='queued';entry.progress=0;entry.message='等待上传'});pumpUploads()})}
`;
