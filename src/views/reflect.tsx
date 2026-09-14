import type { ReactNode } from 'react';
import {
  ATTEMPT_STATES,
  CAUSES,
  MASTERY_FEELING_LABEL,
  REVIEW_VALUES,
  type MasteryFeeling,
  type Role,
} from '../domain/types.js';
import { EmptyState, Layout } from './layout.js';
import type { ItemRow } from '../services/itemService.js';

/** 四项最小反思向导：一题一屏，AI 建议只展示不预选 */
export function ReflectPage(props: {
  role: Role;
  item: ItemRow | null;
  remaining: number;
  total: number;
  aiHint: { possibleCause?: string; reviewValue?: string } | null;
}): ReactNode {
  const { item, remaining, total } = props;
  if (!item) {
    return (
      <Layout title="最小反思" role={props.role}>
        <EmptyState title="没有待反思的题目" hint="所有已校正的题目都已完成反思。" actionHref="/plan" actionText="去生成复习包" />
      </Layout>
    );
  }
  const done = total - remaining + 1;
  return (
    <Layout title="最小反思" role={props.role}>
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
      {props.aiHint ? (
        <p className="ai-hint">
          AI 参考（仅供你思考，不会替你选择）：可能错因「{props.aiHint.possibleCause ?? '—'}」，复习价值「
          {props.aiHint.reviewValue ?? '—'}」
        </p>
      ) : null}

      <form method="post" action={`/reflect/${item.id}`} className="card form">
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
        <fieldset>
          <legend>3. 现在的掌握感</legend>
          {([0, 1, 2, 3] as MasteryFeeling[]).map((v) => (
            <label key={v} className="check">
              <input type="radio" name="mastery_feeling" value={v} required /> {v} — {MASTERY_FEELING_LABEL[v]}
            </label>
          ))}
        </fieldset>
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
    </Layout>
  );
}
