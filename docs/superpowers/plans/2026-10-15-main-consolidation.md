# Main Branch Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. User explicitly authorized this migration and preservation on 2026-10-15.

**Goal:** One authoritative main with unchanged deployed student functionality; preserve every unmerged commit and local artifact.

**Architecture:** Prepare from origin/codex/ai-error-review-mvp (5108b77), merge the design-only branch without changing its source files, migrate release guards to main, pass PR checks, switch the production branch policy, merge, then verify the main release before removing old refs. Keep web-quality-r2 separate.

**Tech Stack:** Git, GitHub Actions/environments, SSH/systemd; existing Node 24 app.

**Spec:** User-approved branch audit and cleanup sequence, 2026-10-15.

## Global Constraints
- No force-push or rewriting commit history; no changes to student data, secrets or model configuration.
- Do not merge feat/web-quality-r2 into the release. Preserve it remotely and locally.
- Archive all workspaces including ignored/untracked files, verify archive coverage and Git bundle before removal.
- Main becomes the only push deployment trigger and environment-allowed branch.
- Old worktree directories are moved to a private archive, not erased. Managed worktree uses the app archive after a complete filesystem backup.

## Review Focus
- Exact branch consistency across ci.yml, deploy.yml, publish.sh, production policy, protections and handoff.
- Preserve all 27 R2 commits and both design files; verify object IDs and bytes.
- Do not delete an active worktree or a symlink target before moving its dependents.
- CI success is not deployed success; compare the live manifest to final main.
- Keep private configuration, data and process logs outside GitHub.

### Task 1: Preserve
- [ ] Full filesystem tar and --all Git bundle, hashes, remote refs, repository settings, worktree inventory.
- [ ] Upload feat/web-quality-r2 with its proper upstream and save old main/production tags.

### Task 2: Prepare canonical branch
- [ ] Create codex/unify-main from current integration; merge design/student-ui-redesign.
- [ ] Change .github/workflows/ci.yml, deploy.yml and deploy/ci/publish.sh to main only.
- [ ] Update AGENTS.md, README.md, docs/CODEX_CLOUD_HANDOFF.md, docs/ci.md, deploy/ci/README.md; add branch guide and historical-design notice.
- [ ] Check actionlint, shellcheck, deployment-script tests, Git diff and a fresh independent review.

### Task 3: Activate main
- [ ] Push migration PR to main and wait for existing full CI.
- [ ] Copy existing integration protection to main; allow only main in production environment; retain old refs until success.
- [ ] Merge with full history; verify main push CI/deployment and server health/release manifest.

### Task 4: Clean and record
- [ ] Create draft PR for R2 to main, explicitly not release-ready; do not merge it.
- [ ] Move completed manual worktrees to private snapshots; archive managed worktree; fix dependency symlink before cleanup.
- [ ] Only delete refs verified ancestors of main; remove stale worktree registrations; update primary directory to main.
- [ ] Final remote/local refs, clean status, backup recovery guide and completed ledger; report remaining branches and deployed commit.
