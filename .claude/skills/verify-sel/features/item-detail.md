# Question detail

Question detail at `/s/q/:id` is one saved question: its photo, the recognized text, the student's writing and marks, the chapter, the answer, and the student's remark.

## Sub-features

- `item-open` opens the question from the notebook or from intake.
- `item-photo` opens the photo and returns with the back control.
- `item-edit-stem` corrects recognized question text.
- `item-traces` opens `你写的` or `批改痕迹` and can correct a trace.
- `item-category` edits stage, subject, and chapter.
- `item-solution` opens the answer and solution, and can retry a failed solution.
- `item-answer-photo` adds a photographed answer.
- `item-remark` autosaves a typed remark. Voice can append text when the browser can record.
- `item-discard` removes the question after confirmation and leaves this screen.
- `item-material-source` opens the materials page when this question came from a capture.

## How to get to it (user POV)

- In the notebook, tap a list row or a grid card.
- In intake, tap a question that was already added.
- The `…` menu, the chapter row, `查看答案和解题过程`, and `不是错题，移除` stay on this question.
- `查看材料与批改来源` in the `…` menu leaves this screen for the source page. It is absent when the question has no material source.

## Driving it with sel-verify

Preconditions:

- A saved question exists. On this fixture, add the mock `1 + 1` candidate from [Intake](./intake.md) first.
- `sel-verify doctor` is ok. Solutions are mock. They can sit on `稍后就好` and then become ready. Wait for the ready text. Do not treat a short look as failure.

- **From the list.** In list view, `sel-verify drive click --testid item-card`. Wait `--url /s/q/*` and `--testid question-text`. Shot `--feature item-detail --name from-list --entry notebook-list`.
- **From the grid.** Switch to 网格, then click `--testid item-card` again. Shot `--feature item-detail --name from-grid --entry notebook-grid`.
- **From intake.** `sel-verify drive click --testid intake-question`. Shot `--feature item-detail --name from-intake --entry intake-question`.
- **Back.** `sel-verify drive click --testid back-link` returns to the previous screen, which is intake when that is where you came from and the notebook when you came from the notebook.
- **Photo.** `sel-verify drive click --testid item-photo`. Wait for `--testid photo-viewer`. `sel-verify drive click --testid photo-back`. The same question is still showing. The note `--testid item-photo-note` says the picture is the whole page the student shot.
- **Stem.** `sel-verify drive click --testid stem-edit` when it is visible (`识别错了？改`). The sheet is `--testid text-edit`. Fill `--testid text-edit-input`, then `sel-verify drive click --testid text-edit-save`. Wait for the toast `改好了，AI 会按新的内容重新解`. `sel-verify drive reload` and confirm `--testid question-text` still has the new text. `取消` closes the sheet without saving.
- **Traces.** `sel-verify drive click --testid item-work` when the row is a button. Wait for `--testid trace-sheet`. `--testid trace-edit` opens the same text editor when the row can be edited. `sel-verify drive press --key Escape` dismisses the sheet. `--testid item-marking` reads `没识别到` and is not a button when the page had no mark. The mock page has student writing and no teacher mark, so work opens and marking does not.
- **Category.** `sel-verify drive click --testid item-chapter`, or open `--testid item-more` and click `修改分类`. The sheet title is `修改分类`. `取消` leaves the values unchanged. Saving updates `--testid item-category` and the chapter title. The chapter picker `--testid chapter-picker` lists catalog chapters for the chosen stage and subject. That list is wider than the notebook's chapter filter.
- **Solution.** `sel-verify drive click --testid item-answer`. Wait for `--testid solution-sheet`. The mock answer contains `Synthetic reference answer`. Close with `--testid solution-close`. A failed retryable solution shows `--testid insight-retry`. This fixture's mock solution becomes ready; do not require the retry button.
- **Answer photo.** `sel-verify drive files --testid answer-photo-input`. Wait for the toast `答案照片收到了，稍后识别好`. The row `--testid answer-photo-add` is the visible control `拍照录入答案`. The input itself is hidden.
- **Remark.** Fill `--testid item-remark` (placeholder `错在哪？下次注意什么？`). Wait for `--testid remark-status` to read `已保存`. Reload and confirm the text is still there.
- **Voice.** `sel-verify drive skip --feature item-detail --entry voice --blocker "The default browser does not grant a microphone. A visible 按一下说 button (--testid voice-button) cannot produce a transcript here. If the button is absent, the browser cannot record, which is also a skip."`
- **Discard.** `sel-verify drive click --testid discard`, or the same item in `--testid item-more`, then the button `移除`. The previous screen returns and the question is gone from the notebook. Undo is offered on the notebook, not on this screen.
- **Material source.** `sel-verify drive click --testid item-more`, then click the text `查看材料与批改来源` when it is visible. The URL contains `/s/materials/questions/`. Shot `--feature item-detail --name material-source --entry more-menu`. `sel-verify drive back` returns to the question. If the menu item is absent, record a skip: the question has no material source.
- **Load error.** The first paint may be `--testid item-skeleton` with accessible name `正在加载题目`. If the request fails, the error block replaces it. `sel-verify drive skip --feature item-detail --entry load-error --blocker "This fixture has no fault switch for a failed detail request."`

## Gotchas

- Do not read the chapter title while the skeleton is visible.
- `稍后就好` means the solution is queued or generating. Wait again or reopen the sheet. It is not the failure state.
- Saving recognized text or an answer photo queues the solution again. Prove the new text first.
- The remark waits about a second after typing, and also saves on blur. `drive fill` fires that path. Do not assert `已保存` in the same instant as the first keystroke; wait for the status.
- Discard's confirmation says the original photo is kept and the notebook can undo. This screen is gone after a successful remove.
- Back returns to the previous screen, not always to `/s/`.
