import type { ReactNode } from 'react';
import { STAGES } from '../../classification/stages.js';
import { UNSUPPORTED_SUBJECT_MESSAGE } from '../../materials/subjects.js';
import { Page, Problem } from './layout.js';

/** First entry of a new account: choose 初中 or 高中 before the notebook. No default is preselected. */
export function StageChoicePage(props: { error?: string | null }): ReactNode {
  return (
    <Page title="选择学段" back={null} showSettings={false}>
      <h1>你现在读初中还是高中？</h1>
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
