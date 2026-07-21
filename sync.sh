#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
cd "$ROOT"

if ! gh auth status >/dev/null 2>&1; then
  printf '%s\n' "GitHub 未登录，请先运行: gh auth login" >&2
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [[ -z "$BRANCH" ]]; then
  printf '%s\n' "当前不在分支上，无法同步。" >&2
  exit 1
fi

if [[ "$BRANCH" != "main" ]]; then
  printf '当前分支为 %s，将同步该分支。继续？ [y/N] ' "$BRANCH"
  read -r answer
  [[ "$answer" =~ ^[Yy]$ ]] || exit 0
fi

if [[ -z "$(git status --porcelain)" ]]; then
  git push origin "$BRANCH"
  printf '%s\n' "没有本地文件变更，已确认远程同步完成。"
  exit 0
fi

git status --short
git add -A

MESSAGE="${*:-chore: sync local changes}"
git commit -m "$MESSAGE"
git push -u origin "$BRANCH"

printf '同步完成: %s -> origin/%s\n' "$(git rev-parse --short HEAD)" "$BRANCH"