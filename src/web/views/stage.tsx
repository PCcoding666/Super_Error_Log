import type { ReactNode } from 'react';
import { STAGES } from '../../classification/stages.js';
import { UNSUPPORTED_SUBJECT_MESSAGE } from '../../materials/subjects.js';
import { Page, Problem } from './layout.js';

/**
 * First entry of a new account: choose 初中 or 高中 before the notebook. No default is preselected.
 * 标题后半句用 .q 保持在同一行，「初中」不会被拆成两行。放不下整句时怎么断由浏览器定：
 * Chromium 排成「你现在 / 读初中还是高中？」；iPhone 13 的 Safari 上整句本来就在一行。
 */
export function StageChoicePage(props: { error?: string | null }): ReactNode {
  return (
    <Page title="选择学段" back={null} showSettings={false}>
      <h1>你现在读<span className="q">初中还是高中？</span></h1>
      {props.error ? <Problem title="还没选好" detail={props.error} /> : null}
      <p className="lead">错题会按这个学段整理章节。以后可以在设置里改。</p>
      <p className="hint" data-testid="stage-subjects">{UNSUPPORTED_SUBJECT_MESSAGE}</p>
      <form method="post" action="/s/stage" className="material-surface" data-testid="stage-choice">
        <div className="btn-stack">
          {STAGES.map(stage => <button key={stage} className="btn primary" type="submit" name="grade" value={stage}>{stage}</button>)}
        </div>
      </form>
    </Page>
  );
}
