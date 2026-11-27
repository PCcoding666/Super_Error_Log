# Choose stage

A new account must choose `初中` or `高中` before the notebook loads. Later changes happen in Settings. The choice is the default stage for newly captured questions.

## Sub-features

- `stage-required` shows the gate instead of the notebook when no stage has been saved.
- `stage-choose-junior` saves `初中` and continues to the notebook.
- `stage-choose-senior` saves `高中` and continues to the notebook.
- `stage-error` leaves the gate visible when the save fails.
- `stage-already-set` does not show the gate again after a stage exists.
- `stage-api-gate` is the Ionic gate, used when a signed-in shell receives `stage_required` instead of the server page.

## How to get to it (user POV)

- After the first successful login or registration, opening the notebook when the account has no stage. There is no menu entry. The gate replaces the notebook.
- The usual first screen is the server page, heading `你现在读初中还是高中？`.
- The Ionic gate, heading `你在读哪个学段？`, appears when the app shell is already open and the API answers `409 stage_required`. A normal first login does not take that path.

## Driving it with sel-verify

Preconditions:

- `sel-verify doctor` is ok.
- The session belongs to an account that has not chosen a stage. `sel-verify drive secret --slot student` on a fresh launch is such an account. `expiring` is another.

- **Server gate.** After login, `sel-verify drive wait --heading "你现在读初中还是高中？" --timeout 60000`. `sel-verify drive wait --testid stage-choice`. The two buttons are `初中` and `高中`. Shot `--feature choose-stage --name gate --entry server-page`.
- **Choose junior.** `sel-verify drive click --role button --name "初中" --exact`. Wait for `--testid empty-notebook` or `--testid item-card` (`--timeout 60000`). The gate heading is gone.
- **Choose senior.** On a different new account (`expiring`, in a fresh session), click `高中` with `--exact`. The notebook appears. Settings later shows `高中` on `--testid student-grade`.
- **Already set.** `sel-verify drive reload`. The gate heading is not visible, and the notebook is.
- **Ionic gate.** `sel-verify drive skip --feature choose-stage --entry ionic-gate --blocker "The first login renders the server page stage-choice, not data-testid stage-gate. The Ionic gate only replaces the shell after a stage_required API response."`
- **Proof.** Open `/s/me` and confirm `--testid student-grade` shows the chosen stage. Shot `--feature choose-stage --name notebook`.

## Gotchas

- The heading splits `初中` and `高中` so each word stays on one line. A wrapped word on a 320-wide screen is a failure of this gate. The default 390-wide session does not prove the 320-wide case.
- Use `--exact` on the stage button. The heading contains the same two words.
- The buttons submit once. Do not double-click and race two choices.
- A later change in Settings is not proof that this first-run gate worked.
- Notebook filters and capture are not a valid skip for the gate. The gate is the entry point until a stage is saved.
