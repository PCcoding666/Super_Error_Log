import type { ReactNode } from 'react';
import type { TaskLifecycle } from '../../v2/practiceTasks.js';
import { weekRangeText } from '../format.js';
import { Page } from './layout.js';
import { monthDayText } from '../../domain/calendarDay.js';
import type { RedoOverviewView } from './redoDate.js';

/** Fields the dashboard actually renders. Legacy practice cards and learning cards both satisfy this. */
interface DashboardItem { id: string; subject?: string | null; knowledgeTags: string[]; reason: string; questionExcerpt?: string | null; chapter?: string | null; shortId?: string | null }
interface DashboardPractice { id: string; week: string; items: DashboardItem[] }
interface DashboardRecommendation { recommended: DashboardItem[]; others?: DashboardItem[]; notes?: string[]; limits?: { min: number; max: number }; redo?: RedoOverviewView; dueTotal?: number }

/** 「约 N 分钟」的估算：每道题大约几分钟。 */
const MINUTES_PER_ITEM = 3;

export interface DashboardTask {
  practice: DashboardPractice;
  lifecycle: TaskLifecycle;
  recorded: number;
  received: number;
  reviewStatus?: string;
}
function TaskActions({task}: {task:DashboardTask}): ReactNode {
  const url=`/s/practice/${task.practice.id}`;
  if (task.received>0) return <div className="practice-task-actions">
    <a className="btn primary" href={`${url}/feedback`}>{task.reviewStatus==='ready'?'查看待确认结果':'查看提交进度'}</a><a className="btn" href={`${url}/submit`}>补拍作答</a><a className="more" href={url}>查看题目</a>
  </div>;
  return <div className="practice-task-actions">
    <a className="btn primary" href={url}>{task.recorded>0?'继续':'开始做'}</a>
    <a className="btn" href={`${url}?mode=paper&view=check`}>在纸上做完了，记录结果</a>
    <a className="more" href={`${url}/submit`}>拍照交给 AI 核对</a>
    {task.recorded>0?<a className="more" href={`${url}/feedback`}>查看反馈</a>:null}
  </div>;
}
function QueueRow({item}: {item:DashboardItem}): ReactNode {
  return <li className="notebook-entry"><a className="row notebook-card" href={`/s/items/${item.id}`}>
    <span className="notebook-line">
      <img className="notebook-thumb" src={`/s/img/item/${item.id}?s=thumb`} alt="" loading="lazy" />
      <span className="row-text">
        <span className="excerpt">{item.questionExcerpt || item.knowledgeTags[0] || '错题重做'}</span>
        <span className="meta-line muted">{[item.knowledgeTags[0] || item.chapter, item.subject].filter(Boolean).join(' · ') || '练习'}</span>
        <span className="meta-line muted">为什么练：{item.reason}</span>
      </span>
      <span className="chev" aria-hidden="true">›</span>
    </span>
  </a></li>;
}
export function PracticeDashboardPage(props: {tasks:DashboardTask[]; activeId:string|null; recommendation:DashboardRecommendation; requestKey:string; error?:string}): ReactNode {
  const active=props.tasks.find(task=>task.practice.id===props.activeId);
  const history=props.tasks.filter(task=>task!==active);
  const cards=props.recommendation.recommended;
  const redo=props.recommendation.redo;
  const later=(props.recommendation.dueTotal??cards.length)-cards.length;
  return <Page title="练习" tab="practices" flash={{err:props.error}}>
    <h1>练习</h1>
    {active ? <section className="card" data-testid="practice-latest">
      <p className="eyebrow">这次的练习</p>
      <h2>{active.recorded ? `还剩 ${active.practice.items.length-active.recorded} 道` : `${active.practice.items.length} 道题`}</h2>
      <p>一次一道：在草稿纸上写过程，做完对答案，点「做对了」或「做错了」就记下了。</p>
      <p className="muted">{active.recorded ? `已记录 ${active.recorded} 道结果` : active.received ? `已收到 ${active.received} 张作答照片` : '还没有记录结果。'}</p>
      <TaskActions task={active}/>
      <details><summary>查看这几道题与推荐理由</summary>
        <ul className="list" data-testid="practice-latest-items">{active.practice.items.map((item,index)=><li className="row qrow" key={item.id}>
          <span className="row-text"><b>第 {index+1} 题 · {item.questionExcerpt || item.subject || '练习'}</b><span className="meta-line">{item.knowledgeTags[0]??'复习已收录的错题'}</span><span className="meta-line muted">为什么练：{item.reason}</span></span>
        </li>)}</ul>
      </details>
      <details><summary>调整这次练习</summary><div className="practice-task-actions">
        <form method="post" action={`/s/practice/${active.practice.id}/pause`}><button className="btn">稍后再做</button></form>
        <form method="post" action={`/s/practice/${active.practice.id}/cancel`}><input type="hidden" name="next" value="choose"/><button className="btn">换一组题</button></form>
        <form method="post" action={`/s/practice/${active.practice.id}/cancel`}><button className="link-btn">取消剩余练习</button></form>
      </div><p className="hint">换题或取消会保留已记录的结果，剩余题以后仍可安排。</p></details>
    </section> : cards.length ? <section data-testid="practice-recommendation">
      <p className="lead">每天做到期的几道。一次一道，做完马上对答案。</p>
      <h2 className="group-label">今天该做 {cards.length} 道 · 约 {cards.length*MINUTES_PER_ITEM} 分钟</h2>
      <ul className="inset-group notebook-list">{cards.map(item=><QueueRow key={item.id} item={item}/>)}</ul>
      <p className="group-footer">这几道都隔了几天，今天独立做对就算数。{later>0?`另有 ${later} 道也到期了，明天接着排。`:''}</p>
      <a className="practice-adjust" href="/s/choose">调整题目和题量<span className="chev" aria-hidden="true">›</span></a>
      <form className="practice-cta" method="post" action="/s/practices/start" data-wait="正在准备这次练习…"><input type="hidden" name="key" value={props.requestKey}/><button className="btn primary" type="submit">开始做这 {cards.length} 道</button></form>
    </section> : redo?.nextDay ? <section className="card" data-testid="redo-wait">
      <h2>今天没有到期的题</h2>
      <p>下一批：{monthDayText(redo.nextDay)}，{redo.nextCount} 道。隔几天再做，才知道是不是真会了；到那天这里会排给你。</p>
      <p className="muted">刚收的错题，今天可以先看看错在哪。</p>
      <a className="btn" href="/s/">查看错题本</a><a className="more" href="/s/choose">想提前练，自己选题</a>
    </section> : <section className="card"><h2>现在没有需要新增的练习</h2><p>可以继续下面暂缓的任务，或到错题本选题。到了该再做的日子，这里会排给你。</p><a className="btn" href="/s/">查看错题本</a><a className="more" href="/s/capture">录入新错题</a></section>}
    {active || (!cards.length && !redo?.nextDay) ? <a className="more" href="/s/choose">自己选题</a> : null}
    {history.length>0?<details className="card" data-testid="practice-history"><summary>练习记录（{history.length}）</summary>
      <ul className="list">{history.map(task=><li className="row" key={task.practice.id}><span className="row-text">
        <a data-testid="practice-row" href={`/s/practice/${task.practice.id}${task.recorded>=task.practice.items.length?'/feedback':''}`}><b>{weekRangeText(task.practice.week,'short')} · {task.practice.items.length} 道</b></a>
        <span className="meta-line muted">{task.lifecycle==='cancelled'?'已取消剩余练习':task.lifecycle==='paused'?'已暂缓':task.recorded>=task.practice.items.length?'结果已记录':`已记录 ${task.recorded} 道结果，还有 ${task.practice.items.length-task.recorded} 道待处理`}</span>
        {task.lifecycle==='paused'?<form method="post" action={`/s/practice/${task.practice.id}/resume`}><button className="link-btn">继续这份练习</button></form>:null}
      </span></li>)}</ul>
    </details>:null}
  </Page>;
}
