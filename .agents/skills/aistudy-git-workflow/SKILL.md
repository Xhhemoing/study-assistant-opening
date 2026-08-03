---
name: aistudy-git-workflow
description: Use when working in the AIstudy repository and asked to pull remote changes, prepare or create commits, merge a branch, or run the project's build and test gates before handoff or merge.
---

# AIstudy Git Workflow

This is the repository-specific workflow for safe Git synchronization and quality verification. Keep `main` deployable, preserve existing user changes, and report evidence for every gate that was actually run.

## Project Facts

- Package manager: npm. Always honor `package-lock.json`; use `npm ci` for a clean dependency install.
- Runtime: Node.js `>=20`; CI uses Node.js 22.
- Repository layout: npm workspaces under `apps/*`, `packages/*`, and `spikes/*`.
- CI workflow: `.github/workflows/ci.yml`; operational reference: `docs/operations/ci.md`.
- Local services: PostgreSQL on `5432`, an isolated E2E PostgreSQL on `5433`, Redis on `6379`, and MinIO on `9000`.
- The quality scripts call `bash scripts/run-heavy.sh`. On Windows, use WSL or Git Bash. If `bash` is unavailable, report the environment blocker instead of claiming that npm quality commands passed or silently rewriting the runner.

## Non-Negotiable Safety

1. Start every Git operation with:

   ```bash
   git status --short --branch
   git branch --show-current
   git log -1 --oneline
   ```

2. Treat existing modifications as user-owned. Inspect them and work around them; never reset, clean, discard, amend, or overwrite them without explicit authorization.
3. Do not commit `.env`, credentials, generated output, `node_modules`, `.next`, `dist`, `build`, coverage, Playwright reports, or test results.
4. Never use `git reset --hard`, `git checkout --`, `git clean`, force-push, or broad `git add -A` as a convenience.
5. Stop on an unresolved conflict, failed required gate, missing remote authentication, or unhealthy service. State the exact command and next safe action.

## Pull / Update

Use a fast-forward-only update only when the working tree is clean and the intended target branch is explicitly verified. To update `main`:

```bash
test "$(git branch --show-current)" = "main" || { echo "Switch to main before pulling" >&2; exit 1; }
git fetch origin
git pull --ff-only origin main
```

For a feature branch that must include the latest `main`:

```bash
test -n "$(git branch --show-current)" || { echo "Detached HEAD cannot be rebased" >&2; exit 1; }
git fetch origin
git rebase origin/main
```

Do not pull over uncommitted changes. Do not silently stash them. If the tree is dirty, show the paths and let the user decide whether to commit, move the work to a separate worktree, or explicitly stash it. After a pull or rebase, rerun `git status --short --branch` and inspect the resulting log.

If a conflict occurs, leave the conflict visible, list conflicted paths with `git status`, and ask for conflict-resolution input. Do not mark files resolved or continue the rebase/merge speculatively.

## Commit

Before creating a commit:

1. Identify the requested scope and inspect `git diff` and `git diff --stat`.
2. Run `git diff --check`.
3. Run the narrowest relevant test first, then the full required gates when the change affects shared code, CI, database behavior, or browser flows.
4. Stage only intended paths, for example `git add path/to/file path/to/test`.
5. Review the complete staged patch with `git diff --cached`, plus `git diff --cached --stat` and `git diff --cached --check`. Confirm no credentials, generated files, unrelated edits, or accidental deletions are present.
6. Create one focused Conventional Commit, such as `feat: add ...`, `fix: preserve ...`, `test: verify ...`, `docs: record ...`, or `chore: update ...`.
7. Verify with `git status --short --branch` and `git log -1 --oneline`.

Do not amend an existing commit unless explicitly requested. Do not push merely because a commit was created. A push is a separate user-authorized action.

## Merge

Prefer a pull request into `main`, because required CI checks are the merge gate. Before opening or completing a merge, verify the current branch and update the feature branch:

```bash
git status --short --branch
test -n "$(git branch --show-current)" || { echo "Detached HEAD cannot be merged" >&2; exit 1; }
git fetch origin
git rebase origin/main
```

Then run the complete verification sequence below and push only the named feature branch. If a local merge is explicitly requested, start from a clean tree, switch to the target branch, verify it, update it, and merge the reviewed branch:

```bash
git switch main
test "$(git branch --show-current)" = "main" || { echo "Target branch is not main" >&2; exit 1; }
git pull --ff-only origin main
git merge --no-ff <branch>
```

Rerun verification and push `main` only after all gates pass. Never force-push `main`.

For merge conflicts: stop, preserve the conflict markers for the user, report the paths, and do not run `git commit` or `git rebase --continue` until the resolution is known and tested.

## Build and Test

### Prerequisites

From WSL:

```bash
if [ ! -e .env ]; then cp .env.example .env; else echo '.env exists; preserving it'; fi
npm ci
npm run compose:up
npm run db:migrate
npx playwright install chromium --with-deps
```

From Git Bash on native Windows, use the same guarded `.env` setup and install Chromium without Linux system dependencies:

```bash
if [ ! -e .env ]; then cp .env.example .env; else echo '.env exists; preserving it'; fi
npm ci
npx playwright install chromium
```

PowerShell equivalents for the guarded setup are:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env } else { Write-Output '.env exists; preserving it' }
npm ci
```

Use `docker compose -f infra/docker/compose.yml ps` to confirm services are healthy before integration or browser tests. Do not print `.env` contents or credentials in logs.

### Required order

Run these serially and stop at the first failure:

```bash
npm run verify:ci
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:handler
npm run test:browser
npm run build
```

The lint, typecheck, test, integration, handler, browser, and build commands match the gates in `.github/workflows/ci.yml`. `npm run verify:ci` is an additional local structural preflight; CI does not run it and it does not replace any quality gate. `npm run build` runs the worker's `tsc --noEmit` check and the web app's `next build`. Run `npm run compose:down` only when the local services are no longer needed.

For a docs-only or narrowly isolated change, use a smaller relevant check for the commit, but run the complete sequence before merge unless the user explicitly accepts a documented exception.

## Failure Handling and Handoff

- `bash` not found: move to WSL/Git Bash or report that the full suite is blocked on Windows; do not call it a test failure.
- `npm ci` fails: inspect Node/npm versions and lockfile state; do not replace it with `npm install`.
- Service connection failures: inspect `docker compose ... ps` and health logs, then retry the affected gate after services are healthy.
- Playwright startup or port failures: inspect `playwright.config.ts`, free the conflicting local process only with authorization, and rerun the browser gate.
- Any failed gate: preserve logs, do not commit or merge, and report the first failing command plus whether earlier gates passed.

The final handoff must include the current branch, HEAD commit, changed paths, commands run, pass/fail status for each gate, service prerequisites, and any unrun or blocked checks. Never summarize an unrun command as passed.
