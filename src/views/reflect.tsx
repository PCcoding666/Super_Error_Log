import type { ReactNode } from 'react';
import {
  ATTEMPT_STATES,
  CAUSES,
  MASTERY_FEELING_LABEL,
  REVIEW_VALUES,
  type MasteryFeeling,
  type Role,
} from '../domain/types.js';
import type { ReflectionSuggestion } from '../domain/reflectionSuggestion.js';
import { EmptyState, Layout } from './layout.js';
import type { ItemRow } from '../services/itemService.js';

type Suggestion = (ReflectionSuggestion & { adoptable: boolean }) | null;

function MasteryFieldset(props: { idPrefix: string }): ReactNode {
  return (
    <fieldset>
      <legend>现在的掌握感（只能你自己判断）</legend>
      {([0, 1, 2, 3] as MasteryFeeling[]).map((v) => (
        <label key={v} className="check" htmlFor={`${props.idPrefix}-mf-${v}`}>
          <input id={`${props.idPrefix}-mf-${v}`} type="radio" name="mastery_feeling" value={v} required /> {v} —{' '}
          {MASTERY_FEELING_LABEL[v]}
        </label>
      ))}
    </fieldset>
  );
}

function ManualForm(props: { item: ItemRow }): ReactNode {
  const { item } = props;
  return (
    <form method="post" action={`/reflect/${item.id}`} className="card form manual">
      <fieldset>
        <legend>1. 当时的做题状态</legend>
        {ATTEMPT_STATES.map((s) => (
          <label key={s} className="check">
            <input type="radio" name="attempt_state" value={s} required /> {s}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>2. 主要错因（你自己的判断）</legend>
        {CAUSES.map((s) => (
          <label key={s} className="check">
            <input type="radio" name="cause" value={s} required /> {s}
          </label>
        ))}
      </fieldset>
      <MasteryFieldset idPrefix="manual" />
      <fieldset>
        <legend>4. 这道题值得复习吗</legend>
        {REVIEW_VALUES.map((s) => (
          <label key={s} className="check">
            <input type="radio" name="review_value" value={s} required /> {s}
          </label>
        ))}
      </fieldset>
      <button className="btn primary" type="submit">
        确认，下一题
      </button>
    </form>
  );
}

/** 四项最小反思向导：一题一屏。AI 建议只展示不预选；高置信时可一键采纳（仍是学生主动提交），掌握感永远手选。 */
export function ReflectPage(props: {
  role: Role;
  item: ItemRow | null;
  remaining: number;
  total: number;
  suggestion: Suggestion;
  flash?: { ok?: string; err?: string };
}): ReactNode {
  const { item, remaining, total, suggestion } = props;
  if (!item) {
    return (
      <Layout title="最小反思" role={props.role} flash={props.flash}>
        <EmptyState title="没有待反思的题目" hint="所有已校正的题目都已完成反思。" actionHref="/plan" actionText="去生成复习包" />
      </Layout>
    );
  }
  const done = total - remaining + 1;
  return (
    <Layout title="最小反思" role={props.role} flash={props.flash}>
      <h1>四项最小反思</h1>
      <p className="muted">
        第 {done} / {total} 题 · {item.short_id ?? ''} · {item.subject ?? ''}
      </p>
      {item.text_excerpt ? <blockquote>{item.text_excerpt}</blockquote> : null}
      <p>
        <a href={`/media/asset/${item.asset_id}`} target="_blank" rel="noreferrer">
          查看原图
        </a>
      </p>

      {suggestion?.adoptable ? (
        <>
          <div className="card ai-suggest">
            <h2>AI 建议（仅供参考，采纳与否由你决定）</h2>
            <p>
              做题状态「{suggestion.attemptState!.value}」 · 主要错因「{suggestion.cause!.value}」 · 复习价值「
              {suggestion.reviewValue!.value}」
            </p>
            <form method="post" action={`/reflect/${item.id}`} className="form adopt">
              <input type="hidden" name="attempt_state" value={suggestion.attemptState!.value} />
              <input type="hidden" name="cause" value={suggestion.cause!.value} />
              <input type="hidden" name="review_value" value={suggestion.reviewValue!.value} />
              <input type="hidden" name="adopted_ai" value="1" />
              <MasteryFieldset idPrefix="adopt" />
              <button className="btn primary" type="submit">
                采纳建议，完成本题
              </button>
            </form>
          </div>
          <details className="card">
            <summary>不采纳？自己逐项判断（点这里展开）</summary>
            <ManualForm item={item} />
          </details>
        </>
      ) : (
        <>
          {suggestion ? (
            <p className="ai-hint">
              AI 参考（仅供你思考，不会替你选择）：
              {suggestion.cause ? `可能错因「${suggestion.cause.value}」` : ''}
              {suggestion.reviewValue ? `，复习价值「${suggestion.reviewValue.value}」` : ''}
              {suggestion.attemptState ? `，做题状态「${suggestion.attemptState.value}」` : ''}
            </p>
          ) : null}
          <ManualForm item={item} />
        </>
      )}
    </Layout>
  );
}
