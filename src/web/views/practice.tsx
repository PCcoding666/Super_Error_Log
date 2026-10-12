import type { ReactNode } from 'react';
import type { PracticeCard, PracticeDetail, PracticeSummary, RecommendResponse } from '../../v2/practiceService.js';
import type { PrintSnapshot } from '../../v2/printService.js';
import type { ReturnSummary } from '../../v2/returnService.js';
import type { ReflectionSuggestionView, ReflectionTurnView, ReflectionView } from '../../v2/reflectionService.js';
import { weekRangeText } from '../format.js';
import { ItemCard } from './items.js';
import { Page, Phrased, Problem, quoted, type BarButton, type BarModel } from './layout.js';

// ---------- 选这周要练的题（§4.6） ----------

export const SLOT_PRESETS = ['周三晚自习', '周末', '本周内'] as const;

export function SlotChoice(props: { current: string; name?: string }): ReactNode {
  const name = props.name ?? 'practiceSlot';
  const preset = (SLOT_PRESETS as readonly string[]).includes(props.current);
  return (
    <div className="choices-inline">
      {SLOT_PRESETS.map(slot => (
        <label key={slot} className="choice"><input type="radio" name={name} value={slot} defaultChecked={props.current === slot} /><span>{slot}</span></label>
      ))}
      <label className="choice" data-slot-other=""><input type="radio" name={name} value="__other" defaultChecked={!preset} /><span>其他…</span></label>
      <label className="choice choice-full">
        <input type="text" name={`${name}Other`} maxLength={20} defaultValue={preset ? '' : props.current} placeholder="20 字以内，比如：周四午休" aria-label="其他时间" />
      </label>
    </div>
  );
}

function ChooseRow(props: { card: PracticeCard; checked: boolean }): ReactNode {
  const { card } = props;
  return (
    <label className="choice pick" data-testid="choose-row">
      <input type="checkbox" name="itemIds" value={card.id} defaultChecked={props.checked} />
      <span className="grow">
        <img className="crop" src={`/s/img/item/${card.id}`} alt={card.shortId ?? '题目裁图'} loading="lazy" />
        <span className="excerpt">{card.questionExcerpt ?? ''}</span>
        <span className="meta-line muted">为什么选它：{card.reason}</span>
        {card.badge === 'low' ? <span className="meta-line tone-orange">字可能认错了 · 点开看看</span> : null}
      </span>
    </label>
  );
}

/**
 * 选题服务器给的说明（scheduling.ts 的 notes）换成大白话；认不出的原样显示。只改显示，规则与原文不变。
 */
export function plainNote(note: string): string {
  const few = /^本周可安排题目仅 (\d+) 道，不足 (\d+) 道，已全部纳入$/.exec(note);
  if (few) return `这周能练的题只有 ${few[1]} 道，不到建议的 ${few[2]} 道，都帮你选上了。`;
  if (note.startsWith('候选知识点较集中')) return '这几道题的知识点比较集中，为了凑够题数，同一个知识点选了不止 2 道。';
  const conflict = /^其中 (\d+) 道存在「学生认为没必要但有复发证据」的冲突，建议保留$/.exec(note);
  if (conflict) return `其中 ${conflict[1]} 道你觉得没必要练，但最近又错过，建议留着。`;
  return note;
}

export function ChoosePage(props: { recommend: RecommendResponse; practiceSlot: string; caption: string; error?: string | null; reason?: string | null }): ReactNode {
  const { recommend } = props;
  const total = recommend.recommended.length + recommend.others.length;
  const n = recommend.recommended.length;
  const bar: BarModel = total === 0
    ? { caption: props.caption, primary: { title: '去拍', key: 'capture', href: '/s/capture' }, secondary: [] }
    : {
      caption: props.caption,
      primary: { title: n > 0 ? `就练这 ${n} 道` : '至少选 1 道', key: 'create', form: 'choose-form', disabled: n === 0, countTemplate: '就练这 {n} 道', emptyTitle: '至少选 1 道' },
      secondary: [],
    };
  return (
    <Page title="选这周要练的题" bar={bar}>
      <h1>选这周要练的题</h1>
      {props.error ? <Problem title={props.error} reason={props.reason} /> : null}
      {total === 0 ? (
        <section className="card"><p>现在没有可以练的题。先拍这周的卷子，或者等 AI 找完题。</p></section>
      ) : (
        <form method="post" action="/s/choose" id="choose-form" data-pick-count="" data-max={String(recommend.limits.max)} data-min="1" data-wait="正在建练习…">
          <p className="lead">AI 先帮你选了 {n} 道，点一下可以去掉或加上。建议 {recommend.limits.min}–{recommend.limits.max} 道，最多 {recommend.limits.max} 道。</p>
          <p className="tone-orange hidden" data-max-warning="" role="status">最多 {recommend.limits.max} 道。想加这道，先去掉一道。</p>
          {recommend.notes.length > 0 ? <div className="notes" data-testid="choose-notes">{recommend.notes.map(note => <p key={note}>{plainNote(note)}</p>)}</div> : null}
          {recommend.recommended.map(card => <ChooseRow key={card.id} card={card} checked />)}
          {recommend.others.length > 0 ? (
            <details>
              <summary data-key="choose-others">其他可以选的（{recommend.others.length}）</summary>
              {recommend.others.map(card => <ChooseRow key={card.id} card={card} checked={false} />)}
            </details>
          ) : null}
          <fieldset>
            <legend>什么时候做？</legend>
            <SlotChoice current={props.practiceSlot} />
            <p className="hint">会印在练习纸封面上，提醒你哪天做</p>
          </fieldset>
        </form>
      )}
    </Page>
  );
}

// ---------- 说说为什么错（§4.7） ----------

export const ATTEMPT_CHOICES: Array<[string, string]> = [
  ['完全不会', '完全不会'], ['知道考啥，没想到方法', '知道考什么但没想到方法'], ['方法对，步骤错了', '方法基本正确但步骤出错'],
  ['本来会，粗心了', '本来会但审题计算书写失误'], ['时间不够', '时间不足'], ['其他', '其他'],
];
export const CAUSE_CHOICES: Array<[string, string]> = [
  ['概念没弄懂', '知识概念'], ['方法选错了', '方法选择'], ['推理中间断了', '推理步骤'], ['算错了', '计算'],
  ['题目没看全', '审题遗漏'], ['写法不规范', '表达规范'], ['时间不够或走神', '时间注意力状态'],
];
export const MASTERY_CHOICES: Array<[string, number]> = [['还是不会', 0], ['看提示可能会', 1], ['现在做应该会', 2], ['过几天也会', 3]];

/** 一份练习里的几道题：小裁图 + 编号 + 科目与知识点 + 一行状态（说过了 / 跳过了…）。只用现有数据。 */
function PracticeItemRows(props: { items: PracticeDetail['items']; status: (item: PracticeDetail['items'][number], index: number) => { text: string; tone?: string } | null; testId?: string }): ReactNode {
  return (
    <ul className="list" data-testid={props.testId}>
      {props.items.map((item, index) => {
        const status = props.status(item, index);
        return (
          <li key={item.id} className="row qrow">
            <img className="thumb" src={`/s/img/item/${item.id}`} alt="" loading="lazy" />
            <span className="row-text">
              <b>{item.shortId ?? `第 ${index + 1} 道`}</b>
              <span className="meta-line muted">{[item.subject, ...item.knowledgeTags].filter(Boolean).join(' · ') || '错题'}</span>
              {status ? <span className={`meta-line${status.tone ? ` tone-${status.tone}` : ''}`}>{status.text}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function WhyIntroPage(props: { practice: PracticeDetail; index: number; total: number; pending: string[] }): ReactNode {
  const bar: BarModel = {
    caption: `第 ${props.index + 1} 道，共 ${props.total} 道`,
    primary: { title: '开始', key: 'start', post: `/s/why/${props.practice.id}/start`, wait: 'AI 在想问你什么…' },
    secondary: [{ title: '跳过，直接打印', key: 'skipWhy', post: '/s/skip', fields: { step: 'why', practice: props.practice.id }, wait: '正在准备练习纸…' }],
  };
  return (
    <Page title="说说为什么错" bar={bar}>
      <h1>说说为什么错</h1>
      <section className="card">
        <p>每道题 AI 问你一句，你说一句就行。说出来，下次更容易发现自己是哪里想错了。</p>
        {props.index > 0 ? <p data-testid="why-resume">前 {props.index} 道已经说过或跳过了，从第 {props.index + 1} 道接着说。</p> : null}
        <p className="muted">不想说可以跳过，不影响打印。</p>
      </section>
      <section className="card">
        <h2 className="card-title">这次的 {props.total} 道</h2>
        <PracticeItemRows items={props.practice.items} testId="why-items" status={(item, index) => (
          item.reflected ? { text: '说过了 ✓', tone: 'green' }
            : !props.pending.includes(item.id) ? { text: '跳过了' }
              : index === props.index ? { text: props.index > 0 ? '从这道接着说' : '从这道开始', tone: 'teal' } : null
        )} />
      </section>
    </Page>
  );
}

export function WhyAskPage(props: { practiceId: string; card: PracticeCard; index: number; total: number; turns: ReflectionTurnView[]; error?: string | null; answer?: string }): ReactNode {
  const { card } = props;
  const open = props.turns.find(turn => turn.answer === null) ?? null;
  const answered = props.turns.filter(turn => turn.answer !== null);
  const bar: BarModel = open
    ? {
      caption: `第 ${props.index + 1} 道，共 ${props.total} 道`,
      primary: { title: '说完了', key: 'answer', form: 'answer-form' },
      secondary: [{ title: '不回答，直接选', key: 'skipQuestion', href: `/s/why/${props.practiceId}/${card.id}/confirm` }],
    }
    : {
      caption: `第 ${props.index + 1} 道，共 ${props.total} 道`,
      primary: { title: '开始', key: 'ask', post: `/s/why/${props.practiceId}/${card.id}/ask`, wait: 'AI 在想问你什么…' },
      secondary: [{ title: '不回答，直接选', key: 'skipQuestion', href: `/s/why/${props.practiceId}/${card.id}/confirm` }],
    };
  return (
    <Page title="说说为什么错" bar={bar}>
      <h1>说说为什么错</h1>
      <img className="crop big" src={`/s/img/item/${card.id}`} alt={card.shortId ?? '题目裁图'} />
      {props.error ? <Problem title="没提交上" detail={props.error} /> : null}
      {answered.map(turn => (
        <div key={turn.turn}>
          <div className="bubble"><span className="who">AI 问你</span><p>{turn.question}</p></div>
          <div className="answer">{turn.answer}</div>
        </div>
      ))}
      {open ? (
        <form method="post" action={`/s/why/${props.practiceId}/${card.id}/answer`} id="answer-form" data-wait="AI 在看你的回答…">
          <div className="bubble" data-testid="ai-question"><span className="who">AI 问你</span><p>{open.question}</p></div>
          <label htmlFor="answer-text" className="field-label">你的回答</label>
          <textarea id="answer-text" name="answer" maxLength={300} required defaultValue={props.answer ?? ''} placeholder="点「点一下开始说」说话，或者直接打字" data-count="#answer-count" aria-describedby="answer-count" />
          <p className="hint" id="answer-count">还能写 300 字</p>
          <div className="voice hidden" data-voice-for="answer-text" data-endpoint="/s/voice" data-testid="voice">
            <button type="button" data-testid="voice-button">点一下开始说</button> <span className="small muted" data-voice-note="" data-testid="voice-note" aria-live="polite" />
          </div>
        </form>
      ) : null}
    </Page>
  );
}

function Group<T extends string | number>(props: { legend: string; name: string; choices: Array<[string, T]>; selected: T | null; badge: string | null; hint?: string }): ReactNode {
  return (
    <fieldset>
      <legend>{props.legend}{props.badge && props.selected !== null ? <span className="tag">{props.badge}</span> : null}</legend>
      {props.hint ? <p className="hint">{props.hint}</p> : null}
      <div className="choices-inline">
        {props.choices.map(([label, value]) => (
          <label key={String(value)} className="choice"><input type="radio" name={props.name} value={String(value)} defaultChecked={props.selected === value} /><span>{label}</span></label>
        ))}
      </div>
    </fieldset>
  );
}

export function WhyConfirmPage(props: { practiceId: string; card: PracticeCard; index: number; total: number; last: boolean;
  suggestion: ReflectionSuggestionView | null; previous: ReflectionView | null; error?: string | null }): ReactNode {
  const { card, suggestion, previous } = props;
  const source = previous ? '你上次选的' : 'AI 猜的';
  const bar: BarModel = {
    caption: `第 ${props.index + 1} 道，共 ${props.total} 道`,
    primary: { title: props.last ? '提交' : '提交，下一道', key: 'submit', form: 'reflection-form' },
    secondary: [{ title: '这道跳过', key: 'pass', post: `/s/why/${props.practiceId}/${card.id}/pass` }],
  };
  const summary = previous?.summary ?? suggestion?.summary ?? '';
  return (
    <Page title="说说为什么错" bar={bar} barExtra={<p className="caption tone-orange" data-missing="" data-testid="missing" />}>
      <h1>说说为什么错</h1>
      <img className="crop" src={`/s/img/item/${card.id}`} alt={card.shortId ?? '题目裁图'} />
      {props.error ? <Problem title={props.error} /> : null}
      <form method="post" action={`/s/why/${props.practiceId}/${card.id}/submit`} id="reflection-form" data-reflection="">
        <label htmlFor="reflection-summary" className="field-label">一句话总结（AI 先写了，可以改）{summary ? <span className="tag">{previous ? '你上次选的' : 'AI 写的'}</span> : null}</label>
        <textarea id="reflection-summary" className="autogrow" name="summary" rows={2} maxLength={60} defaultValue={summary} placeholder="空着也能提交" data-single-line="" enterKeyHint="done" />
        <Group legend="当时怎么了？" name="attemptState" choices={ATTEMPT_CHOICES} selected={previous?.attemptState ?? suggestion?.suggestedAttemptState ?? null} badge={source} />
        <Group legend="主要错在哪？" name="cause" choices={CAUSE_CHOICES} selected={previous?.cause ?? suggestion?.suggestedCause ?? null} badge={source} />
        <Group legend="现在再做这道题，有把握吗？" name="masteryFeeling" choices={MASTERY_CHOICES} selected={null} badge={null} hint="这个要你自己选，AI 不帮你猜" />
      </form>
    </Page>
  );
}

export function WhyDonePage(props: { practice: PracticeDetail }): ReactNode {
  const reflected = props.practice.items.filter(item => item.reflected).length;
  const bar: BarModel = {
    caption: '',
    primary: props.practice.generatedAt
      ? { title: '下一步：打印练习纸', key: 'print', href: `/s/print/${props.practice.id}` }
      : { title: '下一步：打印练习纸', key: 'print', post: `/s/print/${props.practice.id}`, wait: '正在准备练习纸…' },
    secondary: [],
  };
  return (
    <Page title="说完了" bar={bar}>
      <h1>说完了 ✓</h1>
      <section className="card">
        <p className="card-title" data-testid="why-done">{props.practice.items.length} 道里说了 {reflected} 道</p>
        <p className="muted">{reflected > 0 ? '你说的会记下来。下周录完结果，能看看当时的感觉准不准。' : '这次没说也没关系，下次可以再说。'}</p>
        <p>{props.practice.generatedAt ? '下一步：把练习纸打出来，带回学校。' : '下一步：准备练习纸。AI 给每道题写好提示和答案，大约 1 分钟。'}</p>
      </section>
      <section className="card">
        <h2 className="card-title">这次的 {props.practice.items.length} 道</h2>
        <PracticeItemRows items={props.practice.items} testId="why-done-items" status={item => (item.reflected ? { text: '说过了 ✓', tone: 'green' } : { text: '这次没说' })} />
        <p className="small muted">这几道都会印在练习纸上，说没说都一样要做。</p>
      </section>
    </Page>
  );
}

// ---------- 打印练习纸（§4.8） ----------

/** 打印前看一眼的原因（printService 的原文）换成设计稿词表的说法：不说「AI 没把握」（§6）。只改显示。 */
export function plainGlance(reason: string | null): string {
  if (!reason) return '打印前看一眼截图';
  if (reason.includes('AI 没把握')) return '字可能认错了，打印前看一眼截图全不全';
  return reason;
}

function hintLine(prefix: string, text: string | null): string {
  if (!text) return `${prefix}（无）`;
  return text.startsWith(prefix) ? text : prefix + text;
}

/** A4 练习纸：封面 + 题目页 + 可撕的答案页（与 iOS PracticeLayout 同样的内容与说法）。浏览器打印成纸或 PDF。 */
export function PracticeSheet(props: { snapshot: PrintSnapshot }): ReactNode {
  const { snapshot } = props;
  const media = (name: string): string => `/s/img/print/${snapshot.packetId}/${name}`;
  return (
    <div className="sheet" data-testid="sheet">
      <section className="page">
        <h3>{snapshot.cover.title}</h3>
        <p>{weekRangeText(snapshot.week, 'long')}</p>
        <p>什么时候做：{snapshot.cover.practiceSlot}</p>
        <p><b>规则：</b></p>
        {snapshot.cover.rules.map((rule, index) => <p key={rule}>{index + 1}. {rule}</p>)}
        <p><b>题目清单：</b></p>
        {snapshot.cover.itemList.map((entry, index) => <p key={index}>{entry.shortId ?? '—'}　{entry.sourceLabel}</p>)}
        <p style={{ marginTop: '8mm' }}>做题日期：________</p>
      </section>
      <section className="page">
        {snapshot.items.map(item => (
          <div className="item" key={item.itemId}>
            <p className="item-head"><b>{item.shortId ?? `第 ${item.position + 1} 题`}</b>{[item.subject, ...item.knowledgeTags].filter(Boolean).join('、')}</p>
            {item.stemText ? <p className="stem">{item.stemText}</p> : null}
            {item.mode === 'crop' ? <p className="note">AI 对这题没把握，文字和截图不一致时以截图为准</p> : null}
            {item.mode === 'crop' && item.cropMedia ? <img src={media(item.cropMedia)} alt="题目截图" /> : null}
            {item.diagramMedia.map(name => <img key={name} src={media(name)} alt="图示" />)}
            <p>{item.keyStepPrompt}</p>
            <div className="blank" />
            <p className="boxes">{item.checkboxes.map(box => <span key={box}>□ {box}</span>)}<span>做题日期：________</span></p>
          </div>
        ))}
      </section>
      <section className="page answers">
        <h3>做完再看</h3>
        <p>先独立做；卡住了按一级、二级提示的顺序看</p>
        {snapshot.answerSheet.map((entry, index) => (
          <div className="answer-entry" key={index}>
            <p><b>{entry.shortId ?? '—'}</b></p>
            <p>{hintLine('一级提示：', entry.hint1)}</p>
            <p>{hintLine('二级提示：', entry.hint2)}</p>
            <p>{entry.answer.text ? `答案：${entry.answer.text}${entry.answer.label ? `（${entry.answer.label}）` : ''}` : '答案：（无）'}</p>
            <p>{entry.fallbackNote}</p>
          </div>
        ))}
      </section>
    </div>
  );
}

export type PrintState =
  | { status: 'none' }
  | { status: 'preparing'; done: number; total: number }
  | { status: 'failed'; error: string | null }
  | { status: 'ready'; snapshot: PrintSnapshot };

export function PrintPage(props: { practiceId: string; state: PrintState; caption: string }): ReactNode {
  const { state, practiceId } = props;
  let bar: BarModel;
  let body: ReactNode;
  if (state.status === 'none') {
    bar = { caption: props.caption, primary: { title: '准备练习纸', key: 'prepare', post: `/s/print/${practiceId}`, wait: '正在准备练习纸…' }, secondary: [] };
    body = <section className="card"><p>先把练习纸准备好：AI 给每道题写好提示和答案，大约 1 分钟。</p></section>;
  } else if (state.status === 'preparing') {
    bar = { caption: '大约 1 分钟。可以先离开，回来接着准备。', primary: { title: '正在准备…', key: 'waiting', disabled: true, waiting: true }, secondary: [{ title: '先回到今天', key: 'goHome', href: '/s/' }] };
    const percent = state.total ? Math.round(state.done * 100 / state.total) : 0;
    body = (
      <section className="card" data-testid="print-preparing">
        <p role="status">正在准备练习纸… 第 {state.done}/{state.total} 道</p>
        <div className="progress" role="progressbar" aria-label="准备进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }} /></div>
        <p className="hint">AI 在给每道题写提示和答案。可以先离开，回来接着准备。</p>
      </section>
    );
  } else if (state.status === 'failed') {
    bar = { caption: '', primary: { title: '再试一次', key: 'retry', post: `/s/print/${practiceId}`, wait: '正在准备练习纸…' }, secondary: [{ title: '先回到今天', key: 'goHome', href: '/s/' }] };
    body = <Problem title={`练习纸没准备好：${state.error ?? '服务器没说原因'}`} />;
  } else {
    const glance = state.snapshot.items.filter(item => item.needsGlance);
    const printButton: BarButton = { title: '打印', key: 'print', href: `/s/print/${practiceId}/sheet`, print: true };
    bar = {
      caption: '打出来，带回学校',
      captionAfterPrint: '打印机没反应？可以再点一次「再打印」，或者在打印预览里用「存储到文件」发给家里人打印。',
      primary: printButton,
      secondary: [],
    };
    body = (
      <>
        {glance.length > 0 ? (
          <section className="card" data-testid="glance">
            <h2 className="card-title">打印前看一眼这 {glance.length} 道</h2>
            {glance.map(item => (
              <details key={item.itemId}>
                <summary data-key="print-glance">{item.shortId ?? `第 ${item.position + 1} 题`}：{plainGlance(item.glanceReason)}</summary>
                {item.cropMedia ? <img className="crop big" src={`/s/img/print/${practiceId}/${item.cropMedia}`} alt="截图" /> : null}
              </details>
            ))}
          </section>
        ) : null}
        {/* 首屏先用手机字号列出这张纸上的题（A4 预览缩小后看不清）；预览和纸面本身不变。 */}
        <section className="card" data-testid="print-summary">
          <h2 className="card-title">这张练习纸上有 {state.snapshot.items.length} 道题</h2>
          <ul className="list">
            {state.snapshot.items.map(item => (
              <li key={item.itemId} className="row qrow">
                <img className="thumb" src={`/s/img/item/${item.itemId}`} alt="" loading="lazy" />
                <span className="row-text">
                  <b>{item.shortId ?? `第 ${item.position + 1} 题`}</b>
                  <span className="meta-line muted">{[item.subject, ...item.knowledgeTags].filter(Boolean).join(' · ') || '错题'}</span>
                  {item.stemText ? <span className="meta-line excerpt">{item.stemText}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          <p className="small muted"><Phrased text={`什么时候做：${state.snapshot.cover.practiceSlot}。答案在最后一页，做完再看。`} /></p>
        </section>
        <h2 className="section-label out">整张练习纸（A4 预览）</h2>
        <div className="print-root">
          <div className="sheet-frame"><div className="sheet-wrap" data-testid="print-preview"><div className="sheet-scale"><PracticeSheet snapshot={state.snapshot} /></div></div></div>
        </div>
        <a className="more" href={`/s/print/${practiceId}/sheet`} data-testid="sheet-link">单独打开练习纸<span aria-hidden="true">›</span></a>
        <p className="hint">{quoted('单独打开以后，可以在打印预览里「存储到文件」存成 PDF。')}</p>
      </>
    );
  }
  // 打印回来以后：主按钮换成「打印好了，回到今天」（他自己说打好了，手机不替他说），上面一行「再打印」。
  const afterPrint = state.status === 'ready' ? (
    <div className="bar-after hidden" data-after-print="">
      <div className="bar-alt"><a className="btn alt" href={`/s/print/${practiceId}/sheet`} data-print="" data-testid="reprint" data-key="reprint">再打印</a></div>
      <div className="bar-main"><a className="btn primary" href="/s/?printed=1" data-print-done="" data-testid="print-done" data-key="printed">打印好了，回到今天</a></div>
    </div>
  ) : null;
  return (
    <Page title="打印练习纸" bar={bar} barExtra={afterPrint} refreshSeconds={state.status === 'preparing' ? 3 : undefined} bodyClass={state.status === 'ready' ? 'print-page' : undefined}>
      <h1>打印练习纸</h1>
      {body}
    </Page>
  );
}

/** 单独的练习纸页：没开脚本时用 Safari 的「分享 → 打印」；打印预览里可以「存储到文件」存成 PDF。 */
export function SheetPage(props: { snapshot: PrintSnapshot }): ReactNode {
  const bar: BarModel = {
    caption: '用 Safari 的「分享」→「打印」打出来；打印预览里也能「存储到文件」',
    primary: { title: '打印好了，回到今天', key: 'printed', href: '/s/?printed=1' },
    secondary: [{ title: '打印', key: 'print', href: '#', print: true }],
  };
  return (
    <Page title="练习纸" back={{ href: `/s/print/${props.snapshot.packetId}`, label: '打印练习纸' }} bar={bar}>
      <h1>练习纸</h1>
      <h2 className="visually-hidden">练习纸预览</h2>
      <div className="print-root"><div className="sheet-frame"><div className="sheet-wrap"><div className="sheet-scale"><PracticeSheet snapshot={props.snapshot} /></div></div></div></div>
    </Page>
  );
}

// ---------- 录结果（§4.10，一题一屏） ----------

export const COMPLETIONS: Array<[string, string]> = [
  ['independent', '独立做出'], ['hint1', '看了一级提示'], ['hint2', '看了二级提示'], ['not_solved', '没做出来'], ['not_done', '没做'],
];

export interface RecordAnswer { completion: string; correct: string; stuck: string; date: string }

export interface DayOption { value: string; label: string }

function Hidden(props: { state: Record<string, string> }): ReactNode {
  return <>{Object.entries(props.state).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}</>;
}

export function RecordDatePage(props: { practiceId: string; days: DayOption[]; state: Record<string, string>; recorded: number; remaining: number; error?: string | null; rejected?: string | null }): ReactNode {
  const bar: BarModel = {
    caption: props.recorded > 0 ? `已录 ${props.recorded} 道，还剩 ${props.remaining} 道` : `一共 ${props.remaining} 道`,
    primary: { title: '下一步', key: 'next', form: 'record-form', name: 'go', value: 'next' },
    secondary: [{ title: '先跳过，下次再录', key: 'skipRecord', post: '/s/skip', fields: { step: 'record' } }],
  };
  return (
    <Page title="录练习纸的结果" bar={bar}>
      <h1>练习纸是哪天做的？</h1>
      {props.rejected ? <Problem title={props.rejected} /> : null}
      {props.error ? <Problem title={props.error} /> : null}
      <form method="post" action={`/s/record/${props.practiceId}`} id="record-form">
        <Hidden state={Object.fromEntries(Object.entries(props.state).filter(([name]) => name !== 'date'))} />
        <input type="hidden" name="at" value="0" />
        <div className="choices-inline">
          {props.days.map(day => (
            <label key={day.value} className="choice" data-testid="record-day"><input type="radio" name="date" value={day.value} defaultChecked={props.state.date === day.value} /><span>{day.label}</span></label>
          ))}
        </div>
      </form>
      <p className="hint">当天做对不算真会，隔 3 天以上独立做对才算，所以日期要填准。</p>
      <p className="hint">不是同一天做的？后面每道可以单独改。</p>
    </Page>
  );
}

export function RecordItemPage(props: { practiceId: string; card: PracticeCard; index: number; total: number; days: DayOption[]; state: Record<string, string>; answer: RecordAnswer; error?: string | null }): ReactNode {
  const { card } = props;
  const last = props.index === props.total - 1;
  const bar: BarModel = {
    caption: `第 ${props.index + 1} 道，共 ${props.total} 道`,
    primary: { title: last ? `提交 ${props.total} 道结果` : '下一道', key: last ? 'submit' : 'next', form: 'record-form', name: 'go', value: last ? 'submit' : 'next' },
    // 第 1 道的「上一步」回到选日期那一屏（整张练习纸的日期）；和下面「只有这道不是那天做的？」（只改这一道）说法分开。
    secondary: [{ title: props.index === 0 ? '回去改整张的日期' : '上一道', key: 'prev', form: 'record-form', name: 'go', value: 'prev' }],
  };
  const prefix = card.id;
  const keep = Object.fromEntries(Object.entries(props.state).filter(([name]) => !name.endsWith(`_${prefix}`)));
  return (
    <Page title="录练习纸的结果" bar={bar}>
      <h1>这道你是怎么做的？</h1>
      {props.error ? <Problem title={props.error} /> : null}
      <img className="crop big" src={`/s/img/item/${card.id}`} alt={card.shortId ?? '题目裁图'} />
      <p className="excerpt">{card.questionExcerpt ?? ''}</p>
      <form method="post" action={`/s/record/${props.practiceId}`} id="record-form" data-record-item="">
        <Hidden state={keep} />
        <input type="hidden" name="at" value={String(props.index + 1)} />
        <input type="hidden" name="item" value={card.id} />
        {COMPLETIONS.map(([value, label]) => (
          <label key={value} className="choice" data-testid={`completion-${value}`}><input type="radio" name="completion" value={value} defaultChecked={props.answer.completion === value} /><span>{label}</span></label>
        ))}
        <fieldset data-correct="">
          <legend>做对了吗？对照练习纸最后一页的答案</legend>
          <div className="choices-inline">
            <label className="choice" data-testid="correct-yes"><input type="radio" name="correct" value="yes" defaultChecked={props.answer.correct === 'yes'} /><span>对了</span></label>
            <label className="choice" data-testid="correct-no"><input type="radio" name="correct" value="no" defaultChecked={props.answer.correct === 'no'} /><span>错了</span></label>
          </div>
          <p className="hint no-js-only">独立做出或看了提示的，才选对没对。</p>
        </fieldset>
        <div data-stuck="">
          <label htmlFor="record-stuck" className="field-label">卡在哪一步？（可以不填）</label>
          <input type="text" id="record-stuck" name="stuck" maxLength={100} defaultValue={props.answer.stuck} placeholder="比如：第二步移项" />
        </div>
        <details>
          <summary data-key="record-item-date">只有这道不是那天做的？</summary>
          <label htmlFor="record-item-date" className="field-label">这道是哪天做的</label>
          <select id="record-item-date" name="itemDate" defaultValue={props.answer.date}>
            {props.days.map(day => <option key={day.value} value={day.value}>{day.label}</option>)}
          </select>
        </details>
      </form>
    </Page>
  );
}

// ---------- 这次的结果（§4.11） ----------

export function ResultsPage(props: { practice: PracticeDetail; summary: ReturnSummary; next: BarButton }): ReactNode {
  const { summary } = props;
  const head = summary.answered >= summary.total
    ? `${summary.total} 道里，独立做对 ${summary.independentCorrect} 道`
    : `录了 ${summary.answered}/${summary.total} 道，独立做对 ${summary.independentCorrect} 道`;
  const nothing = summary.masteredNow.length + summary.again.length + summary.pending.length === 0 && !summary.calibration.text;
  const confirm = summary.nextConfirmOn ? `${Number(summary.nextConfirmOn.slice(5, 7))}/${Number(summary.nextConfirmOn.slice(8, 10))}` : null;
  const bar: BarModel = { caption: '', primary: props.next, secondary: [] };
  return (
    <Page title="这次的结果" bar={bar}>
      <h1>这次的结果</h1>
      <p className="lead card-title" data-testid="results-head">{head}</p>
      {summary.masteredNow.length > 0 ? (
        <section className="card">
          <h2 className="card-title tone-green">真会了 ✓（{summary.masteredNow.length} 道）</h2>
          <p className="small muted">隔了几天还能独立做对。{confirm ? `${confirm} 前后会再考你一次，再对就算稳了。` : ''}</p>
          <ul className="list">{summary.masteredNow.map(item => <li key={item.id}><ItemCard item={item} /></li>)}</ul>
        </section>
      ) : null}
      {summary.pending.length > 0 ? (
        <section className="card">
          <h2 className="card-title">做对了，过几天再确认（{summary.pending.length} 道）</h2>
          <p className="small muted">做题那天离练习纸生成太近，过几天再做对才算数。</p>
          <ul className="list">{summary.pending.map(item => <li key={item.id}><ItemCard item={item} /></li>)}</ul>
        </section>
      ) : null}
      {summary.again.length > 0 ? (
        <section className="card">
          <h2 className="card-title tone-orange">下次再练（{summary.again.length} 道）</h2>
          <p className="small muted">这几道会自动放进下次的练习。</p>
          <ul className="list">{summary.again.map(item => <li key={item.id}><ItemCard item={item} /></li>)}</ul>
        </section>
      ) : null}
      {summary.calibration.text ? (
        <section className="card">
          <p><b>你的感觉准不准：</b>{summary.calibration.text}</p>
          {summary.calibration.items.length > 0 ? <p className="small muted">{summary.calibration.items.map(item => item.shortId ?? '').filter(Boolean).join('、')}</p> : null}
        </section>
      ) : null}
      {nothing ? <section className="card"><p>这次的结果记下了</p></section> : null}
    </Page>
  );
}

// ---------- 以前的练习 ----------

export interface PracticeRow extends PracticeSummary {
  answered: number | null;
  /** 录过结果时：独立做对几道（服务器的回报，没有就是 null）。 */
  independentCorrect: number | null;
  /** 这份练习里的题号（练习纸编号），按纸上的顺序。 */
  shortIds: string[];
  /** 只有最近一份带：这份练习里的题（小裁图、编号、科目），列在它下面。 */
  items?: PracticeDetail['items'];
}

function PracticeLink(props: { practice: PracticeRow; showIds: boolean }): ReactNode {
  const p = props.practice;
  const recorded = p.answered !== null && p.answered >= p.itemCount;
  const status = p.generatedAt === null ? '还没生成练习纸'
    : recorded ? `录完了${p.independentCorrect !== null ? ` · 独立做对 ${p.independentCorrect} 道` : ''}`
      : p.answered ? `录了 ${p.answered}/${p.itemCount} 道` : '练习纸已生成 · 做完回来录结果';
  const href = p.generatedAt === null ? `/s/why/${p.id}` : p.answered ? `/s/results/${p.id}` : `/s/record/${p.id}`;
  return (
    <a className="row" href={href} data-testid="practice-row">
      <span className="row-text">
        <b>{weekRangeText(p.week, 'short')}</b> · {p.itemCount} 道{p.practiceSlot ? ` · ${p.practiceSlot}` : ''}
        {props.showIds && p.shortIds.length > 0 ? <span className="meta-line muted">{p.shortIds.join('、')}</span> : null}
        <span className={`meta-line${recorded ? ' tone-green' : ' muted'}`}>{status}</span>
      </span>
      <span className="chev" aria-hidden="true">›</span>
    </a>
  );
}

/** 以前的练习：最近一份单独一张卡，下面列出它的题；更早的每份一行（题号写在行里）。只用现有数据。 */
export function PracticesPage(props: { practices: PracticeRow[] }): ReactNode {
  const bar: BarModel = { caption: '', primary: { title: '回到今天', key: 'goHome', href: '/s/' }, secondary: [] };
  const [latest, ...older] = props.practices;
  return (
    <Page title="以前的练习" bar={bar}>
      <h1>以前的练习</h1>
      {!latest ? <section className="card"><p>还没有练习。选了题就会出现在这里。</p></section> : (
        <>
          <p className="lead">每个周末一份练习纸。没录的点开可以录结果，录过的点开能看这次的结果。</p>
          <section className="card" data-testid="practice-latest">
            <h2 className="section-label">最近一份</h2>
            <ul className="list"><li><PracticeLink practice={latest} showIds={!latest.items?.length} /></li></ul>
            {latest.items?.length ? <PracticeItemRows items={latest.items} status={() => null} testId="practice-latest-items" /> : null}
          </section>
          {older.length > 0 ? (
            <section className="card">
              <h2 className="section-label">更早的</h2>
              <ul className="list">{older.map(p => <li key={p.id}><PracticeLink practice={p} showIds /></li>)}</ul>
            </section>
          ) : null}
          <p className="hint">当天做对不算真会，隔 3 天以上独立做对才算。</p>
        </>
      )}
    </Page>
  );
}

// ---------- 设置（§4.12） ----------

export function SettingsPage(props: { practiceSlot: string; paperLocation: string; saved: boolean; error?: string | null }): ReactNode {
  const bar: BarModel = { caption: '', primary: { title: '保存', key: 'save', form: 'settings-form' }, secondary: [{ title: '回到今天', key: 'goHome', href: '/s/' }] };
  const places: Array<[string, string]> = [['school', '学校'], ['home', '家'], ['varies', '不固定']];
  return (
    <Page title="设置" bar={bar} showSettings={false} flash={{ ok: props.saved ? '保存好了' : null, err: props.error ?? null }}>
      <h1>设置</h1>
      <form method="post" action="/s/settings" id="settings-form">
        <fieldset>
          <legend>做练习的时间</legend>
          <SlotChoice current={props.practiceSlot} />
          <p className="hint">会印在练习纸封面上</p>
        </fieldset>
        <fieldset>
          <legend>原卷平时放在哪</legend>
          <div className="choices-inline">
            {places.map(([value, label]) => <label key={value} className="choice"><input type="radio" name="paperLocation" value={value} defaultChecked={props.paperLocation === value} /><span>{label}</span></label>)}
          </div>
          <p className="hint">{quoted('决定答案页写「对照原卷第几题」还是「回家后对照原卷」')}</p>
        </fieldset>
      </form>
      <section className="card">
        <h2 className="card-title">连接</h2>
        <p className="tone-green" data-testid="connection-ok">已连上服务器 ✓</p>
        <a className="more" href="/s/install" data-key="settings-install">怎么放到主屏幕<span aria-hidden="true">›</span></a>
      </section>
    </Page>
  );
}
