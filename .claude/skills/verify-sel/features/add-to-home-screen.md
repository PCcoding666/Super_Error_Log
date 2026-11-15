# Add to Home Screen

Add to Home Screen is the instruction page at `/s/install`. It tells the student how to put 错题本 on the phone's Home Screen from Safari or from an Android browser.

## Sub-features

- `install-open` opens the instructions from Settings.
- `install-ios` describes Safari's Share, then Add to Home Screen path.
- `install-android` describes the browser menu path, and that the icon should open in the browser so the camera and album work.

## How to get to it (user POV)

- In Settings, choose `添加到主屏幕`.
- Open `/s/install` directly while signed in.
- The public help page describes the same steps. This fixture does not serve `/help/`.

## Driving it with sel-verify

Preconditions:

- The student is signed in and `/s/me` opens.

- **From Settings.** `sel-verify drive click --testid settings-install`. Wait `--url /s/install` and heading `放到主屏幕`. Shot `--feature add-to-home-screen --name page --entry settings`. The product name `错题本` is in the steps.
- **Direct.** `sel-verify drive open /s/install`. The same heading is visible. Shot `--feature add-to-home-screen --name direct --entry direct-url`.
- **iPhone steps.** `--testid install-ios` contains Safari, `添加到主屏幕`, and the icon name `错题本`.
- **Android steps.** `--testid install-android` contains Chrome or the phone's browser, `添加到主屏幕`, and that the icon opens a browser page so the camera and album work.
- **Help page.** `sel-verify drive skip --feature add-to-home-screen --entry help-page --blocker "The verification server only mounts /s. The public help page is a separate entry on the full server."`

## Gotchas

- This page is instructions. Playwright will not show a system install prompt. Do not wait for one.
- A Home Screen icon that cannot open the camera or album is the capture blocked toast, not a failure of this page.
- The page title in the header is `放到主屏幕`. Settings calls the row `添加到主屏幕`. Both are this feature.
- The back target of the page's primary action is `回到错题本`, which goes to `/s/`.
