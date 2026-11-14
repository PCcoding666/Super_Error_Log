# My invite code

My invite code at `/s/account` shows the code used on this phone, can copy it or a login link, shows a QR code for another phone, and can replace the code or set a recovery PIN.

## Sub-features

- `account-view` shows the current code when this phone is allowed to see it.
- `account-copy` copies the invite code and, when present, the login link.
- `account-qr` shows a login QR and link for another phone.
- `account-regenerate` replaces the code. The old code stops working. The learning record stays.
- `account-recovery-pin` sets or replaces the 4-digit recovery PIN when this account has recovery.
- `account-unavailable` explains when this phone cannot see the current code, and still offers regeneration.

## How to get to it (user POV)

- In Settings (`/s/me`), choose `我的邀请码`.
- There is no public URL that shows the live code before login.

## Driving it with sel-verify

Preconditions:

- The student is signed in through this fixture. Open the page from Settings so the session cookie is sent.
- Do not shot the code, and do not paste it into a PR. Prove the page with headings and test ids whose text you do not attach.

- **Open.** From `/s/me`, `sel-verify drive click --testid settings-my-invite`. Wait for heading `我的邀请码`.
- **View.** When the phone may see the code, `--testid my-invite-code` is present. `sel-verify drive text --testid my-invite-code` records it in the local evidence log. Do not commit that log.
- **Copy.** The button `复制邀请码` starts hidden and is shown by `/s/account-copy.js`. Its test id is the code element's id with `-copy` appended, so it is not a separate string in the source. Press it by the accessible name. A missing button does not mean the code is missing: the code element can still be selected.
- **QR and link.** `--testid my-invite-qr` is the QR image (accessible name `登录链接二维码`). `--testid my-invite-link` is the URL. `复制链接` is `--testid my-invite-link-copy`, also hidden until the script runs. A new phone still has to tap `进入我的错题本`. Prove that with `sel-verify drive open-slot` only for a slot you mean to spend, not by copying a code into a command.
- **Regenerate.** `sel-verify drive click --role button --name "重新生成邀请码"`. Wait for the text `已经换成新邀请码`. The previous code then fails login with `这个邀请码进不去`. The new code works. This burns the code for every other session. Do it on a disposable account, not on a slot a later step in the same run still needs.
- **Recovery PIN.** Pre-seeded fixture students have no recovery block. After a real registration in this run, `--testid recovery-pin` is visible. Submit a 4-digit PIN that is not `1234` or `0000` with the button `保存找回码`. The toast says `找回码已保存。` A weak PIN stays on the form with an error.
- **Unavailable.** After the code is expired or was replaced on another device, `--testid invite-code-unavailable` explains that this phone cannot see the old code. Regeneration is still offered.
- **Expiring.** Sign in with `--slot expiring`. Settings shows `快到期`, and this page shows `--testid invite-expiring`.

## Gotchas

- The back control on this page goes to `/s/settings` (the leftover server page), not to `/s/me`. Landing there is not a failure to open My invite code, and it is not proof of the current Settings feature.
- The full code is only shown on a phone that logged in with it.
- Regenerating revokes the old code immediately, including on other devices.
- Do not regenerate against a shared or production account. This fixture's students are synthetic, and the evidence log still must not be committed.
