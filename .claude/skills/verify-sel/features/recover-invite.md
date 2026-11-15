# Recover invite code

Recover replaces a forgotten invite code. The student enters the name, phone number, and 4-digit PIN from registration. The learning record stays. The old code stops working.

## Sub-features

- `recover-open` opens the form from login and from a duplicate-registration prompt.
- `recover-success` shows a new code on `找回成功`.
- `recover-old-code-revoked` rejects the previous code.
- `recover-mismatch` shows a generic failure when the name, phone, or PIN do not match.
- `recover-lockout` blocks further tries after too many mismatches.

## How to get to it (user POV)

- On the login page, choose `忘了邀请码？找回`.
- Open `/s/recover` directly.
- After a duplicate registration, choose `用找回码找回邀请码`.
- The public help page links here. This fixture does not serve `/help/`.

## Driving it with sel-verify

Preconditions:

- `sel-verify doctor` is ok.
- An account was registered in this same server with a known name, phone, and PIN. The pre-seeded fixture students cannot recover: they never set a PIN.
- You still know the code that was showing on `注册成功`. Keep it inside the process. Do not write it into the evidence log.

- **Open from login.** `sel-verify drive open /s/` then `sel-verify drive click --testid recover-link`. The link name is `忘了邀请码？找回`. `sel-verify drive wait --heading "找回邀请码"`.
- **Open directly.** `sel-verify drive open /s/recover` then wait for that heading.
- **Open from duplicate registration.** Follow [Register](./register.md) until the duplicate link appears, then `sel-verify drive click --role link --name "用找回码找回邀请码"`.
- **Match.** `sel-verify drive fill --label "学生姓名（和注册时一样）" --text "合成浏览器学生"`, `sel-verify drive fill --label "手机号" --exact --text "+65 8765 4321"`, `sel-verify drive fill --label "找回码（4 位数字）" --text "2580"`, then `sel-verify drive click --role button --name "找回邀请码"`. Wait for heading `找回成功` and `--testid registered-invite-code`. The new code is not the old one. Shot `--feature recover --name success` and do not attach it to a PR.
- **New code works.** `sel-verify drive click --role button --name "我已保存，进入错题本"`. The same student's stage gate or notebook opens.
- **Old code fails.** Log out, then submit the previous code. The text `这个邀请码进不去` appears.
- **Mismatch.** Submit a wrong PIN. The page says it could not recover and does not name the bad field. The old code still works until a recover succeeds.
- **Help page.** `sel-verify drive skip --feature recover --entry help-page --blocker "The verification server only mounts /s."`

## Gotchas

- Accounts that never set a PIN cannot use this form. That includes every student `sel-verify launch` pre-seeds. Register one in the same run first.
- Five mismatches lock the attempt for 24 hours on that network. Do not hunt for the PIN.
- Mismatch copy stays generic. Do not assert which field failed.
- The spaced phone number `+65 8765 4321` must still match a registration stored as `+6587654321`.
