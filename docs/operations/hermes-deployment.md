# Hermes 发布、检查与回退

`infra/deploy/deploy-hermes.sh` 先核对发布主干与真实 CI，再在服务器建立独立 release。构建或迁移失败不会替换当前代码；切换后健康或进程身份核验失败，会自动恢复前一应用目录与服务配置。数据库迁移保留，不自动回退数据库。

```bash
bash infra/deploy/deploy-hermes.sh deploy
bash infra/deploy/deploy-hermes.sh status
bash infra/deploy/deploy-hermes.sh logs
bash infra/deploy/deploy-hermes.sh restart
bash infra/deploy/deploy-hermes.sh rollback
```

仅支持以上动作。旧的 `sync`、`build`、`migrate` 单步入口已移除，不能绕过备份、CI 与切换门禁。

## 目录与前提

| 用途 | 默认路径 / 配置 |
|---|---|
| 稳定配置、既有 Python venv、旧应用 | `/opt/aistudy`；不清空、不覆盖旧构建 |
| 当前应用软链 | `/opt/aistudy-current`；首次发布先指向旧应用 |
| 新应用 | `/opt/aistudy-releases/<完整 SHA>-<UTC 时间>-<PID>` |
| 发布锁、日志、服务配置快照 | `/opt/aistudy-deployment`；目录权限 0700 |
| PostgreSQL custom 备份 | `/opt/aistudy-backups/*.dump`；目录 0700，文件 0600 |
| 生产配置 | `/opt/aistudy/.env.production`；release 仅链接至此文件 |
| Web | `aistudy-web.service`，`127.0.0.1:18090`，Next standalone |
| Worker | `aistudy-worker.service`，专用非 root 用户 `aistudy-worker` |
| Worker 固定运行参数 | `/etc/aistudy/worker-runtime.env`；在原配置之后加载 |
| 既有数据依赖 | PostgreSQL 16、Redis、MinIO；本脚本不重建这些服务 |

服务器需要 Node.js 22+、npm、Python 3、既有 Docling venv 与离线模型、与数据库版本匹配的 `pg_dump` / `pg_restore`、`flock`、systemd、curl。部署账号需要安装服务与读取 `/proc/<PID>/environ` 的权限；worker 仍以专用非 root 身份运行。`provision-worker.sh` 会验证该身份读取新代码、venv 和离线缓存并执行 parser `--check`。

本机需要 Git、Node.js 22+、已认证的 GitHub CLI `gh`、SSH / SCP。SSH 必须已有可信主机指纹与密钥；脚本不接受未知指纹、不使用保存的 root 密码、不修改 sshd。当前环境 SSH 不可达时只能准备代码与模拟验证，不能据此声称已发布。

默认远端优先 `study-assistant-opening`，否则 `origin`，可用 `DEPLOY_REMOTE` 指定另一已配置远端。远端 URL 必须指向 GitHub 仓库，工作树必须干净，HEAD 必须等于该远端的 `feat/opening-release`。脚本用 `gh api` 查询该完整 SHA 在 `ci.yml` 的最新 push 运行；必须 completed + success。旧成功、较新的失败、PR 成功、运行中、查不到结果或缺少 gh 均拒绝发布。

## 发布顺序

1. 核实 HEAD、远端主干与实际 CI，打包该提交并上传至唯一临时文件。
2. 在服务器持有同一把非阻塞 `flock`；发布、重启、回退不能并行。先检查 releases 与 backups 所在磁盘可用空间，默认各需至少 4 GiB；不足直接停止，不删除在线代码、旧 release、缓存或备份。
3. 解包新 release，独立执行 `npm ci` 与构建，补齐 standalone 静态资源，使用稳定 venv 在新 parser 目录执行 `--check`。安装、构建日志保存在本轮发布状态目录，不打印生产环境变量。
4. 从生产配置解析 `DATABASE_URL`，用 `pg_dump --format=custom` 写备份并执行 `pg_restore --list`；成功后才将 `.partial` 命名为 `.dump`。清除继承的 `PG*` 路由变量，只从 URL 重建连接参数。未知或重复 URL 查询参数直接拒绝，避免猜测备份目标。
5. 备份可读后才执行迁移；迁移失败保留备份与新目录，当前软链与服务配置不变。迁移可能已提交的 additive 变更不会被撤销。
6. 保存 web override 与 worker 配置快照；配置服务使用 current 路径。worker helper 对实际新 release 以专用用户进行预检。
7. 用同目录临时软链加 `mv -T` 原子切换 current，重启 web 与原来运行或启用的 worker。禁用且未运行的 worker 保持关闭。
8. `/api/health` 成功后，还检查 `systemctl show` 的有效 MainPID / User / ExecStart / WorkingDirectory 与 `/proc` 中真实 cwd、可执行文件、UID，读取前后 MainPID 与启动配置必须一致。Next 会改写 process.title，所以 web 不依赖会消失的命令行参数；它的有效 ExecStart、真实 Node 可执行文件和 cwd 必须属于该 release。worker 必须是 `aistudy-worker`、UID 与该账号一致且非 root，在该 release 中执行 worker。高优先级 drop-in 把进程指回旧代码时不能通过。
9. 仅输出并核对明示允许的开关：adaptive planning、chat prose / answer style / artifacts、四个 teaching 开关和 daily cap。运行进程中的值必须与解析后的配置一致；不输出其余环境、连接串或密钥。最后原子记录成功 transition。

`MIN_FREE_KB` 可按已测量的构建与备份预算调大；变更部署目录可设置 `DIR`、`RELEASES_DIR`、`CURRENT_LINK`、`DEPLOY_STATE`、`BACKUP_DIR`。路径必须为规范绝对路径，仅允许字母、数字、下划线、短横线、点和路径分隔符。systemd / worker 配置目录默认使用系统路径。

`pg_restore --list` 只证明归档可解析，不等于恢复演练。正式发布前仍需按备份规程在隔离数据库验证可恢复，并确认对象存储与配置备份。脚本保留旧应用、配置快照、失败 release 与数据库备份，不自动清理；清理须先核实 current、上一成功 transition 与所需备份。

## 自动恢复与显式回退

切换或配置阶段失败时，脚本先恢复旧 current，再恢复 web override、worker unit 与固定运行参数，重启原先应运行的服务并重新检查健康与实际进程身份。恢复成功与失败分别报告；失败状态和备份保留，不能将失败的部署记录当作成功。部署前会在 root 私有状态目录记录旧 target 的有效 worker 用户与 UID；只有恢复该匹配快照时，才允许恢复既有 legacy 身份。若旧 worker 是 root，会明确提示「旧身份已恢复，非 root 加固尚未生效」，这只说明恢复原应用可用状态，不算新发布通过安全门禁。正常新发布始终要求专用非 root 用户；没有通用的允许 root 开关。

```bash
bash infra/deploy/deploy-hermes.sh rollback
```

`rollback` 读取上一成功 transition 的原应用路径和服务配置。它也先保存当前状态；回退目标检查失败时，再恢复回退前的应用与配置。回退不会执行逆向 migration 或自动 `pg_restore`，以免覆盖新学习记录。业务 schema 必须继续兼容保留的 additive 迁移；不兼容的数据恢复须单独制定停机与恢复步骤。

应用回退也不会改写稳定 `.env.production`。人工修改该文件前须保留配置备份，并确认旧应用兼容。`status` 显示目录、文件 SHA、实际进程 PID / 用户 / 代码路径及允许开关；文件 SHA 单独不能证明实际进程身份。首次受管发布前没有安装运行身份检查器，`status` / `restart` 不会伪报完整验收成功。

## 自用开关

仅在服务器配置文件中编辑，勿提交密钥。日常自用示例：

```bash
OPENING_CHAT_PROSE=1
OPENING_ANSWER_STYLE=1
OPENING_CHAT_ARTIFACTS=0
```

AI 主讲试跑按实际发布清单决定是否启用：

```bash
OPENING_TEACHING_LOOP=1
OPENING_TEACHING_WORKSPACE=1
OPENING_TEACHING_COMPILER_ENABLED=1
OPENING_TEACHING_VALIDATION_ENABLED=1
```

改完后 `restart`，再由用户完成浏览器验收。需暂停模型调用可设 `OPENING_MODEL_DAILY_CAP_CENTS=0` 并重启。worker 首次安装仍不自动 enable；确需消费任务时由部署负责人启用。parser `--check` 不能代替专用 worker 身份下的真实 PDF / PPTX 转换、数据库写回与清理验收。

## 排障

- SSH 失败：核对网络、`hermes` 别名、密钥和已核实的主机指纹。若网络截断 PQ KEX，可由部署机管理员在该 Host 下显式配置 `KexAlgorithms curve25519-sha256`；脚本不会修改认证设置。
- 空间不足：先确认每个文件系统实际剩余空间及构建 / 备份预算。不要删除 current 或上一可回退构建来强行发布。
- 健康接口成功但身份失败：检查 systemd 后加载的 drop-in、ExecStart、WorkingDirectory、User 和环境文件顺序；不要只看 HTTP 200。
- 数据库备份失败：核实 PostgreSQL 工具版本、URL 参数、磁盘与权限。脚本不打印连接凭据；失败的 `.partial` 与原数据保留。
- 自动恢复也失败：保持模型预算关闭，检查发布状态目录、`systemctl status` 和 `logs`，从保留的应用与配置恢复；数据库恢复须单独确认，不能盲目覆盖线上数据。

模型路由键与 Hermes 配置说明见 [opening-model-routing.md](opening-model-routing.md)。本说明描述脚本行为与待现场核验的前提，不代表服务器已经执行新发布流程。

Worker 账号、缓存迁移与隔离配置的详细现场步骤见 [worker-service-hardening.md](worker-service-hardening.md)。
