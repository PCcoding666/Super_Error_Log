# Capture photos

Capture starts an intake batch from one 新增 action. On the materials path that tap opens a sheet. The student picks 单页 or 多页, then 开始 opens the system camera or album. 单页 uploads immediately. 多页 stays on the page in a tray until `完成`. iPhone and Android use the same entry.

## Sub-features

- `capture-entry-home` starts from 新增 on an empty notebook, and from the corner 新增 once the notebook has questions.
- `capture-entry-intake` starts from the intake footer 新增.
- `capture-choose-mode` asks 单页 or 多页 in the sheet. Those controls are not file inputs. 开始 is the file input.
- `capture-single` uploads the chosen file and goes to intake.
- `capture-multi-tray` keeps pages on the current screen, can tag a page as 试卷 or 答题卡, can delete a page, and can discard the set.
- `capture-multi-finish` uploads the tray and goes to intake.
- `capture-cancel-sheet` dismisses the sheet without a file.
- `capture-blocked` explains when this window cannot open the system camera or album.

## How to get to it (user POV)

- On an empty notebook, choose `新增` in the empty state. The corner does not repeat it.
- On a notebook that already has questions, choose the corner `新增`.
- On intake, choose the footer `新增`.
- The sheet's 单页 and 多页 only change the mode. 开始 is the file input. A real phone opens the camera or album from that tap. This harness attaches a synthetic JPEG instead of a camera.

## Driving it with sel-verify

Preconditions:

- The student is signed in, has a stage, and is on `/s/` or `/s/new`.
- `sel-verify doctor` reports `materialCapture: true`. If it does not, this is the legacy path: do not assert the sheet.
- `sel-verify drive files` attaches a generated JPEG. Do not use a real photo.

- **Open the sheet.** `sel-verify drive click --testid capture-add`. The accessible name is `新增`. Wait for `--testid capture-mode-sheet`. Shot `--feature capture --name sheet --entry add`.
- **Switch mode.** `sel-verify drive click --testid capture-mode-multi` or `--testid capture-mode-single`. That click does not open a file dialog. Shot `--feature capture --name sheet-multi --entry multi`.
- **Cancel.** `sel-verify drive click --testid capture-mode-cancel`. Wait `--testid capture-mode-sheet --state hidden`. The URL does not change. No new intake photo appears.
- **Single page.** Open the sheet, click `--testid capture-mode-single`, then `sel-verify drive files --testid capture-start`. Wait `--url /s/new`. The new photo appears in intake. Shot `--feature capture --name single-arrived --entry single`.
- **Multi-page tray.** Open the sheet, click `--testid capture-mode-multi`, then `sel-verify drive files --testid capture-start`. Stay on the same page. Wait for `--testid capture-tray` and the text `已拍 1 张` (`--testid capture-count`). Shot `--feature capture --name tray --entry multi`.
- **Tag and delete.** On a tray page, click the button `试卷` or `答题卡`. `sel-verify drive click --testid capture-page-delete` removes that page. A second page, while the tray is open, is attached with `sel-verify drive files --testid capture-add`: that control is a file input again, not a new sheet.
- **Finish.** `sel-verify drive click --testid capture-set-done`. The URL is `/s/new` and intake shows the uploaded pages.
- **Discard.** `sel-verify drive click --testid capture-set-discard`. The tray is gone and intake does not gain those pages.
- **Intake footer.** On `/s/new`, `--testid capture-add` opens the same sheet. Shot `--feature capture --name sheet-intake --entry intake`.
- **Blocked chooser.** `sel-verify drive profile --name android` (or a script op `profile` with `name` `android`) switches this same login onto the Android shell user agent. On the legacy path, `sel-verify drive tap-file --testid capture-add` opens the file dialog and no file is chosen. Within about two seconds the toast says `打不开相册`. `知道了` dismisses it. The default profile does not show this toast.

## Gotchas

- The idle page has no mode bar. Do not fail because `--testid capture-mode-bar` is absent before a tray exists. The bar is on the sheet, and again on an open tray.
- `--testid capture-mode-single` and `--testid capture-mode-multi` are plain buttons. `drive files` must hit `--testid capture-start` while the sheet is open, or `--testid capture-add` once a multi-page tray is open. Attaching a file to a mode button fails with "no file input".
- A file chosen before the materials route is known stays 单页 even if a saved preference says 多页.
- While a tray is open and the mode is 单页, 新增 is held. `--testid capture-mode-hold` says to finish or discard first. The mode pill stays on that tray.
- The tray caps the set. Overflow copy is `一次最多 8 页` (`--testid capture-overflow`).
- Legacy capture (`npm run web:fake`, or this fixture without materials capture) skips the sheet. `--testid capture-add` is already the file input and uploads immediately. Doctor must say `materialCapture: true` before the sheet steps.
- Do not script a click on a hidden file input. 开始 is a real-sized file label. `drive files` sets the file on that label.
