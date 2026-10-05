# 23.251.32.22（hermes）部署流程

部署由一个脚本驱动，幂等、可回滚：

```bash
bash scripts/deploy-hermes.sh            # 完整部署（拉代码→构建→迁移→重启→健康检查）
bash scripts/deploy-hermes.sh --status   # 查看服务状态
bash scripts/deploy-hermes.sh --logs     # 跟踪 web/worker 日志
bash scripts/deploy-hermes.sh --rollback # 回滚 web 到上一镜像
```

## 一次性初始化（首次）

1. **SSH 免密**：服务器当前 root 只接受密码登录时，先执行
   `ssh-copy-id -i ~/.ssh/id_ed25519.pub root@23.251.32.22`（输入一次密码），
   然后 `ssh hermes 'echo ok'` 必须免密成功。脚本的密钥注释为 `aistudy-hermes-sync`。
2. **服务器目录**：`/opt/aistudy/app` 放代码（`git clone https://github.com/Xhhemoing/study-assistant-opening.git app`），
   `/opt/aistudy/deploy.env` 放生产变量（按 `.env.example`，至少包含
   `DATABASE_URL`、`REDIS_URL`、`S3_*`、`AUTH_SECRET`、`SESSION_*`、`PUBLIC_BASE_URL`、
   `OPENING_CONNECTION_KEY`、`OPENING_MODEL_*`）。
3. **Docker**：服务器需装 Docker 与 compose 插件（`apt install docker.io docker-compose-v2` 或官方脚本）。

## 日常发布

代码合并到 `feat/opening-release` 并推送后，本地执行
`bash scripts/deploy-hermes.sh` 即可。脚本会：

1. `git fetch + reset --hard` 到远端最新（服务器不做本地改动）。
2. `docker compose build` 构建 `aistudy-web` / `aistudy-worker` 镜像。
3. 一次性容器跑 `npm run db:migrate`（迁移为 additive，可安全重放）。
4. `up -d --wait` 滚动重启并等待健康检查。
5. `curl /api/health` 确认 `status: "ok"`。

## 回退

- 应用回退：`bash scripts/deploy-hermes.sh --rollback`（回到上一 web 镜像；worker 不动）。
- 迁移不回退（项目约定 additive + 记录回滚语句）；需要停外部调用时把
  `OPENING_MODEL_DAILY_CAP_CENTS=0` 写入 `deploy.env` 后 `--status`/`--logs` 观察并重启 worker。

## 排障

- SSH 失败：脚本会打印 ssh-copy-id 修复指引。
- 健康检查不过：`--logs` 看 web 容器；常见为 `deploy.env` 缺变量（EnvValidationError 503）。
- worker 积压：`--logs` 关注 outbox/tutor job；`docs/operations/opening-release.md` 的 readiness 口径。
