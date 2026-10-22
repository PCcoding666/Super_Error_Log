import crypto from 'node:crypto';
import type { ReactNode } from 'react';
import type { PracticeDetail } from '../../v2/practiceService.js';
import type { SubmissionState } from '../../v2/practiceSubmission.js';
import type { PracticeProgress } from '../../v2/practiceProgress.js';
import type { ReturnSummary } from '../../v2/returnService.js';
import { Page } from './layout.js';
import { AnswerText } from './answerText.js';
import { pendingRedoText, RedoDateCard } from './redoDate.js';

function Photos({base,state}:{base:string;state:SubmissionState}):ReactNode {
  return <div className="submission-photos">{state.photos.map((photo,i)=><figure key={photo.id}><a href={`${base}/submission/${photo.id}/image`} target="_blank" rel="noopener"><img src={`${base}/submission/${photo.id}/image`} alt={`作答照片 ${i+1}`} loading="lazy"/></a><figcaption>照片 {i+1} · 已保存</figcaption></figure>)}</div>;
}
export function PracticeSubmitPage({practice:p,state,cancelled,error}:{practice:PracticeDetail;state:SubmissionState;cancelled:boolean;error?:string}):ReactNode {
  const base=`/s/practice/${p.id}`;
  return <Page title="拍照交练习" back={{href:base,label:'题目'}} flash={{err:error}}>
    <h1>拍照交练习</h1><p className="lead">拍清题号和完整过程。一张可以拍多道题，一道题也可以分几张拍。</p>
    {cancelled?<p>这份练习已取消，已有照片和结果仍然保留。</p>:<section className="card">
      <h2>交这次的 {p.items.length} 道练习</h2><p>在纸上标明本次题号 1–{p.items.length}。只做了一部分也可以先交，之后回来补拍。</p>
      {state.photos.length<12?<form method="post" action={`${base}/submission`} encType="multipart/form-data" data-upload="" data-work-upload="" data-batch-work="" data-success-url={`${base}/submit`}>
        <input type="hidden" name="key" value={crypto.randomUUID()}/>
        <div className="practice-task-actions"><label className="btn primary" htmlFor="camera-input">拍照</label><label className="btn" htmlFor="library-input">从相册选择</label></div>
        <input className="visually-hidden" id="camera-input" name="photo" type="file" accept="image/*" capture="environment"/>
        <input className="visually-hidden" id="library-input" name="photo" type="file" accept="image/*"/>
        <p className="hint">选好后自动保存，可以继续拍下一页。本次最多保存 12 张。</p>
        <ul className="upload-list" data-upload-list=""/><div className="hidden" data-upload-progress=""><div className="progress" role="progressbar" aria-label="作答照片上传进度" aria-valuemin={0} aria-valuemax={100}><i/></div></div>
        <p data-upload-message="" aria-live="polite"/><button type="button" className="btn hidden" data-upload-retry="">重试未上传的照片</button>
        <a className="more hidden" data-upload-next="" href={`${base}/submit`}>查看已保存的照片</a>
        <noscript><button className="btn" type="submit">上传这张</button></noscript>
      </form>:<p>已保存 12 张照片，可以查看反馈；需要补充的题也可以自己核对。</p>}
    </section>}
    {state.photos.length>0?<section className="card"><h2>已保存 {state.photos.length} 张</h2><Photos base={base} state={state}/>
      {!cancelled && !['ready','analyzing'].includes(state.status) && state.attempts<3?<form method="post" action={`${base}/review`} data-wait="正在核对作答…"><button className="btn primary">照片交齐了，查看反馈</button></form>:<a className="btn primary" href={`${base}/feedback`}>查看反馈</a>}
      <p className="hint">照片保存成功后可以离开。核对建议需要你确认，才会记入结果。</p>
    </section>:null}
    <a className="more" href={`${base}?view=check`}>不方便拍照，自己核对并记录</a>
  </Page>;
}
export function PracticeFeedbackPage(props:{practice:PracticeDetail;state:SubmissionState;progress:PracticeProgress;summary:ReturnSummary|null;cancelled:boolean;today:string;earliestDay:string;legacyPhotos:number;error?:string;draft?:Record<string,unknown>}):ReactNode {
  const {practice:p,state,progress,summary,cancelled}=props,base=`/s/practice/${p.id}`;
  const recorded=Object.keys(progress.answers).length;
  const unresolved=state.findings.map((finding,index)=>({finding,index})).filter(({finding})=>!finding.itemId);
  const matched=new Map(state.findings.filter(f=>f.itemId).map(f=>[f.itemId!,f]));
  const value=(name:string,fallback:string)=>typeof props.draft?.[name]==='string'?props.draft[name] as string:fallback;
  const canConfirm=!cancelled&&state.status==='ready'&&recorded<p.items.length;
  return <Page title="练习反馈" back={{href:'/s/practices',label:'练习'}} flash={{err:props.error}} pollSeconds={state.status==='analyzing'&&!cancelled?2:undefined}>
    <div data-live="practice-feedback"><h1>这次的练习反馈</h1>
      <section className="card"><h2>{recorded?`已记录 ${recorded} 道结果`:state.photos.length?(state.status==='ready'?'作答反馈已准备好':state.status==='analyzing'?'正在核对作答':'作答照片已收到'):'等你交这次练习'}</h2>
        <p>{state.photos.length?`已收到 ${state.photos.length} 张作答照片。`:'还没有整份提交的作答照片。'}{recorded?`本次共 ${p.items.length} 道，还有 ${p.items.length-recorded} 道未记录。`:'还没有记录作答结果。'}</p>
        {recorded>0?<p>已确认做对 {Object.values(progress.answers).filter(a=>a.correct).length} 道，其中独立做对 {summary?.independentCorrect??0} 道。</p>:null}
        {summary?.pending.length?<p>当天做对的 {summary.pending.length} 道还不算掌握：{pendingRedoText(summary.pendingRedoOn,summary.pendingRedoLastOn)}</p>:null}
        {summary?.again.length?<p>有 {summary.again.length} 道还需要再练，之后会安排重做。</p>:null}
        {summary?.masteredNow.length?<p>已有 {summary.masteredNow.length} 道达到当前掌握判定。</p>:null}
        {cancelled?<p>剩余练习已取消，已有结果保留。</p>:<div className="practice-task-actions"><a className="btn" href={`${base}/submit`}>{state.photos.length?'补拍作答':'拍照交练习'}</a><a className="more" href={base}>回到题目</a></div>}
      </section>
      <RedoDateCard days={summary?.redoDays??[]}/>
      {!cancelled&&state.status==='analyzing'?<section className="card" role="status"><h2>照片已收到，正在核对</h2><p>可以先离开，下次从练习首页回来查看反馈。</p></section>:null}
      {!cancelled&&state.photos.length>0&&['pending','failed','interrupted'].includes(state.status)?<section className="card"><h2>{state.status==='pending'?'照片已保存，还没有核对反馈':'照片还在，这次没能完成核对'}</h2><p>可以重新核对，或对照参考答案自己记录结果。</p>{state.attempts<3?<form method="post" action={`${base}/review`}><button className="btn primary">{state.status==='pending'?'核对这些作答':'重新核对'}</button></form>:<p>这批照片已尝试 3 次，可以补拍更清晰的照片或自己核对。</p>}</section>:null}
      {state.photos.length>0?<details className="card"><summary>查看已保存的 {state.photos.length} 张照片</summary><Photos base={base} state={state}/></details>:null}
      {unresolved.map(({finding,index})=><section className="card" key={index}><h2>这段作答还没确定题号</h2><p>来自照片 {finding.photoNumbers.join('、')}。请指定本次练习的题号，或补拍带题号的过程。</p><AnswerText text={finding.text}/>
        {!cancelled?<form method="post" action={`${base}/assign`}><input type="hidden" name="revision" value={state.revision}/><input type="hidden" name="finding" value={index}/><label>对应题号 <select name="itemId" required defaultValue=""><option value="" disabled>请选择题号</option>{p.items.map((item,i)=><option key={item.id} value={item.id}>第 {i+1} 题{matched.has(item.id)?'（补充这道题）':''}</option>)}</select></label><button className="btn">关联这道题</button></form>:null}
      </section>)}
      <form method="post" action={canConfirm?`${base}/confirm`:undefined} id="submission-confirm">
        <input type="hidden" name="revision" value={state.revision}/>
        {canConfirm?<section className="card"><h2>待你确认</h2><p>下面是初步核对建议，可以直接修改。暂不确定的题留空，这次只记录你确认的结果。</p>
          <label>这次做题日期 <input type="date" name="performedOn" defaultValue={value('performedOn',props.today)} min={props.earliestDay} max={props.today} required/></label>
          <label>这次是否用过提示或参考帮助 <select name="help" defaultValue={value('help','')} required><option value="" disabled>请选择</option><option value="independent">独立完成，没有用帮助</option><option value="helped">用过提示、答案或他人帮助</option></select></label><p className="hint">只有个别题不同，可以在该题下面单独修改。</p>
        </section>:null}
        {p.items.map((item,i)=>{
          const saved=progress.answers[item.id],finding=matched.get(item.id);
          return <section className="card" key={item.id} data-testid="submission-question"><h2>第 {i+1} 题 · {item.knowledgeTags[0]??item.subject??'练习'}</h2>
            {saved?<p>已记录：{saved.correct?'做对了':'未做对'} · {saved.performed_at}</p>:<>
              <p>{finding?(finding.suggestedCorrect===null?'结果暂不确定':finding.suggestedCorrect?'初步核对：做对了':'初步核对：需要再看看'):'还没有收到这道题的可用作答。可以补拍，也可以自己核对。'}</p>
              {finding?<><p>{finding.feedback}</p><details><summary>查看识别过程（照片 {finding.photoNumbers.join('、')}）</summary><AnswerText text={finding.text}/></details></>:null}
              {canConfirm?<><label>确认结果 <select name={`outcome_${item.id}`} defaultValue={value(`outcome_${item.id}`,finding?.suggestedCorrect===true?'correct':finding?.suggestedCorrect===false?'incorrect':'')}><option value="">暂不记录</option><option value="correct">做对了</option><option value="incorrect">做错了</option><option value="not_solved">没做出来</option></select></label>
                <details><summary>这道题的日期或用帮助情况不同</summary><label>做题日期 <input type="date" name={`date_${item.id}`} defaultValue={value(`date_${item.id}`,'')} min={props.earliestDay} max={props.today}/></label><label>用帮助情况 <select name={`help_${item.id}`} defaultValue={value(`help_${item.id}`,'')}><option value="">与本次统一选择一致</option><option value="independent">独立完成</option><option value="helped">用过帮助</option></select></label></details>
              </>:null}
            </>}
            <a className="more" href={`${base}?item=${item.id}&view=check`}>{saved?'回看这道题':'查看参考答案，自己核对'}</a>
          </section>;
        })}
        {canConfirm?<button className="btn primary" type="submit">确认以上结果</button>:null}
      </form>
      {props.legacyPhotos>0?<p className="hint">之前逐题上传的作答仍在各题的核对页，点击上面的“自己核对”或“回看这道题”查看。</p>:null}
      <p><a className="btn" href="/s/practices">{recorded===p.items.length?'完成，回到练习建议':'返回练习首页'}</a></p>
    </div>
  </Page>;
}
