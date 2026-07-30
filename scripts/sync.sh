#!/usr/bin/env bash
# 双向同步脚本 —— 与 GitHub (origin/main) 合并，绝不覆盖文件。
#
# 机制：
#   1. git add -A + 提交本地改动（有改动才提交）
#   2. git pull --rebase --autostash  ← 把远端改动合进来；本地未提交改动自动暂存/恢复
#   3. 若出现冲突：立即停止并提示，等你手动解决（git 会保留两边内容，不丢数据）
#   4. git push  ← 把本地推上去
#
# 用法：  bash scripts/sync.sh  ["提交说明"]
set -euo pipefail

cd "$(dirname "$0")/.."   # 切到仓库根目录
MSG="${1:-chore: local sync $(date '+%Y-%m-%d %H:%M:%S')}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

echo "==> 分支: $BRANCH"

# 1) 提交本地改动（如有）
if [ -n "$(git status --porcelain)" ]; then
  echo "==> 发现本地改动，提交中..."
  git add -A
  git commit -m "$MSG"
else
  echo "==> 无本地改动，跳过提交"
fi

# 2) 拉取远端并 rebase（autostash 保护未提交内容）
echo "==> 拉取远端 (rebase, 不覆盖)..."
if ! git pull --rebase --autostash origin "$BRANCH"; then
  echo ""
  echo "!!! 出现冲突，同步已暂停。你的文件都还在，没有被覆盖。"
  echo "    请手动解决冲突后执行： git rebase --continue && git push"
  echo "    或放弃本次 rebase：     git rebase --abort"
  exit 1
fi

# 3) 推送
echo "==> 推送到远端..."
git push origin "$BRANCH"

echo "==> 同步完成 ✅"
