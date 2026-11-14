# Register

Register lets a new student create an account with a name, a phone number, and a 4-digit recovery PIN, then shows a 12-character invite code once and enters the notebook.

## Sub-features

- `register-open` opens the registration form from each listed entry point.
- `register-submit` creates the account and shows the invite code on the success screen.
- `register-save-and-enter` confirms the code was saved and enters the notebook or the stage gate.
- `register-cancel` returns to invite login without creating an account.
- `register-duplicate` sends an already-registered name and phone to recovery instead of a second notebook.
- `register-reject-weak-pin` refuses `1234` and `0000`.

## How to get to it (user POV)

- On the login page, choose `首次使用，注册账号`.
- Open `/s/register` directly.
- From the recover page, choose `还没注册过？注册账号`.
- The public help page also links here. This fixture does not serve `/help/`.

## Driving it with sel-verify

Preconditions:

- `sel-verify doctor` is ok.
- The fixture does not ask for a class registration code.
- Use a name and phone that this run has not registered. The pre-seeded fixture students have no name or phone.

- **Open from login.** `sel-verify drive open /s/` then `sel-verify drive click --role link --name "首次使用，注册账号"`. `sel-verify drive wait --heading "注册账号"` is visible.
- **Open from recover.** `sel-verify drive open /s/recover` then `sel-verify drive click --role link --name "还没注册过？注册账号"`. The same heading is visible.
- **Open directly.** `sel-verify drive open /s/register` then `sel-verify drive wait --heading "注册账号"`.
- **Submit.** `sel-verify drive fill --label "学生姓名（可以写化名）" --text "合成浏览器学生"`, `sel-verify drive fill --label "手机号" --exact --text "+6587654321"`, `sel-verify drive fill --label "设一个找回码（4 位数字）" --text "2580"`, then `sel-verify drive click --role button --name "注册并生成邀请码"`. `sel-verify drive wait --heading "注册成功"`. `sel-verify drive wait --testid registered-invite-code` shows a code. Shot `artifacts/verify-sel/evidence/register/success.png` with `--feature register --name success`. Do not copy the code into the PR.
- **Enter.** `sel-verify drive click --role button --name "我已保存，进入错题本"`. The next screen is the stage gate or the notebook, not the login form.
- **Return without registering.** From the form, `sel-verify drive click --role link --name "已有邀请码，直接登录"` or the back control `邀请码登录` (`--testid back-link`). The heading is `输入邀请码`.
- **Duplicate.** Submit the same name and phone again. A link named `用找回码找回邀请码` is visible, and the success heading does not appear.
- **Weak PIN.** Submit `1234`. The heading stays `注册账号`, and the PIN field shows an error. The same for `0000`.
- **Help page.** `sel-verify drive skip --feature register --entry help-page --blocker "The verification server only mounts /s. /help/ is not on this fixture."`

## Gotchas

- The full code is shown on `注册成功` only. A later visit to Settings is not proof that this screen showed it.
- Phone numbers are not SMS-verified. `+65 8765 4321` is the same number as `+6587654321` for later recovery.
- If a server requires a class code, the field `注册码（8 位，老师发的）` appears (`--testid registration-code-input`). The baseline fixture does not show it. Do not fail the baseline recipe for its absence.
- A name may be a nickname. Do not register against production.
