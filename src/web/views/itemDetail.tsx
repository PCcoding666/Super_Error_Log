import type { ReactNode } from 'react';
import { MASTERY_FEELING_LABEL } from '../../domain/types.js';
import type { V2WeekItem } from '../../v2/weekService.js';
import type { EvidenceView } from '../../v2/correctionService.js';
import type { ReflectionView } from '../../v2/reflectionService.js';
import { attemptLabel, itemNotebookReturn, itemContextUrl, type ItemPracticeRecord } from '../itemLearning.js';
import { localDayText } from '../weekPlan.js';
import { Page, Problem, quoted, type BarModel } from './layout.js';

const KIND_TITLE: Record<string, string> = { student_work: '你写的', correction: '订正', teacher_note: '老师批注', reference_answer: '参考答案', unknown: '其他笔迹' };

export interface ItemDetailProps {
  item: V2WeekItem;
  evidence: EvidenceView | null;
  canDiscard: boolean;
  /** Retained for old callers; a boolean alone is not a confirmed reflection. */
  reflected: boolean;
  reflection?: ReflectionView | null;
  practiceHistory?: ItemPracticeRecord[];
  eligible?: boolean;
  resumePracticeId?: string | null;
  reflectionPracticeId?: string | null;
  returnTo?: string;
  /** Confirmation event dates follow the page timezone; old callers use the process timezone. */
  timeZone?: string;
  error?: string | null;
}

export function ItemDetailPage(props: ItemDetailProps): ReactNode {
  const {item,evidence,reflection} = props;
  const returnTo = itemNotebookReturn(props.returnTo,item);
  const eligible = props.eligible ?? ['ready_for_reflection','eligible_for_review','attempted','needs_recheck'].includes(item.status);
  const unavailable = item.status === 'temporarily_mastered' ? '尚未到复习时间，先看看以前的订正和练习记录。' : '这道题当前不能新建练习，可以先阅读题目或返回错题本。';
  const bar: BarModel = {
    caption: props.resumePracticeId ? '接着上次的练习，可以在线做，也可以打印。' : eligible ? '可以在线做，也可以打印；隔几天独立做对才计入掌握。' : unavailable,
    primary: props.resumePracticeId
      ? {title:'继续练习',key:'resume',href:`/s/practice/${props.resumePracticeId}?item=${item.id}`}
      : eligible ? {title:'重做这题',key:'redo',post:`/s/items/${item.id}/practice`,fields:{returnTo}}
        : {title:'返回错题本',key:'goHome',href:returnTo},
    secondary: [],
  };
  const groups = Object.entries(KIND_TITLE).map(([kind,title]) => ({title,notes:(evidence?.observations ?? []).filter(note => note.kind === kind)})).filter(group => group.notes.length);
  return <Page title={item.shortId ?? '题目'} bodyClass="item-learning" back={{href:returnTo,label:'错题本'}} bar={bar}>
    <p className="eyebrow">单题学习{item.shortId ? ' · 练习纸编号' : ''}</p>
    <h1>{item.shortId ?? '题目'}</h1>
    <p className="small muted" data-testid="item-category">{[item.grade,item.subject,item.chapter].filter(Boolean).join(' · ')}</p>
    {props.error ? <Problem title="暂时不能开始" detail={props.error} /> : null}
    <a href={`/s/img/item/${item.id}?scope=full`} target="_blank" rel="noreferrer" className="photo-link learning-photo" data-key="item-full-photo" aria-label="打开整题原图（新窗口）"><img className="crop big" src={`/s/img/item/${item.id}?scope=full&s=big`} alt="整题照片" /></a>
    <p className="hint">整题照片 · 点开查看原图并放大；照片未显示时可阅读下面的题目。</p>
    <section className="card" aria-labelledby="learning-question">
      <h2 id="learning-question" className="card-title">题目</h2>
      <p className="pre" data-testid="question-text">{evidence?.questionText || item.questionExcerpt || '还没有可读的识别文字，请打开上方原图查看。'}</p>
      <p className="small muted">识别文字仅供对照，以照片为准。</p>
      {evidence?.badge === 'low' ? <p className="tone-orange" data-testid="low-hint">{quoted('字可能认错了：对照上面的照片看一眼，不对就点「改一下」。')}</p> : null}
      {item.knowledgeTags.length ? <p className="small muted">细知识点：{item.knowledgeTags.join('、')}</p> : null}
    </section>
    {groups.length ? <section className="card learning-evidence" aria-label="原作答与订正">{groups.map(group => <details key={group.title}><summary>{group.title}</summary>{group.notes.map(note => <p key={note.id} className="pre">{note.text}</p>)}</details>)}</section> : null}
    <section className="card" aria-labelledby="learning-reflection" data-testid="item-reflection">
      <h2 id="learning-reflection" className="card-title">我的错因与提醒</h2>
      {reflection ? <>
        <p className="small muted">我确认的记录 · <time dateTime={reflection.createdAt}>{localDayText(new Date(reflection.createdAt),props.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)}</time></p>
        {reflection.summary ? <p className="pre reflection-summary">{reflection.summary}</p> : <p className="muted">这次没有填写文字提醒。</p>}
        <dl className="learning-reflection"><dt>当时怎么了</dt><dd>{reflection.attemptState}</dd><dt>错在哪</dt><dd>{reflection.cause}</dd><dt>当时的把握</dt><dd>{MASTERY_FEELING_LABEL[reflection.masteryFeeling]}</dd></dl>
      </> : <p className="muted">还没有已确认的错因记录。可以先重做，之后再记下自己的发现。</p>}
      {props.reflectionPracticeId ? <a className="more" href={`/s/why/${props.reflectionPracticeId}/${item.id}`}>{reflection ? '回看或补充错因' : '记下我的错因（可选）'}</a> : null}
    </section>
    <section className="card" aria-labelledby="learning-history" data-testid="item-practice-history">
      <h2 id="learning-history" className="card-title">练习记录</h2>
      {props.practiceHistory?.length ? <><p className="small muted">最近的在前 · 日期是你记录的实际作答日</p><ol className="list learning-history">{props.practiceHistory.map(record => <li key={record.id}><a className="row" href={`/s/practice/${record.id}?item=${item.id}${record.correct === null ? '' : '&view=check'}`}><span className="row-text"><span>{attemptLabel(record)}</span><span className="meta-line muted">{record.performed_at ? <time dateTime={record.performed_at}>{record.performed_at}</time> : '尚未记录作答日期'} · {record.correct === null ? '继续练习' : '查看作答'}</span></span><span className="chev" aria-hidden="true">›</span></a></li>)}</ol></> : <p className="muted">还没有练习记录。重做后，实际结果会留在这里。</p>}
    </section>
    <details className="card learning-management"><summary>题目信息与管理</summary>
      {evidence ? <a className="more" href={itemContextUrl(item,returnTo,'/fix')} data-key="fix">字认错了？改一下</a> : null}
      <a className="more" href={itemContextUrl(item,returnTo,'/category')}>修改分类</a>
      {props.canDiscard ? <form method="post" action={`/s/items/${item.id}/discard`}><input type="hidden" name="returnTo" value={returnTo} /><button className="link-btn" type="submit" data-testid="next-step-secondary-discard" data-key="discard">这不是错题</button></form> : null}
    </details>
  </Page>;
}
