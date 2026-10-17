import type { ReactNode } from 'react';
import type { PracticeDetail } from '../../v2/practiceService.js';
import type { PrintSnapshot } from '../../v2/printService.js';
import type { PracticeProgress } from '../../v2/practiceProgress.js';
import { Page } from './layout.js';

export function OnlinePracticePage(props: { practice: PracticeDetail; progress: PracticeProgress; snapshot?: PrintSnapshot; state: string; itemId?: string; view?: string; paper?: boolean; today: string; error?: string }): ReactNode {
  const { practice: p, progress, snapshot } = props;
  const base = `/s/practice/${p.id}`;
  const pending = p.items.filter(item => !progress.answers[item.id]);
  const current = p.items.find(item => item.id === props.itemId) ?? pending.find(item => item.id === progress.cursor) ?? pending[0];
  const card = current && snapshot?.items.find(item => item.itemId === current.id);
  const index = current ? p.items.findIndex(item => item.id === current.id) : -1;
  const answer = snapshot?.answerSheet[index];
  const saved = current && progress.answers[current.id];
  const checking = props.view === 'check' || !!saved;
  const hint = current ? progress.hints[current.id] ?? 0 : 0;
  const itemUrl = current ? `${base}/${current.id}` : base;
  const media = (name: string) => `/s/img/print/${p.id}/${name}`;
  return <Page title="练习" back={{ href: '/s/practices', label: '练习' }} flash={{ err: props.error }} pollSeconds={props.state === 'preparing' ? 2 : undefined}>
    <div data-live="practice">
    <div className="practice-heading"><h1>练习 · {p.items.length} 道题</h1><a className="btn" href={`/s/print/${p.id}`}>打印练习</a></div>
    <p className="lead">已完成 {Object.keys(progress.answers).length} / {p.items.length}</p>
    {!snapshot ? <section className="card"><p>{props.state === 'failed' ? '题目暂未准备好，请重试。' : '正在准备题目和答案…'}</p><form method="post" action={`${base}/prepare`}><button className="btn" type="submit">{props.state === 'failed' ? '重新准备' : '查看准备进度'}</button></form><a href="/s/practices">返回练习列表</a></section> : <>
      <nav className="choices-inline" aria-label="练习题目">{p.items.map((item, i) => <a key={item.id} className="btn" aria-current={current?.id === item.id ? 'page' : undefined} href={`${base}?item=${item.id}`}>{i + 1}{progress.answers[item.id] ? ' ✓' : ''}</a>)}</nav>
      {current && card ? <>
        <section className="card" data-testid="practice-question" data-item={current.id}>
          <h2>第 {index + 1} 题</h2>
          {card.stemText ? <p className="pre">{card.stemText}</p> : null}
          {card.cropMedia ? <img className="crop big" src={media(card.cropMedia)} alt="题目截图" /> : null}
          {card.diagramMedia.map(name => <img key={name} className="crop big" src={media(name)} alt="题目图示" />)}
          {card.needsGlance ? <p className="tone-orange">这道题识别不确定，请对照原卷确认题目；截图可能残留笔迹。</p> : null}
        </section>
        {hint > 0 ? <section className="card"><p>{answer?.hint1 ?? '这道题暂无提示'}</p>{hint > 1 ? <p>{answer?.hint2 ?? '暂无进一步提示'}</p> : null}</section> : null}
        {!checking ? <>
          {hint < 2 ? <form method="post" action={`${itemUrl}/hint`}><input type="hidden" name="level" value={hint + 1} /><button className="btn" type="submit">{hint === 0 ? '查看提示' : '再看一步'}</button></form> : null}
          <p><a className="btn primary" href={`${base}?item=${current.id}&view=check`}>做完了</a></p>
          <form method="post" action={`${itemUrl}/skip`}><button className="link-btn" type="submit">跳过，之后再做</button></form>
        </> : <section className="card" data-testid="practice-answer">
          <h2>答案与解析</h2><p className="pre">{answer?.answer.text ?? '暂无参考答案，请对照原卷核对。'}</p>
          {answer?.answer.label ? <p className="hint">{answer.answer.label}</p> : null}
          {saved ? <p>已记录：{saved.correct ? '做对了' : '做错了'} · {saved.performed_at}</p> : <form method="post" action={`${itemUrl}/result`}>
            <label>做题日期 <input type="date" name="performedOn" defaultValue={props.today} min={(p.generatedAt ?? p.createdAt).slice(0,10)} max={props.today} required /></label>
            <label className="choice"><input type="checkbox" name="usedHint" value="yes" defaultChecked={hint > 0} />用过提示或参考帮助</label>
            <p><button className="btn primary" name="correct" value="yes" type="submit">做对了</button> <button className="btn" name="correct" value="no" type="submit">做错了</button></p>
          </form>}
        </section>}
      </> : <section className="card"><h2>本次练习已完成</h2><p>结果已保存，可以点上面的题号回看。</p><a className="btn" href="/s/choose">新建练习</a></section>}
    </>}
    </div>
  </Page>;
}
