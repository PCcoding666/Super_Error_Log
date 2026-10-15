#!/usr/bin/env bash
set -euo pipefail
# Never enable shell tracing: environment contains the dedicated private SSH key.
: "${SEL_DEPLOY_HOST:?production environment host missing}"
: "${SEL_DEPLOY_KEY:?production environment key missing}"
: "${SEL_DEPLOY_KNOWN_HOSTS:?pinned host key missing}"
: "${GITHUB_SHA:?}"
: "${GITHUB_REPOSITORY:?}"
: "${GITHUB_RUN_ID:?}"
: "${GITHUB_RUN_ATTEMPT:?}"
: "${RUNNER_TEMP:?}"
: "${GITHUB_STEP_SUMMARY:?}"

[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$SEL_DEPLOY_HOST" =~ ^[a-zA-Z0-9.-]+$ ]]
run_id="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
[[ "$run_id" =~ ^[0-9]{1,16}-[0-9]{1,4}$ ]]
head_sha="$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/codex/ai-error-review-mvp" --jq .object.sha)"
if [[ "$head_sha" != "$GITHUB_SHA" ]]; then
  echo 'Newer commit is on the integration branch; skip this superseded release.'
  echo 'Skipped: a newer integration commit will run CI and deploy.' >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

key_dir="$(mktemp -d "${RUNNER_TEMP}/sel-deploy-XXXXXX")"
trap 'rm -rf "$key_dir"' EXIT
umask 077
printf '%s\n' "$SEL_DEPLOY_KEY" > "$key_dir/key"
printf '%s\n' "$SEL_DEPLOY_KNOWN_HOSTS" > "$key_dir/known_hosts"
unset SEL_DEPLOY_KEY SEL_DEPLOY_KNOWN_HOSTS
ssh_args=(-T -i "$key_dir/key" -o IdentitiesOnly=yes -o BatchMode=yes
  -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$key_dir/known_hosts"
  -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3
  "sel-deploy@${SEL_DEPLOY_HOST}")
archive="releases/super-error-log-ci-${run_id}.tar.gz"
checksum="$(sha256sum "$archive" | cut -d ' ' -f 1)"

# Submission is idempotently identified by run+attempt. If SSH drops after queuing,
# query status; do not upload again or cancel the server's independent systemd job.
if ! timeout 120 ssh "${ssh_args[@]}" "submit ${GITHUB_SHA} ${checksum} ${run_id}" < "$archive"; then
  echo 'Submission connection ended; checking whether the server accepted this run.'
fi
last_phase=''
for ((poll=0; poll<100; poll++)); do
  if status="$(timeout 30 ssh "${ssh_args[@]}" "status ${run_id}" 2>/dev/null)"; then
    phase="$(printf '%s' "$status" | python3 -c 'import json,sys; print(json.load(sys.stdin)["phase"])')"
    if [[ "$phase" != "$last_phase" ]]; then
      echo "Production: $phase"
      last_phase="$phase"
    fi
    if [[ "$phase" == succeeded ]]; then
      printf '### Production deployed\n\nCommit: %s\n\nRelease: ci-%s\n\n[Open student app](https://study.pccoding666.com/s/)\n' "$GITHUB_SHA" "$run_id" >> "$GITHUB_STEP_SUMMARY"
      exit 0
    fi
    if [[ "$phase" == failed ]]; then
      printf '%s' "$status" | python3 -c 'import json,sys; s=json.load(sys.stdin); print("Deployment failed; rollback:",s.get("rollback","unknown"))'
      echo 'Deployment failed. See restricted server status; student data and secrets are not uploaded to Actions.' >> "$GITHUB_STEP_SUMMARY"
      exit 1
    fi
  fi
  sleep 10
done
echo "Timed out waiting. The server job is independent; check status ${run_id} before retrying."
exit 1
