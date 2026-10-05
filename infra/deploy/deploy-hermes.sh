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
SHA="$(git rev-parse --short HEAD)"

sshq() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "$@"; }
die() { echo "[!] $*" >&2; exit 1; }

check_ssh() {
  if sshq true 2>/dev/null; then return 0; fi
  repair_ssh_key || die "无法免密 SSH 到 $HOST（自动修复失败）。手动：ssh-copy-id -i ~/.ssh/id_ed25519.pub root@23.251.32.22（见 docs/operations/hermes-deployment.md）"
}

# 免密失效时用本机保存的密码（%USERPROFILE%/.aistudy-deploy/hermes.secret，git 外）自动重装公钥。
repair_ssh_key() {
  local secret="$HOME/.aistudy-deploy/hermes.secret"
  [ -f "$secret" ] || return 1
  echo "==> 公钥登录失效，用保存的凭据自动重装公钥…"
  python3 - "$secret" <<'PY' || return 1
import sys, pathlib, paramiko
secret = pathlib.Path(sys.argv[1]).read_text().strip()
pub = pathlib.Path.home().joinpath(".ssh/id_ed25519.pub").read_text().strip()
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("23.251.32.22", username="root", password=secret, timeout=15, look_for_keys=False, allow_agent=False)
cmd = ("mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && "
       "grep -qF '%s' ~/.ssh/authorized_keys || echo '%s' >> ~/.ssh/authorized_keys; "
       "grep -qE '^PubkeyAuthentication yes' /etc/ssh/sshd_config || "
       "(sed -i 's/^PubkeyAuthentication no/PubkeyAuthentication yes/' /etc/ssh/sshd_config && sshd -t && systemctl reload sshd)" % (pub, pub))
c.exec_command(cmd, timeout=15)[1].channel.recv_exit_status()
c.close()
PY
  sleep 1; sshq true 2>/dev/null
}
require_clean_push() {
  local remote_sha
  remote_sha="$(git ls-remote study-assistant-opening "refs/heads/$BRANCH" | cut -f1)"
  [ "$(git rev-parse HEAD)" = "$remote_sha" ] || die "HEAD($SHA) 未推送到 study-assistant-opening/$BRANCH($remote_sha)，先 git push"
  echo "==> 部署提交: $SHA ($BRANCH)"
}

sync_source() {
  echo "==> 打包 HEAD 并上传（tar-over-ssh，不含 .git/node_modules/.next）"
  local archive="/tmp/aistudy-src-$SHA.tar.gz"
  git archive --format=tar.gz -o "$archive" HEAD
  scp -q "$archive" "$HOST:/tmp/aistudy-src.tar.gz" && rm -f "$archive"
  sshq "set -e
    mkdir -p $DIR
    # 保留服务器本地配置与运行期文件
    cp -f $DIR/.env.production /tmp/aistudy-env.production.keep 2>/dev/null || true
    find $DIR -mindepth 1 -maxdepth 1 ! -name '.env.production' ! -name '.local' -exec rm -rf {} +
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
  echo "==> [server] 重启 aistudy-web（并安装 worker 服务，如尚未安装）"
  # worker 服务文件随仓库分发（infra/deploy/aistudy-worker.service），首次安装
  sshq "set -e
    if [ ! -f /etc/systemd/system/aistudy-worker.service ] && [ -f $DIR/infra/deploy/aistudy-worker.service ]; then
      cp $DIR/infra/deploy/aistudy-worker.service /etc/systemd/system/
      systemctl daemon-reload
      echo 'worker 服务已安装（disabled，需要时 systemctl enable --now aistudy-worker）'
    fi
    systemctl restart aistudy-web.service"
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
  echo "==> 部署完成 ✅ $SHA"
}

case "${1:-deploy}" in
  deploy)   check_ssh; require_clean_push; sync_source; build_server; migrate_server; restart_services; health ;;
  sync)     check_ssh; require_clean_push; sync_source ;;
  build)    check_ssh; build_server ;;
  migrate)  check_ssh; migrate_server ;;
  restart)  check_ssh; restart_services; health ;;
  status)   check_ssh; sshq "systemctl status aistudy-web.service --no-pager -l | head -12; curl -fsS --max-time 5 http://127.0.0.1:18090/api/health"; echo ;;
  logs)     check_ssh; sshq "journalctl -u aistudy-web -f -n 50 --no-pager" ;;
  rollback) die "回退：在本地 git checkout <旧提交> 后执行 deploy（源码级部署天然可回退）；迁移按约定不回退" ;;
  *) echo "用法: $0 [deploy|sync|build|migrate|restart|status|logs|rollback]" >&2; exit 2 ;;
esac
