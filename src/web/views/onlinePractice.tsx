import crypto from 'node:crypto';
import type { PracticeWork } from '../../v2/practiceWork.js';
import type { ReactNode } from 'react';
import type { LearningPracticeDetail as PracticeDetail } from '../../learning/contracts.js';
import type { PrintSnapshot } from '../../v2/printService.js';
import type { PracticeProgress } from '../../v2/practiceProgress.js';
import { Page } from './layout.js';
import type { TaskLifecycle } from '../../v2/practiceTasks.js';
import { AnswerText } from './answerText.js';

export function OnlinePracticePage(props: { practice: PracticeDetail; lifecycle?:TaskLifecycle; progress: PracticeProgress; snapshot?: PrintSnapshot; state: string; itemId?: string; view?: string; paper?: boolean; today: string; earliestDay: string; works?: Record<string, PracticeWork | null>; error?: string }): ReactNode {
  const { practice: p, progress, snapshot } = props;
  const base = `/s/practice/${p.id}`;
  const pending = p.items.filter(item => !progress.answers[item.id]);
  const current = p.items.find(item => item.id === props.itemId) ?? pending.find(item => item.id === progress.cursor) ?? pending[0];
  const card = current && snapshot?.items.find(item => item.itemId === current.id);
  const index = current ? p.items.findIndex(item => item.id === current.id) : -1;
  const answer = snapshot?.answerSheet[index];
  const saved = current && progress.answers[current.id];
  const work = current && props.works?.[current.id];
  const done = props.view === 'done' || props.view === 'upload';
  const checking = props.view === 'check' || !!saved;
  const hint = current ? progress.hints[current.id] ?? 0 : 0;
  const paperQuery = props.paper ? '&mode=paper&view=check' : '';
  const itemUrl = current ? `${base}/${current.id}` : base;
  const media = (name: string) => `/s/img/print/${p.id}/${name}`;
  const recorded=Object.keys(progress.answers).length;
  if(props.lifecycle==='cancelled')return <Page title="已取消的练习" back={{href:'/s/practices',label:'练习'}}>
    <h1>这份练习已取消</h1><section className="card"><p>已记录的 {recorded} 道结果仍然保留，剩余题可以重新安排。</p><a className="btn" href={`${base}/feedback`}>查看已有反馈</a><a className="more" href="/s/practices">返回练习</a></section>
  </Page>;
  return <Page title="练习" back={{ href: '/s/practices', label: '练习' }} flash={{ err: props.error }} pollSeconds={props.state === 'preparing' ? 2 : undefined}>
    <div data-live="practice">
    <div className="practice-heading"><h1>练习 · {p.items.length} 道题</h1><a className="btn" href={`/s/print/${p.id}`}>打印练习</a></div>
    <p className="lead">在白纸上写题号和过程，做完后拍照交到这里。</p>
    <p className="muted" data-testid="practice-progress">{recorded?`已记录 ${recorded} 道结果，共 ${p.items.length} 道`:'还没有记录作答结果'}</p>
    <div className="practice-task-actions"><a className="btn primary" href={`${base}/submit`}>拍照交练习</a>{recorded>0?<a className="btn" href={`${base}/feedback`}>查看反馈</a>:null}</div>
    {!snapshot ? <section className="card"><p>{props.state === 'failed' ? '题目暂未准备好，请重试。' : '正在准备题目和答案…'}</p><form method="post" action={`${base}/prepare`}><button className="btn" type="submit">{props.state === 'failed' ? '重新准备' : '查看准备进度'}</button></form><a href="/s/practices">返回练习列表</a></section> : <>
      <nav className="choices-inline" aria-label="练习题目">{p.items.map((item, i) => <a key={item.id} className="btn" aria-current={current?.id === item.id ? 'page' : undefined} href={`${base}?item=${item.id}${paperQuery}`}>{i + 1}{progress.answers[item.id] ? ' ✓' : ''}</a>)}</nav>
      {current && card ? <>
        <section className="card" data-testid="practice-question" data-item={current.id}>
          <h2>第 {index + 1} 题</h2>
          {card.stemText ? <AnswerText text={card.stemText}/> : null}
          {card.cropMedia ? <img className="crop big" src={media(card.cropMedia)} alt="题目截图" /> : null}
          {card.diagramMedia.map(name => <img key={name} className="crop big" src={media(name)} alt="题目图示" />)}
          {card.needsGlance ? <p className="tone-orange">这道题识别不确定，请对照原卷确认题目；截图可能残留笔迹。</p> : null}
        </section>
        {hint > 0 ? <section className="card"><p>{answer?.hint1 ?? '这道题暂无提示'}</p>{hint > 1 ? <p>{answer?.hint2 ?? '暂无进一步提示'}</p> : null}</section> : null}
        {!checking ? <>
          {hint < 2 ? <form method="post" action={`${itemUrl}/hint`}><input type="hidden" name="level" value={hint + 1} /><button className="btn" type="submit">{hint === 0 ? '查看提示' : '再看一步'}</button></form> : null}
          {done ? <section className="card">
            <h2>{props.view === 'upload' ? '上传手写作答' : '核对作答'}</h2>
            {props.view !== 'upload' ? <a className="btn primary" href={`${base}?item=${current.id}&view=upload`}>拍照上传作答</a> : null}
            <p><a className="btn" href={`${base}?item=${current.id}&view=check`}>不上传，直接核对</a></p>
            {props.view === 'upload' ? <form method="post" action={`${itemUrl}/work`} encType="multipart/form-data" data-upload="" data-work-upload="" data-success-url={`${base}?item=${current.id}&view=check`}>
              <input type="hidden" name="key" value={crypto.randomUUID()} />
              <label className="btn" htmlFor="camera-input">拍照</label> <input className="visually-hidden" id="camera-input" name="photo" type="file" accept="image/*" capture="environment" />
              <label className="btn" htmlFor="library-input">从相册选择</label> <input className="visually-hidden" id="library-input" name="photo" type="file" accept="image/*" />
              <p className="hint">拍下这道题的手写过程。上传后识别文字，由你核对对错。</p>
              <ul data-upload-list="" /><div className="hidden" data-upload-progress=""><div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100}><i /></div></div>
              <p data-upload-message="" aria-live="polite" /><button type="button" className="btn hidden" data-upload-retry="">再试一次</button>
              <noscript><button className="btn" type="submit">上传这张</button></noscript>
            </form> : null}
          </section> : <p><a className="more" href={`${base}?item=${current.id}&view=done`}>这道做完了，自己核对</a></p>}
          <form method="post" action={`${itemUrl}/skip`}><button className="link-btn" type="submit">跳过，之后再做</button></form>
        </> : <section className="card" data-testid="practice-answer">
          {work ? <section><h2>手写作答</h2><img className="crop big" src={`${itemUrl}/work/${work.id}/image`} alt="本次手写作答" />
            {work.status === 'ready' ? <><p className="pre">{work.text}</p>{work.uncertain ? <p className="tone-orange">部分字迹不确定，请对照照片核对。</p> : null}</> : <><p>照片已保存，文字尚未识别成功。可以直接核对。</p>{work.attempts < 3 ? <form method="post" action={`${itemUrl}/work/retry`}><button className="btn" type="submit">重新识别</button></form> : null}</>}
            {!saved ? <a className="btn" href={`${base}?item=${current.id}&view=upload`}>重拍作答</a> : null}
          </section> : null}
          <h2>{props.paper ? '记录纸上练习结果' : '答案与解析'}</h2><AnswerText text={answer?.answer.text ?? '暂无参考答案，请对照原卷核对。'}/>
          {answer?.answer.label ? <p className="hint">{answer.answer.label}</p> : null}
          {saved ? <p>已记录：{saved.correct ? '做对了' : '做错了'} · {saved.performed_at}</p> : <form method="post" action={`${itemUrl}/result`}>
            <input type="hidden" name="mode" value={props.paper ? "paper" : "online"} /><label>做题日期 <input type="date" name="performedOn" defaultValue={props.today} min={props.earliestDay} max={props.today} required /></label>
            <label className="choice"><input type="checkbox" name="usedHint" value="yes" defaultChecked={hint > 0} />用过提示或参考帮助</label>
            <p><button className="btn primary" name="correct" value="yes" type="submit">做对了</button> <button className="btn" name="correct" value="no" type="submit">做错了</button></p>
          </form>}
        </section>}
      </> : <section className="card"><h2>本次结果已记录</h2><p>可以查看这次的反馈，或点上面的题号回看。</p><a className="btn primary" href={`${base}/feedback`}>查看这次反馈</a><a className="more" href="/s/practices">返回练习建议</a></section>}
    </>}
    </div>
  </Page>;
}
