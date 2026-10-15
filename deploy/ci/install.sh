#!/usr/bin/env bash
# Administrator-only bootstrap/update. Does not restart the app or read its secrets.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run as administrator'; exit 1; }
[[ $# == 1 ]] || { echo 'Usage: install.sh dedicated-public-key-file'; exit 1; }
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
public_key="$(python3 - "$1" <<'PY'
import pathlib, re, sys
value = pathlib.Path(sys.argv[1]).read_text().strip()
if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+(?: [A-Za-z0-9:@._-]+)?', value):
    raise SystemExit('Expected exactly one dedicated ed25519 public key')
print(value)
PY
)"
/usr/bin/ssh-keygen -lf "$1" >/dev/null
if ! id sel-deploy >/dev/null 2>&1; then
  /usr/sbin/useradd --system --no-create-home --home-dir /var/lib/sel-deploy --shell /bin/sh sel-deploy
fi
if ! id sel-build >/dev/null 2>&1; then
  /usr/sbin/useradd --system --no-create-home --home-dir /var/cache/sel-build --shell /sbin/nologin sel-build
fi
install -d -o root -g root -m 0755 /var/lib/sel-deploy
install -d -o root -g root -m 0755 /var/lib/sel-deploy/.ssh
install -d -o sel-build -g sel-build -m 0700 /var/cache/sel-build
install -d -o root -g root -m 0700 /var/lib/sel-ci /var/backups/super-error-log-ci
install -o root -g root -m 0755 "$script_dir/sel-ci-deploy.py" /usr/local/sbin/sel-ci-deploy
install -o root -g root -m 0755 "$script_dir/ssh-entry.sh" /usr/local/sbin/sel-ci-ssh
printf 'restrict,command="/usr/local/sbin/sel-ci-ssh" %s\n' "$public_key" > /var/lib/sel-deploy/.ssh/authorized_keys
chown root:root /var/lib/sel-deploy/.ssh/authorized_keys
chmod 0644 /var/lib/sel-deploy/.ssh/authorized_keys
sudoers="$(mktemp /etc/sudoers.d/.sel-ci-XXXXXX)"
trap 'rm -f "$sudoers"' EXIT
printf '%s\n' 'sel-deploy ALL=(root) NOPASSWD: /usr/local/sbin/sel-ci-deploy' > "$sudoers"
chmod 0440 "$sudoers"
/usr/sbin/visudo -cf "$sudoers"
mv "$sudoers" /etc/sudoers.d/sel-ci
echo 'Restricted deployment account installed. Application was not restarted.'
