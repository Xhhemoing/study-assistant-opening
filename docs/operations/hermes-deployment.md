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
- 以上是既有部署机的记录。新环境仍须配置 `hermes` 别名、可用密钥及经核实的主机指纹；脚本不会用保存的 root 密码修复登录、接受未知指纹或修改 sshd。
- 部署前 HEAD 必须等于远端 `feat/opening-release`，并通过该提交的 CI。
  脚本优先沿用 `study-assistant-opening` 远端，没有该别名时检查 `origin`；可用 `DEPLOY_REMOTE` 显式指定。已推送但未合并的特性分支不能部署。
- 部署前按发布清单核实并备份线上源码、配置与数据库；脚本仍在原目录构建，不提供无停机切换或自动恢复备份。

## 日常发布

```bash
# 先通过 PR 合并并确认发布主干 CI，再在干净工作树同步
git switch feat/opening-release
git pull --ff-only origin feat/opening-release
bash infra/deploy/deploy-hermes.sh deploy
# 只有远端名称不同时：
# DEPLOY_REMOTE=study-assistant-opening bash infra/deploy/deploy-hermes.sh deploy
```

流程：打包 HEAD（不含 `.git`/`node_modules`/`.next`）→ 上传覆盖
`.env.production` 保留 → `npm ci` → `npm run build` → `db:migrate`
（additive 可重放）→ 重启 web 与原来运行中或已启用的 worker → `/api/health` 等待
`status:"ok"` → 将完整提交 SHA 写入 `/opt/aistudy/.release-sha`。
禁用且未运行的 worker 保持关闭。远端通过 Bash 的 `pipefail` 执行，安装、构建、迁移或 worker 重启失败都会终止发布，不会因 `tail` 返回成功而继续。

`status` 会显示最近成功部署的 SHA；旧部署没有该文件时会明确报告未记录。只执行 `restart`、`build` 或 `migrate` 不会改写这个记录。部署失败保留上次成功记录，它不证明失败后的进程仍在运行旧版本，须同时检查服务与构建状态。

## 回退

在 `feat/opening-release` 通过 revert PR 恢复上个已验证版本，CI 通过后同步并 `deploy`；不重写发布分支历史。紧急恢复使用发布前保留的已验证构建和配置，再核实 web/worker 健康。
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

- SSH 失败：先检查网络、`hermes` 别名、密钥与已核实的主机指纹。由有权限的部署机配置公钥；脚本会直接停止，不自动改服务器认证设置。
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

