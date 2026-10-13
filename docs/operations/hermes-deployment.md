# 23.251.32.22（hermes）部署流程

部署由 `infra/deploy/deploy-hermes.sh` 驱动，一条命令完成：

```bash
bash infra/deploy/deploy-hermes.sh deploy    # 同步→构建→迁移→重启→健康检查
bash infra/deploy/deploy-hermes.sh status    # 服务状态 + /api/health
bash infra/deploy/deploy-hermes.sh logs      # journalctl -u aistudy-web -f
bash infra/deploy/deploy-hermes.sh sync|build|migrate|restart   # 单步执行
```

## 服务器布局（2026-10-05 确认）

| 项 | 值 |
|---|---|
| 源码 | `/opt/aistudy`（tar-over-ssh 覆盖同步，服务器上无 `.git`） |
| 构建 | `npm ci` + `npm run build`（Next standalone） |
| 运行 | systemd `aistudy-web.service`，`127.0.0.1:18090` |
| 数据库 | 本机 PostgreSQL 16（`postgresql@16-main_aistudy`，5432） |
| Redis | 本机 6379 |
| 对象存储 | docker `aistudy-minio`（127.0.0.1:9000） |
| 配置 | `/opt/aistudy/.env.production`（systemd EnvironmentFile；不同步进 git） |
| Worker | `infra/deploy/aistudy-worker.service`（脚本首次部署时安装，默认 disabled） |

## 前置条件（已完成 2026-10-05）

- SSH 免密：本机公钥（`aistudy-hermes-sync`）已装入 `/root/.ssh/authorized_keys`；
  服务器 `sshd_config` 的 `PubkeyAuthentication` 已从 `no` 改为 `yes`（备份 `sshd_config.bak-*`）。
- 部署前 HEAD 必须已推送到 `study-assistant-opening/feat/opening-release`
  （脚本强制校验，保证「部署的就是仓库里的」）。

## 日常发布

```bash
git push study-assistant-opening feat/opening-release
bash infra/deploy/deploy-hermes.sh deploy
```

流程：打包 HEAD（不含 `.git`/`node_modules`/`.next`）→ 上传覆盖
`.env.production` 保留 → `npm ci` → `npm run build` → `db:migrate`
（additive 可重放）→ `systemctl restart aistudy-web` → `/api/health` 等待
`status:"ok"`。

## 回退

源码级部署天然可回退：本地 `git checkout <旧提交>` → push → `deploy`。
迁移按项目约定 additive、不回退；需停外部调用时把
`OPENING_MODEL_DAILY_CAP_CENTS=0` 写入 `.env.production` 并 `restart`。

## 自用开关

在 hermes `/opt/aistudy/.env.production`（web 与 worker 共用 EnvironmentFile）写入后重启。密钥勿提交 git。

**日常自用**（对话散文 / 答题风格开，产物卡关）：

```bash
# 写入 .env.production
OPENING_CHAT_PROSE=1
OPENING_ANSWER_STYLE=1
OPENING_CHAT_ARTIFACTS=0

bash infra/deploy/deploy-hermes.sh restart
```

**AI 主讲试跑（V2-16）**在上述基础上再开：

```bash
# 追加写入 .env.production
OPENING_TEACHING_LOOP=1
OPENING_TEACHING_WORKSPACE=1
OPENING_TEACHING_COMPILER_ENABLED=1
OPENING_TEACHING_VALIDATION_ENABLED=1

bash infra/deploy/deploy-hermes.sh restart
# worker 首次部署默认 disabled；编译/校验任务需要启用：
ssh root@23.251.32.22 'systemctl enable --now aistudy-worker'
```

关闭试跑：将上述 teaching 四开关改回 `0`（或不设）后 `restart`；需要停 worker 时 `systemctl disable --now aistudy-worker`。

## 排障

- SSH 失败：`ssh-copy-id -i ~/.ssh/id_ed25519.pub root@23.251.32.22`。
- `ssh -v` 卡在 `expecting SSH2_MSG_KEX_ECDH_REPLY` 后出现 Connection reset：部分网络上后量子（PQ）KEX 握手被截断。在 `~/.ssh/config` 的 `Host hermes` 下禁用有问题的 PQ KEX，例如：
  ```
  Host hermes
    KexAlgorithms curve25519-sha256,ecdh-sha2-nistp256,diffie-hellman-group-exchange-sha256
  ```
- 健康检查不过：`logs` 查看；常见为 `.env.production` 缺新变量（503 CONFIGURATION）。
- 磁盘 89% 满：构建前脚本自动 `npm cache clean` 并删除 `node_modules`；若仍不足，
  清理 `~/swap-*`、旧备份或 `docker image prune`。
- worker 积压：`systemctl status aistudy-worker`（若启用）；readiness 口径见
  `docs/operations/opening-release.md`。

## Opening 模型（Lant / glm-5.3）

Tutor / vision 默认模型统一到可用的 Lant + `glm-5.3` 时，由 PM 编辑 `.env.production`（勿提交密钥），键清单与示例 JSON 见 `docs/operations/opening-model-routing.md`「Hermes 运维清单」。改完后 `bash infra/deploy/deploy-hermes.sh restart`（或完整 `deploy`）；本仓库任务默认不自动 redeploy。

