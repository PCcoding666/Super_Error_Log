import type { ReactNode } from 'react';
import type { TaskLifecycle } from '../../v2/practiceTasks.js';
import { weekRangeText } from '../format.js';
import { Page } from './layout.js';

/** Fields the dashboard actually renders. Legacy practice cards and learning cards both satisfy this. */
interface DashboardItem { id: string; subject?: string | null; knowledgeTags: string[]; reason: string }
interface DashboardPractice { id: string; week: string; items: DashboardItem[] }
interface DashboardRecommendation { recommended: DashboardItem[]; others?: DashboardItem[]; notes?: string[]; limits?: { min: number; max: number } }

export interface DashboardTask {
  practice: DashboardPractice;
  lifecycle: TaskLifecycle;
  recorded: number;
  received: number;
  reviewStatus?: string;
}
function TaskActions({task}: {task:DashboardTask}): ReactNode {
  const url=`/s/practice/${task.practice.id}`;
  return <div className="practice-task-actions">
    {task.received>0?<><a className="btn primary" href={`${url}/feedback`}>{task.reviewStatus==='ready'?'查看待确认结果':'查看提交进度'}</a><a className="btn" href={`${url}/submit`}>补拍作答</a><a className="more" href={url}>查看题目</a></>:<><a className="btn primary" href={url}>查看题目</a><a className="btn" href={`${url}/submit`}>拍照交练习</a>{task.recorded>0?<a className="more" href={`${url}/feedback`}>查看反馈</a>:null}</>}
  </div>;
}
export function PracticeDashboardPage(props: {tasks:DashboardTask[]; activeId:string|null; recommendation:DashboardRecommendation; requestKey:string; error?:string}): ReactNode {
  const active=props.tasks.find(task=>task.practice.id===props.activeId);
  const history=props.tasks.filter(task=>task!==active);
  const cards=props.recommendation.recommended;
  return <Page title="练习" tab="practices" flash={{err:props.error}}>
    <h1>练习</h1>
    {active ? <section className="card" data-testid="practice-latest">
      <p className="eyebrow">这次的练习</p>
      <h2>{active.practice.items.length} 道题 · 在纸上完成</h2>
      <p>在白纸上写出题号和过程，做完后拍照交到这里。</p>
      <p className="muted">{active.recorded ? `已记录 ${active.recorded} 道结果，还剩 ${active.practice.items.length-active.recorded} 道` : active.received ? `已收到 ${active.received} 张作答照片` : '还没有收到作答，做完后随时可以提交。'}</p>
      <TaskActions task={active}/>
      <details><summary>查看这几道题与推荐理由</summary>
        <ul className="list" data-testid="practice-latest-items">{active.practice.items.map((item,index)=><li className="row qrow" key={item.id}>
          <span className="row-text"><b>第 {index+1} 题 · {item.subject??'练习'}</b><span className="meta-line">{item.knowledgeTags[0]??'复习已收录的错题'}</span><span className="meta-line muted">为什么练：{item.reason}</span></span>
        </li>)}</ul>
      </details>
      <details><summary>调整这次练习</summary><div className="practice-task-actions">
        <form method="post" action={`/s/practice/${active.practice.id}/pause`}><button className="btn">稍后再做</button></form>
        <form method="post" action={`/s/practice/${active.practice.id}/cancel`}><input type="hidden" name="next" value="choose"/><button className="btn">换一组题</button></form>
        <form method="post" action={`/s/practice/${active.practice.id}/cancel`}><button className="link-btn">取消剩余练习</button></form>
      </div><p className="hint">换题或取消会保留已记录的结果，剩余题以后仍可安排。</p></details>
    </section> : cards.length ? <section className="card" data-testid="practice-recommendation">
      <p className="eyebrow">为你准备的建议</p><h2>这次建议练 {cards.length} 道</h2>
      <p>先练一小组，在白纸上完成；需要时也可以打印。</p>
      <ul className="list">{cards.map((item,index)=><li className="row" key={item.id}><span className="row-text">
        <b>第 {index+1} 题 · {item.subject??'练习'} · {item.knowledgeTags[0]??'错题重做'}</b><span className="meta-line muted">为什么练：{item.reason}</span>
      </span></li>)}</ul>
      <form method="post" action="/s/practices/start" data-wait="正在准备这次练习…"><input type="hidden" name="key" value={props.requestKey}/><button className="btn primary" type="submit">就练这 {cards.length} 道</button></form>
      <a className="more" href="/s/choose">调整题目和题量</a>
    </section> : <section className="card"><h2>现在没有需要新增的练习</h2><p>可以继续下面暂缓的任务，或到错题本选题。到了复习时间，这里会给你建议。</p><a className="btn" href="/s/">查看错题本</a><a className="more" href="/s/capture">录入新错题</a></section>}
    <a className="more" href="/s/choose">自己选题</a>
    {history.length>0?<details className="card" data-testid="practice-history"><summary>练习记录（{history.length}）</summary>
      <ul className="list">{history.map(task=><li className="row" key={task.practice.id}><span className="row-text">
        <a data-testid="practice-row" href={`/s/practice/${task.practice.id}${task.recorded>=task.practice.items.length?'/feedback':''}`}><b>{weekRangeText(task.practice.week,'short')} · {task.practice.items.length} 道</b></a>
        <span className="meta-line muted">{task.lifecycle==='cancelled'?'已取消剩余练习':task.lifecycle==='paused'?'已暂缓':task.recorded>=task.practice.items.length?'结果已记录':`已记录 ${task.recorded} 道结果，还有 ${task.practice.items.length-task.recorded} 道待处理`}</span>
        {task.lifecycle==='paused'?<form method="post" action={`/s/practice/${task.practice.id}/resume`}><button className="link-btn">继续这份练习</button></form>:null}
      </span></li>)}</ul>
    </details>:null}
  </Page>;
}
