/** 可复用的只读 Sheet 增强。无请求、无存储；无脚本时保留原生 details。 */
export const UI_SHEET_SCRIPT = String.raw`(function(){
function enhanceWeekSheets(){
if(!window.HTMLDialogElement||!HTMLDialogElement.prototype.showModal)return;
document.querySelectorAll('[data-week-sheet]').forEach(function(details){
var opener=details.querySelector('summary'),content=details.querySelector('[data-sheet-content]');
if(!opener||!content||details.hasAttribute('data-sheet-ready'))return;
details.setAttribute('data-sheet-ready','');
opener.setAttribute('aria-haspopup','dialog');opener.setAttribute('aria-expanded','false');
var dialog=document.createElement('dialog');dialog.className='week-sheet';dialog.setAttribute('aria-labelledby','week-plan-title');dialog.setAttribute('data-testid','week-plan-sheet');
var toolbar=document.createElement('div');toolbar.className='sheet-toolbar';
var handle=document.createElement('button');handle.type='button';handle.className='sheet-grabber';handle.setAttribute('aria-label','下拉收起本周安排');handle.innerHTML='<span aria-hidden="true"></span>';
var close=document.createElement('button');close.type='button';close.className='sheet-close';close.textContent='关闭';close.setAttribute('aria-label','关闭本周安排');close.setAttribute('data-testid','week-plan-close');
toolbar.appendChild(handle);toolbar.appendChild(close);dialog.appendChild(toolbar);
var closing=false,frame=0,finishTimer=0;
var historyId='week-'+Math.random().toString(36).slice(2),previousState=null;
function ownsEntry(){return history.state&&history.state.__selWeekSheet===historyId}
function onHistory(){if(dialog.open)hide()}
function onPageHide(){if(ownsEntry())history.replaceState(previousState,'');restore(false)}
function restore(focus){window.removeEventListener('popstate',onHistory);window.removeEventListener('pagehide',onPageHide);cancelAnimationFrame(frame);clearTimeout(finishTimer);dialog.classList.remove('sheet-visible','sheet-dragging');dialog.style.removeProperty('--sheet-drag');if(dialog.open)dialog.close();details.appendChild(content);details.open=false;opener.setAttribute('aria-expanded','false');document.body.classList.remove('sheet-is-open');dialog.remove();closing=false;if(focus!==false&&opener.isConnected)opener.focus({preventScroll:true})}
function hide(){closing=true;cancelAnimationFrame(frame);dialog.classList.remove('sheet-visible');if(window.matchMedia('(prefers-reduced-motion: reduce)').matches||document.documentElement.classList.contains('demo-reduce-motion'))restore();else finishTimer=setTimeout(restore,180)}
/* 仅弹层打开期间接管一次返回。显式关闭也退回原历史项，避免下次返回停在重复页面。 */
function dismiss(){if(!dialog.open||closing)return;if(ownsEntry()){closing=true;history.replaceState(previousState,'');history.back()}else hide()}
opener.addEventListener('click',function(e){e.preventDefault();if(dialog.open)return;details.open=false;closing=false;dialog.appendChild(content);document.body.appendChild(dialog);opener.setAttribute('aria-expanded','true');document.body.classList.add('sheet-is-open');dialog.showModal();
/* 前进到已收起的弹层历史项后再次打开时，复用该项，不继续堆叠。 */
if(!ownsEntry()){previousState=history.state;try{history.pushState(Object.assign({},previousState,{__selWeekSheet:historyId}),'')}catch(error){}}
window.addEventListener('popstate',onHistory);window.addEventListener('pagehide',onPageHide);
close.focus({preventScroll:true});frame=requestAnimationFrame(function(){dialog.classList.add('sheet-visible')})});
close.addEventListener('click',dismiss);handle.addEventListener('click',function(e){if(dragged&&e.detail!==0){dragged=false;return}dismiss()});
dialog.addEventListener('cancel',function(e){e.preventDefault();dismiss()});
dialog.addEventListener('keydown',function(e){if(e.key!=='Tab')return;var focusable=Array.prototype.filter.call(dialog.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'),function(el){return el.getClientRects().length>0}),first=focusable[0],last=focusable[focusable.length-1];if(!first)return;if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}});
dialog.addEventListener('click',function(e){if(e.target!==dialog)return;var rect=dialog.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)dismiss()});
dialog.addEventListener('close',function(){if(!dialog.open&&content.parentNode===dialog)restore()});
var startY=null,delta=0,dragged=false;
handle.addEventListener('pointerdown',function(e){if(e.button!==0)return;startY=e.clientY;delta=0;dragged=false;handle.setPointerCapture(e.pointerId);dialog.classList.add('sheet-dragging')});
handle.addEventListener('pointermove',function(e){if(startY===null)return;delta=Math.max(0,e.clientY-startY);if(Math.abs(e.clientY-startY)>6)dragged=true;dialog.style.setProperty('--sheet-drag',delta+'px')});
function finishDrag(){if(startY===null)return;startY=null;dialog.classList.remove('sheet-dragging');if(delta>60)dismiss();else dialog.style.removeProperty('--sheet-drag')}
handle.addEventListener('pointerup',finishDrag);handle.addEventListener('pointercancel',function(){startY=null;delta=0;dialog.classList.remove('sheet-dragging');dialog.style.removeProperty('--sheet-drag')});
});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',enhanceWeekSheets);else enhanceWeekSheets();
})();`;
