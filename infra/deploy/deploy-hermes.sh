#!/usr/bin/env bash
# 固定化部署：把当前 HEAD 部署到 23.251.32.22（SSH 别名 hermes）。
#
# 服务器真实布局（2026-10-05 确认）：
#   源码   /opt/aistudy          （tar 覆盖同步，服务器上无 .git）
#   构建   /opt/aistudy/apps/web/.next/standalone  （Next standalone）
#   运行   systemd: aistudy-web.service（127.0.0.1:18090）
#   依赖   本机 postgres16(5432) / redis(6379) / docker minio(9000)
#   配置   /opt/aistudy/.env.production（systemd EnvironmentFile，密码等敏感值不进 git）
#
# 用法：
#   bash scripts/../infra/deploy/deploy-hermes.sh deploy     # 同步→构建→迁移→重启→健康检查
#   bash infra/deploy/deploy-hermes.sh status|logs|restart|rollback
set -euo pipefail

HOST="${HOST:-hermes}"
DIR="${DIR:-/opt/aistudy}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
COMMIT="$(git rev-parse HEAD)"
SHA="$(git rev-parse --short HEAD)"
if [ -z "${DEPLOY_REMOTE:-}" ]; then
  DEPLOY_REMOTE=origin
  if git remote get-url study-assistant-opening >/dev/null 2>&1; then
    DEPLOY_REMOTE=study-assistant-opening
  fi
fi

sshq() {
  ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes \
    "$HOST" 'bash -o pipefail -s' <<< "$1"
}
die() { echo "[!] $*" >&2; exit 1; }

check_ssh() {
  sshq true || die "无法通过已验证的 SSH 连接到 $HOST；请先配置可信主机指纹与密钥（见 docs/operations/hermes-deployment.md）"
}

require_clean_push() {
  local remote_sha
  remote_sha="$(git ls-remote "$DEPLOY_REMOTE" refs/heads/feat/opening-release | cut -f1)"
  [ "$COMMIT" = "$remote_sha" ] || die "HEAD($SHA) 与 $DEPLOY_REMOTE/feat/opening-release 不一致；请先合并并同步已通过 CI 的发布主干"
  echo "==> 部署提交: $COMMIT ($BRANCH)"
}

sync_source() {
  echo "==> 打包 HEAD 并上传（tar-over-ssh，不含 .git/node_modules/.next）"
  local archive="/tmp/aistudy-src-$SHA.tar.gz"
  git archive --format=tar.gz -o "$archive" HEAD
  scp -q -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes \
    "$archive" "$HOST:/tmp/aistudy-src.tar.gz"
  rm -f "$archive"
  sshq "set -e
    mkdir -p $DIR
    # 保留服务器本地配置与运行期文件
    cp -f $DIR/.env.production /tmp/aistudy-env.production.keep 2>/dev/null || true
    find $DIR -mindepth 1 -maxdepth 1 ! -name '.env.production' ! -name '.local' ! -name '.release-sha' -exec rm -rf {} +
    tar -xzf /tmp/aistudy-src.tar.gz -C $DIR
    cp -f /tmp/aistudy-env.production.keep $DIR/.env.production 2>/dev/null || true
    rm -f /tmp/aistudy-src.tar.gz /tmp/aistudy-env.production.keep
    echo synced:\$(ls $DIR | wc -l) 项"
}

build_server() {
  echo "==> [server] npm ci + 构建 standalone（磁盘 89% 满，先清理缓存）"
  sshq "set -e
    cd $DIR
    npm cache clean --force >/dev/null 2>&1 || true
    [ -d node_modules ] && rm -rf node_modules
    npm ci --no-audit --no-fund 2>&1 | tail -2
    npm run build 2>&1 | tail -4
    # standalone 不会自动带上静态资源，必须手动拷贝（缺失会导致页面无 JS/CSS，“正在进入 AIstudy”卡住）
    mkdir -p apps/web/.next/standalone/apps/web/.next/static apps/web/.next/standalone/apps/web/public
    cp -r apps/web/.next/static/* apps/web/.next/standalone/apps/web/.next/static/
    [ -d apps/web/public ] && cp -r apps/web/public/* apps/web/.next/standalone/apps/web/public/ || true
    test -f apps/web/.next/standalone/apps/web/server.js
    [ \$(ls apps/web/.next/standalone/apps/web/.next/static 2>/dev/null | wc -l) -gt 0 ]"
}

migrate_server() {
  echo "==> [server] 数据库迁移（additive，可重放）"
  sshq "set -e
    cd $DIR
    set -a; . ./.env.production; set +a
    npx tsx ./scripts/db-migrate.ts 2>&1 | tail -3"
}

restart_services() {
  echo "==> [server] 重启 web 与已启用或运行中的 worker"
  # worker 服务文件随仓库分发（infra/deploy/aistudy-worker.service），首次安装
  sshq "set -e
    if [ ! -f /etc/systemd/system/aistudy-worker.service ] && [ -f $DIR/infra/deploy/aistudy-worker.service ]; then
      cp $DIR/infra/deploy/aistudy-worker.service /etc/systemd/system/
      systemctl daemon-reload
      echo 'worker 服务已安装（disabled，需要时 systemctl enable --now aistudy-worker）'
    fi
    restart_worker=0
    if systemctl is-active --quiet aistudy-worker.service || systemctl is-enabled --quiet aistudy-worker.service; then
      restart_worker=1
    fi
    systemctl restart aistudy-web.service
    if [ \"\$restart_worker\" = 1 ]; then
      systemctl restart aistudy-worker.service
      systemctl is-active --quiet aistudy-worker.service
    fi"
}

health() {
  echo "==> 健康检查"
  sshq "set -e
    for i in \$(seq 1 12); do
      sleep 2
      body=\$(curl -fsS --max-time 5 http://127.0.0.1:18090/api/health 2>/dev/null || true)
      case \"\$body\" in *'\"status\":\"ok\"'*) echo \"\$body\"; exit 0;; esac
    done
    echo 'health check failed'; journalctl -u aistudy-web -n 15 --no-pager; exit 1"
  echo "==> 服务健康检查通过"
}

record_release() {
  sshq "set -e
    printf '%s\\n' '$COMMIT' > '$DIR/.release-sha'"
  echo "==> 部署完成 ✅ $COMMIT"
}

case "${1:-deploy}" in
  deploy)   check_ssh; require_clean_push; sync_source; build_server; migrate_server; restart_services; health; record_release ;;
  sync)     check_ssh; require_clean_push; sync_source ;;
  build)    check_ssh; build_server ;;
  migrate)  check_ssh; migrate_server ;;
  restart)  check_ssh; restart_services; health ;;
  status)   check_ssh; sshq "set -e
    if [ -f '$DIR/.release-sha' ]; then cat '$DIR/.release-sha'; else echo '尚无成功部署 SHA 记录'; fi
    systemctl status aistudy-web.service --no-pager -l --lines=0
    curl -fsS --max-time 5 http://127.0.0.1:18090/api/health"; echo ;;
  logs)     check_ssh; sshq "journalctl -u aistudy-web -f -n 50 --no-pager" ;;
  rollback) die "回退：在发布主干通过 revert PR 恢复已验证源码后执行 deploy；保留既有迁移与学习数据" ;;
  *) echo "用法: $0 [deploy|sync|build|migrate|restart|status|logs|rollback]" >&2; exit 2 ;;
esac
