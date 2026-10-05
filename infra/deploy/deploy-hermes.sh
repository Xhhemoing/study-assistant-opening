#!/usr/bin/env bash
# 固定化部署脚本：把最新代码部署到 23.251.32.22（SSH 别名 hermes）。
#
# 前置条件（首次使用前人工完成一次）：
#   1. 服务器已安装 Docker 与 docker compose 插件（脚本会检测）。
#   2. 本机 ~/.ssh/id_ed25519 的公钥已加入服务器 /root/.ssh/authorized_keys，
#      且 sshd 允许 root 公钥登录（PermitRootLogin prohibit-password 或 without-password）。
#      验证：ssh hermes 'echo ok'   ← 必须免密成功。
#   3. 服务器 /opt/aistudy/deploy.env 已按 .env.example 配好生产变量
#      （DATABASE_URL/REDIS_URL/S3_*/AUTH_SECRET/OPENING_CONNECTION_KEY/OPENING_MODEL_* 等）。
#
# 用法：
#   bash scripts/deploy-hermes.sh            # 完整部署：拉代码 -> 构建 -> 迁移 -> 滚动重启 -> 健康检查
#   bash scripts/deploy-hermes.sh --status   # 只看服务状态
#   bash scripts/deploy-hermes.sh --logs     # 跟踪 web+worker 日志
#   bash scripts/deploy-hermes.sh --rollback # 回到上一个镜像 tag
set -euo pipefail

HOST_ALIAS="${HOST_ALIAS:-hermes}"
REMOTE_DIR="${REMOTE_DIR:-/opt/aistudy}"
COMPOSE_FILE="$REMOTE_DIR/compose.aistudy.yml"

run() { echo "==> [server] $*"; ssh -o BatchMode=yes "$HOST_ALIAS" "$*"; }

check_ssh() {
  if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST_ALIAS" true 2>/dev/null; then
    cat >&2 <<'EOF'
[!] 无法免密 SSH 到 hermes（23.251.32.22）。当前服务器 root 只接受密码登录，
    本机公钥（aistudy-hermes-sync）未在服务器 authorized_keys 中或 root 禁止公钥登录。
    修复（任选其一）：
      A) 手动执行：ssh-copy-id -i ~/.ssh/id_ed25519.pub root@23.251.32.22
         （输入一次密码即可，以后部署免密）
      B) 或在服务器上执行：
         mkdir -p ~/.ssh && echo '<本机 cat ~/.ssh/id_ed25519.pub 的内容>' >> ~/.ssh/authorized_keys
    完成后运行：ssh hermes 'echo ok' 验证，再执行本脚本。
EOF
    exit 1
  fi
}

bootstrap_server() {
  run "mkdir -p $REMOTE_DIR"
  # 首次初始化：上传 compose 文件（幂等）
  scp -q infra/deploy/compose.aistudy.yml "$HOST_ALIAS:$COMPOSE_FILE"
  if ! run "test -f $REMOTE_DIR/deploy.env"; then
    echo "[!] 服务器缺少 $REMOTE_DIR/deploy.env —— 请按 .env.example 填好生产变量后上传：" >&2
    echo "    scp .env.production hermes:$REMOTE_DIR/deploy.env" >&2
    exit 1
  fi
}

deploy() {
  local sha
  sha="$(git rev-parse --short HEAD)"
  echo "==> 部署提交: $sha（分支 $(git rev-parse --abbrev-ref HEAD)）"

  echo "==> [server] 拉取代码"
  run "cd $REMOTE_DIR/app && git fetch origin && git reset --hard origin/feat/opening-release"

  echo "==> [server] 构建镜像（web + worker）"
  run "cd $REMOTE_DIR/app && docker compose -f $COMPOSE_FILE --env-file $REMOTE_DIR/deploy.env build"

  echo "==> [server] 数据库迁移（新版本启动前执行，additive 迁移可安全重放）"
  run "cd $REMOTE_DIR/app && docker compose -f $COMPOSE_FILE --env-file $REMOTE_DIR/deploy.env run --rm migrate"

  echo "==> [server] 滚动重启 web + worker"
  run "cd $REMOTE_DIR/app && docker compose -f $COMPOSE_FILE --env-file $REMOTE_DIR/deploy.env up -d --wait"

  echo "==> [server] 健康检查 /api/health"
  run "curl -fsS --max-time 10 http://127.0.0.1:3000/api/health"

  echo "==> 部署完成 ✅（$sha）"
}

status()   { run "docker compose -f $COMPOSE_FILE --env-file $REMOTE_DIR/deploy.env ps"; }
logs()     { run "docker compose -f $COMPOSE_FILE --env-file $REMOTE_DIR/deploy.env logs -f --tail=100 web worker"; }
rollback() {
  run "cd $REMOTE_DIR/app && docker compose -f $COMPOSE_FILE --env-file $REMOTE_DIR/deploy.env down"
  run "cd $REMOTE_DIR/app && PREVIOUS=\$(docker images --format '{{.Repository}}:{{.Tag}}' 'aistudy-web' | sed -n 2p) \
    && docker tag \$PREVIOUS aistudy-web:rollback \
    && docker compose -f $COMPOSE_FILE --env-file $REMOTE_DIR/deploy.env up -d --no-deps web"
  echo "==> 已回滚 web 到上一镜像（worker 未动，按需手动处理）"
}

case "${1:-deploy}" in
  deploy)    check_ssh; bootstrap_server; deploy ;;
  --status)  check_ssh; status ;;
  --logs)    check_ssh; logs ;;
  --rollback) check_ssh; rollback ;;
  *) echo "用法: $0 [deploy|--status|--logs|--rollback]" >&2; exit 2 ;;
esac
