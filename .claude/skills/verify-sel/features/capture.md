# Capture photos

Capture starts an intake batch from the camera or the album. On the materials path the first tap asks whether this time is 单页 or 多页. 单页 uploads immediately. 多页 stays on the page in a tray until `完成`.

## Sub-features

- `capture-entry-home` starts from the notebook corner controls, and from the empty-notebook actions.
- `capture-entry-intake` starts from the intake footer.
- `capture-choose-mode` asks 单页 or 多页 after the camera or album tap, then the file comes from that choice.
- `capture-single` uploads the chosen file and goes to intake.
- `capture-multi-tray` keeps pages on the current screen, can tag a page as 试卷 or 答题卡, can delete a page, and can discard the set.
- `capture-multi-finish` uploads the tray and goes to intake.
- `capture-cancel-sheet` dismisses the sheet without a file.
- `capture-blocked` explains when this window cannot open the system camera or album.

## How to get to it (user POV)

- On the notebook, including the empty notebook, use the bottom-corner camera or album buttons.
- On an empty notebook, also choose `去拍照` or `从相册选择` in the empty state.
- On intake, choose the footer `拍照` or `从相册选择`.
- After choosing 单页 or 多页, that same control is the file input. A real phone opens the camera or album from that tap. This harness attaches a synthetic JPEG instead of a camera.

## Driving it with sel-verify

Preconditions:

- The student is signed in, has a stage, and is on `/s/` or `/s/new`.
- `sel-verify doctor` reports `materialCapture: true`. If it does not, this is the legacy path: do not assert the sheet.
- `sel-verify drive files` attaches a generated JPEG. Do not use a real photo.

- **Empty-state album.** `sel-verify drive click --testid capture-album`. Wait for `--testid capture-mode-sheet` and heading `怎么从相册选`. Shot `--feature capture --name sheet-empty-album --entry empty-album`.
- **Empty-state camera.** `sel-verify drive click --testid capture-camera`. The heading is `怎么拍照`. Shot `--feature capture --name sheet-empty-camera --entry empty-camera`.
- **Corner album.** `sel-verify drive click --testid next-step-primary`. The accessible name is `从相册选择`. The same sheet opens. This control is on the empty notebook as well as a populated one. Shot `--feature capture --name sheet-corner-album --entry corner-album`.
- **Corner camera.** `sel-verify drive click --testid capture-fab-camera`. The accessible name is `拍照`. Shot `--feature capture --name sheet-corner-camera --entry corner-camera`.
- **Cancel.** `sel-verify drive click --testid capture-mode-cancel`. Wait `--testid capture-mode-sheet --state hidden`. The URL does not change. No new intake photo appears.
- **Single page.** Open the sheet, then `sel-verify drive files --testid capture-mode-single`. Wait `--url /s/new`. The new photo appears in intake. Shot `--feature capture --name single-arrived --entry single`.
- **Multi-page tray.** Open the sheet, then `sel-verify drive files --testid capture-mode-multi`. Stay on the same page. Wait for `--testid capture-tray` and the text `已拍 1 张` (`--testid capture-count`). Shot `--feature capture --name tray --entry multi`.
- **Tag and delete.** On a tray page, click the button `试卷` or `答题卡`. `sel-verify drive click --testid capture-page-delete` removes that page. A second page, while the tray is open, is attached with `sel-verify drive files --testid capture-fab-camera` or `--testid next-step-primary`: those controls are file inputs again, not a new sheet.
- **Finish.** `sel-verify drive click --testid capture-set-done`. The URL is `/s/new` and intake shows the uploaded pages.
- **Discard.** `sel-verify drive click --testid capture-set-discard`. The tray is gone and intake does not gain those pages.
- **Intake footer.** On `/s/new`, `--testid intake-camera` and `--testid intake-album` open the same sheet. Shot `--feature capture --name sheet-intake-camera --entry intake-camera` and `--name sheet-intake-album --entry intake-album`.
- **Blocked chooser.** `sel-verify drive profile --name android` (or a script op `profile` with `name` `android`) switches this same login onto the Android shell user agent. Open the album sheet, then `sel-verify drive tap-file --testid capture-mode-single` so the file dialog opens and no file is chosen. Within about two seconds the toast says `打不开相册`. `知道了` dismisses it. The default iPhone profile does not show this toast.

## Gotchas

- The 单页 / 多页 choice is the next tap. The idle dock has no mode bar. Do not fail because `--testid capture-mode-bar` is absent before a tray exists.
- `--testid capture-mode-single` and `--testid capture-mode-multi` are file labels inside the sheet, and plain buttons on the mode bar once a tray is open. `drive files` must hit the sheet's file input. Attaching a file to the mode-bar button fails with "no file input".
- A file chosen before the materials route is known stays 单页 even if a saved preference says 多页.
- While a tray is open and the mode is 单页, further camera and album taps are held. `--testid capture-mode-hold` says to finish or discard first.
- The tray caps the set. Overflow copy is `一次最多 8 页` (`--testid capture-overflow`).
- Legacy capture (`npm run web:fake`, or this fixture without materials capture) skips the sheet and uploads immediately. Doctor must say `materialCapture: true` before these steps.
- Do not script a click on a hidden file input to open the sheet. The sheet's options are the file labels. `drive files` sets the file on that label.
