#!/bin/sh
# Installed root:root 0755. authorized_keys forces this entry; no arbitrary shell.
set -eu
exec /usr/bin/sudo -n /usr/local/sbin/sel-ci-deploy "$SSH_ORIGINAL_COMMAND"
