# Intake

Intake is the batch review screen at `/s/new`. It shows pages just uploaded, questions already in the notebook, and unmarked questions the student can add.

## Sub-features

- `intake-open` opens the screen from capture, from the notebook hint, or from `/s/new`.
- `intake-progress` shows upload and “AI 正在找题” without a full-page reload.
- `intake-auto-questions` lists questions already added. The student can open one or remove it.
- `intake-pick-candidates` selects unmarked questions, or a whole page, and adds them or deletes them without adding.
- `intake-candidate-detail` opens a sheet to inspect one candidate and toggle it.
- `intake-retry` retries a failed page or a failed upload.
- `intake-day-filter` limits the list to one upload day.
- `intake-earlier` folds older pages behind `更早的 N 张` when the day filter is off.
- `intake-done` finishes the batch and returns to the notebook.

## How to get to it (user POV)

- Finish a 单页 capture, or choose `完成` on a multi-page tray.
- On the notebook, choose the hint `AI 正在找题（N 张照片）` or `照片里还有 N 道没收进错题本`.
- Open `/s/new` directly while signed in.
- The intake footer can add another page. That is a capture entry; the review stays here.

## Driving it with sel-verify

Preconditions:

- The student is signed in and has a stage.
- Review steps need a photo in this session. See [Capture photos](./capture.md).
- This fixture's mock page is one unmarked question whose text contains `1 + 1`. It waits for the student to check it. It does not appear as an already-added row until `加入 N 道`.

- **From a single capture.** After `drive files` on `capture-mode-single`, `sel-verify drive wait --url /s/new` and `sel-verify drive wait --heading "录入"`. Wait for `[data-state="needsPick"]` by `sel-verify drive wait --text "1 + 1" --timeout 45000`. Shot `--feature intake --name from-single --entry single-capture`.
- **From the tray.** `sel-verify drive click --testid capture-set-done`, then the same heading and the new photo. Shot `--feature intake --name from-tray --entry tray-done`.
- **From the hint.** On the notebook, `sel-verify drive click --testid intake-hint`. The URL is `/s/new`. Shot `--feature intake --name from-hint --entry notebook-hint`.
- **Direct.** `sel-verify drive open /s/new`. The heading is `录入`. Shot `--feature intake --name direct --entry direct-url`.
- **Add a candidate.** `sel-verify drive click --testid pick-checkbox`, then `sel-verify drive click --testid pick-submit`. The button reads `加入 1 道` when one is checked. Wait until the photo is no longer `needsPick` (`--timeout 45000`). Shot `--feature intake --name added`.
- **Open an added question.** `sel-verify drive click --testid intake-question`. The URL matches `/s/q/*`.
- **Remove an added question.** `sel-verify drive click --testid question-delete` and confirm, or `sel-verify drive swipe --testid intake-question` and click `--testid question-swipe-delete`. The question leaves the list. The photo remains.
- **Select a page.** `--testid pick-page` reads `全选本页`. Its accessible name is `全选第 N 张` or `取消全选第 N 张`.
- **Delete a candidate without adding.** `sel-verify drive click --testid candidate-delete` and confirm, or check one and `sel-verify drive click --testid candidate-delete-selected`. Those candidates leave and are not in the notebook.
- **Candidate detail.** `sel-verify drive click --testid candidate-detail`. Wait for `--testid candidate-detail-sheet`. `--testid detail-select` is the checkbox named `勾选这道题`. Toggling it does not add the question. `sel-verify drive click --testid candidate-detail-close` closes the sheet.
- **Original photo.** The thumbnail's accessible name is `查看原图`. It opens the image in a new view.
- **Day filter.** `sel-verify drive click --testid day-filter-toggle`. The date input's accessible name is `上传日期` (`--testid day-filter-date`); the visible label is `上传日`. Fill a day with no uploads, such as `2020-01-01`, and wait for `--testid day-filter-empty` (`这一天没有上传的材料`). `--testid day-filter-prev` and `--testid day-filter-next` turn pages when the day has more than one page of results. Toggle the filter off to return to the full list.
- **Retry.** `sel-verify drive skip --feature intake --entry retry --blocker "This fixture does not inject a failed upload or a failed read. There is no 再试一次 (--testid upload-retry) or 重试 row to press."`
- **Finish.** `sel-verify drive click --testid intake-done`. The URL is `/s/`. Questions that were added are on the notebook. Shot `--feature intake --name after-done`.

## Gotchas

- Checking a candidate does not add it. Proof of adding requires `加入 N 道` and a later notebook row.
- A checked candidate may still say `已选，校验通过后加入` until the read finishes. That sentence is not yet a notebook row.
- The page updates while it is busy. Wait for the photo state or the question text, not a fixed delay.
- The day filter hides the current-batch / earlier split. Do not expect `更早的 N 张` while the filter is on.
- `完成` returns home even if some pages are still being read. The notebook hint is the way back.
- `不要了` is the legacy dismiss control. This materials fixture does not show it.
