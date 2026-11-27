# Log in

Log in exchanges a 12-character invite code for a session and opens that student's notebook. A link or QR that already contains the code still requires `进入我的错题本`. Loading the page does not log anyone in.

## Sub-features

- `login-form` signs in from an empty login form.
- `login-prefill` signs in from a link that already filled the code.
- `login-reject` shows the same failure for a wrong, expired, or revoked code.
- `login-switch` warns when this phone already has a different account, then switches after submit.
- `login-repeat` lets a valid code be used again within its 60-day window.

## How to get to it (user POV)

- Open `/s/` or `/s/login` and enter the invite code, then choose `进入我的错题本`. `/s/login` redirects to `/s/`.
- Open a link or QR whose query already has the code (`/s/?code=…`). The field is filled. The student still taps `进入我的错题本`.
- Choose `开始使用` on the public help page. That page is not served by this fixture.
- After registration or recovery, `我已保存，进入错题本` signs in with the new code.
- After log out, the same login form is shown again.

## Driving it with sel-verify

Preconditions:

- `sel-verify doctor` is ok.
- Launch names the slots `student`, `admin`, `studentExtra`, `relogin`, `expiring`, and `link`. The values stay in the instance file and are not printed.

- **Empty form.** `sel-verify drive open /s/` then `sel-verify drive wait --heading "输入邀请码"`. `sel-verify drive wait --testid login-title` and `sel-verify drive wait --testid invite-code-input`.
- **Successful login.** `sel-verify drive secret --slot student --label "12 位邀请码"` then `sel-verify drive click --role button --name "进入我的错题本"`. Wait for the stage heading `你现在读初中还是高中？` on a new account, or for `--testid empty-notebook` / `--testid item-card` when a stage already exists. The login form is gone. Shot `--feature login --name after-submit` only after the code field is gone.
- **Prefill.** `sel-verify drive open-slot --slot link`. Wait for `--testid prefill-lead`. Its text says the code came from the link and does not repeat the code. Do not shot this screen: the field shows the code. Submit `进入我的错题本`. The tap is the login. `sel-verify drive open /s/login` redirects to `/s/` and does not show a prefilled code; the prefill query is only honored on `/s/`.
- **Wrong code.** `sel-verify drive fill --label "12 位邀请码" --text "wrong"` then click `进入我的错题本`. Wait for the text `这个邀请码进不去`. The heading is still `输入邀请码`.
- **Switch accounts.** Sign in with `student`. Then open `/s/?code=` for `admin`. `--testid prefill-lead` includes the warning that this phone will switch. Submit. Settings then shows the admin account, not the first student. Use a fresh browser session (`cleanup` removes the saved session) before the second login if you need the warning from a logged-in phone; the saved session is one phone.
- **Repeat.** `studentExtra` and `relogin` are further live codes for the same student. Either one opens that student's notebook.
- **Help page.** `sel-verify drive skip --feature login --entry help-start --blocker "The verification server only mounts /s."`
- **Proof.** Reload `/s/` and confirm the session is still the notebook or the stage gate. Shot `--feature login --name notebook`.

## Gotchas

- Spaces, hyphens, and letter case in the code are ignored. Assert that login succeeded, not the exact characters left in the field.
- Failure copy is generic. The page does not say whether the code is unknown, expired, or revoked.
- A GET of `/s/?code=…` must not create a session. Doctor and a fresh context still show the login form after opening that URL, until the button is pressed.
- `试得太频繁了` is rate limiting. Do not loop failed logins.
- There is no pairing-link control port on this server. Port 3197 belongs to `npm run web:fake`, which is not this fixture.
- Do not put a code, or a screenshot of a filled code field, in the PR.
