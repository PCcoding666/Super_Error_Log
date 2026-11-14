# Settings

Settings at `/s/me` shows the stage, a practice placeholder, add to Home Screen, My invite code, and log out.

## Sub-features

- `settings-open` opens the page from the notebook.
- `settings-stage` changes 学段 and confirms with a toast.
- `settings-practice-placeholder` shows 练习 as `即将推出` and does not navigate.
- `settings-install` opens the Add to Home Screen instructions.
- `settings-account` opens My invite code when the account has an invitation.
- `settings-logout` ends the session and returns to the login form.
- `settings-error` shows a retryable load error.

## How to get to it (user POV)

- On the notebook, choose the settings control in the top corner.
- There is no other current entry. The back control on My invite code goes to the leftover page `/s/settings`, not back here.

## Driving it with sel-verify

Preconditions:

- The student is signed in, has a stage, and can open the notebook.
- Invitation rows exist on this fixture. `sel-verify doctor` is ok.

- **Open.** `sel-verify drive click --testid settings-link`. Wait `--url /s/me` and heading `设置`. The accessible name of the control is `设置`. Shot `--feature settings --name me --entry notebook`. The version line contains `超级错题本`.
- **Stage.** `--testid student-grade` is the 学段 control. Pick the other stage in the action sheet. Wait for the toast `学段已更新`. Reopen Settings and confirm the value. New questions use that stage.
- **Practice.** The 练习 row is visible and the trailing note is `即将推出`. It is not a link. Tapping it does not open another route. Do not open `/s/practices` as proof of this row.
- **Install.** `sel-verify drive click --testid settings-install`. The URL is `/s/install`.
- **My invite code.** `sel-verify drive click --testid settings-my-invite`. The URL is `/s/account`. The `expiring` slot's account shows `快到期` on this row.
- **Identity.** `--testid account-role` is visible on this fixture. The pre-seeded `student` slot reads as a student. The `admin` slot shows the admin label. The label is not a permission.
- **Log out.** `sel-verify drive click --testid logout`. Wait for heading `输入邀请码`. `sel-verify drive open /s/me` shows that same login form.
- **Back.** `sel-verify drive click --testid back-link` returns to the notebook at `/s/`.
- **Load error.** `sel-verify drive skip --feature settings --entry load-error --blocker "This fixture has no fault switch for a failed settings request."`

## Gotchas

- `/s/me` is the current Settings page. `/s/settings` is the leftover server page. A recipe that starts from the notebook gear must end on `/s/me`.
- This page does not show a static `服务 已连接` row. A short `已连接 ✓` toast can appear on the notebook right after login. That toast is not a Settings row.
- Group headers are `学习`, `应用`, and `账号`.
- 练习 is a placeholder. Leftover practice routes are not this feature.
- Log out posts a form. Wait for the login heading rather than asserting the URL in the same instant as the click.
