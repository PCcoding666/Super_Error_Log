# Notebook

The notebook is the home list of saved wrong questions. It is where the student searches, filters, switches list or grid, and removes a question.

## Sub-features

- `notebook-empty` shows the first-run empty state, with on-page camera and album actions, and the corner camera and album controls.
- `notebook-list` shows grouped rows. Tapping a row opens question detail.
- `notebook-grid` shows the same questions as cards.
- `notebook-search` filters from the search box and can be cancelled.
- `notebook-filter-subject` switches subject from the title.
- `notebook-filter-menu` filters chapter and, when more than one stage is stored, stage. Knowledge tags are in the same menu.
- `notebook-select-discard` removes the chosen questions and can undo.
- `notebook-swipe-discard` removes one list row from the trailing swipe action.
- `notebook-intake-hint` links to intake when photos are still being read or still have questions that were not added.
- `notebook-error` shows a retryable error instead of the list.

## How to get to it (user POV)

- After login, or after choosing a stage, land on `/s/`.
- From Settings, use the back control. It returns here.
- From question detail, use the back control. It returns here when the notebook was the previous screen.
- From intake, choose `完成`.
- The title, search, and filter controls stay on this screen.

## Driving it with sel-verify

Preconditions:

- The student is signed in and has a stage. See [Log in](./login.md) and [Choose stage](./choose-stage.md).
- Empty-state steps need a notebook with no saved questions.
- List, grid, search, filter, and discard need at least one saved question. Capture and intake first if the notebook is empty.
- On this fixture the mock question text contains `1 + 1`. The chapter is often `未分类`. Do not expect a textbook chapter name until a question has one.

- **After stage.** `sel-verify drive wait --testid empty-notebook --timeout 60000` on a new account, or `--testid item-card` when questions exist. Shot `--feature notebook --name home --entry after-stage`.
- **Empty state.** `--testid empty-notebook` is visible. `--testid capture-camera` (去拍照) and `--testid capture-album` (从相册选择) are visible. The corner dock is also visible: `--testid capture-fab-camera` and `--testid next-step-primary` (accessible name `从相册选择`). No `--testid item-card`.
- **From Settings.** `sel-verify drive click --testid settings-link`, wait for heading `设置`, then `sel-verify drive click --testid back-link`. The notebook is visible again. Shot `--feature notebook --name from-settings --entry settings-back`.
- **From intake.** On `/s/new`, `sel-verify drive click --testid intake-done`. The URL is `/s/` and the notebook is visible. Shot `--feature notebook --name from-intake --entry intake-done`.
- **From detail.** Open a row, then `sel-verify drive click --testid back-link`. The notebook is visible. Shot `--feature notebook --name from-detail --entry detail-back`.
- **Open a question.** `sel-verify drive click --testid item-card`. The URL matches `/s/q/*` (`sel-verify drive wait --url /s/q/*`).
- **Grid.** `sel-verify drive click --testid notebook-filters`, then `sel-verify drive click --text "网格" --exact`. Cards replace the list. The same questions remain. Shot `--feature notebook --name grid --entry menu`.
- **List.** From the same menu, `sel-verify drive click --text "列表" --exact`. The rows return.
- **Search.** `sel-verify drive click --testid corner-search`. Fill `--role searchbox` with a string that is not in any question, such as `zzzz-no-match`. Wait for the text `没有符合筛选的题`. Shot `--feature notebook --name search-empty`. `sel-verify drive click --text "取消" --exact` or the `清除筛选` button restores the list. The search box debounces. Wait for the row, not a fixed delay.
- **Subject.** `sel-verify drive click --testid subject-switch`, then the button for another subject, such as `物理`. A subject with no questions shows the first-run empty copy `拍一张批改过的卷子`, not the filter-empty copy. Switch back to `数学` and the saved question returns. Shot `--feature notebook --name subject`.
- **Chapter.** `sel-verify drive click --testid notebook-filters`, then `sel-verify drive click --text "章节" --exact`. The sheet lists `全部章节` plus chapters that appear on questions in the current subject and stage. It does not list the whole textbook. Pick one, confirm the list, then pick `全部章节` to clear it.
- **Tag.** `sel-verify drive click --testid tag-filter --optional --feature notebook --entry tag-filter`. When the subject has no knowledge tags the row is disabled and the command records a skip. That skip is the proof for an empty tag list, not a failed filter.
- **Stage filter.** `--testid stage-filter` is absent while the subject has questions in only one stage. `sel-verify drive skip --feature notebook --entry stage-filter --blocker "Only one stage is stored for this subject, so the menu does not show 学段."` Do not treat that as a failure.
- **Select and discard.** From `notebook-filters`, choose `选择`. Tap a card (`--testid item-card`), then `--testid discard-selected`, then the button `移除`. The toast says how many were removed and offers `撤销`. Click `撤销` and the question is back. Shot `--feature notebook --name discard` and `--name undo`.
- **Swipe discard.** In list view, `sel-verify drive swipe --testid item-card`, then click `移除`. The same undo toast appears. Undo it if a later step still needs the question.
- **Intake hint.** When photos are still being read, or questions were left unadded, `--testid intake-hint` is visible and opens `/s/new`.
- **Load error.** `sel-verify drive skip --feature notebook --entry load-error --blocker "This fixture has no fault switch for a failed notebook request."`
- **Proof.** After a discard that you do not undo, `sel-verify drive reload` and confirm the question is gone. After undo, reload and confirm it is back.

## Gotchas

- The first load may show `--testid home-skeleton` (four rows) before the empty state or the saved grid. Do not treat the skeleton as the settled view.
- A refresh that already has data keeps the old list. The skeleton is only for the first load.
- `选择` is disabled when there are no rows.
- A disabled `知识点` row does not close the filter menu. Choose another row, such as `列表`, to dismiss it. Escape does not.
- Swipe-to-remove is list-only. Grid uses select mode or the detail screen.
- `没有符合筛选的题` means the current subject and stage still have questions (`total` > 0) but search, chapter, or tag hid them. `拍一张批改过的卷子` means this subject and stage have none. Switching subject to an empty subject uses the second sentence.
- `sel-verify drive swipe` drags the row. If the option stays hidden, it opens `ion-item-sliding` the way `tests/e2e/intakeDelete.spec.ts` does, and the log says which one happened.
