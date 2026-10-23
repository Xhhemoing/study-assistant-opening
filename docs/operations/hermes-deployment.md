# Hermes 发布、检查与回退

`infra/deploy/deploy-hermes.sh` 先核对发布主干与真实 CI，再在服务器建立独立 release。构建或迁移失败不会替换当前代码；切换后健康或进程身份核验失败，在数据协议兼容时自动恢复前一应用目录与服务配置；Study 新 Web 启动后不自动退回忽略作答条件的旧 Web。数据库迁移保留，不自动回退数据库。

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
| 发布锁、日志、服务配置快照与 worker 暂停记录 | `/opt/aistudy-deployment`；目录权限 0700 |
| PostgreSQL custom 备份 | `/opt/aistudy-backups/*.dump`；目录 0700，文件 0600 |
| 生产配置 | `/opt/aistudy/.env.production`；release 仅链接至此文件 |
| Web | `aistudy-web.service`，`127.0.0.1:18090`，Next standalone |
| Worker | `aistudy-worker.service`，专用非 root 用户 `aistudy-worker` |
| Worker 固定运行参数 | `/etc/aistudy/worker-runtime.env`；在原配置之后加载 |
| 既有数据依赖 | PostgreSQL 16、Redis、MinIO；本脚本不重建这些服务 |

服务器需要 Node.js 22+、npm、Python 3、既有 Docling venv 与离线模型、与数据库版本匹配的 `pg_dump` / `pg_restore`、`flock`、`sha256sum`、systemd、curl。部署账号需要安装服务与读取 `/proc/<PID>/environ` 的权限；worker 仍以专用非 root 身份运行。`provision-worker.sh` 会验证该身份读取新代码、venv 和离线缓存并执行 parser `--check`。

本机需要 Git、Node.js 22+、已认证的 GitHub CLI `gh`、SSH / SCP。SSH 必须已有可信主机指纹与密钥；脚本不接受未知指纹、不使用保存的 root 密码、不修改 sshd。当前环境 SSH 不可达时只能准备代码与模拟验证，不能据此声称已发布。

默认远端优先 `study-assistant-opening`，否则 `origin`，可用 `DEPLOY_REMOTE` 指定另一已配置远端。远端 URL 必须指向 GitHub 仓库，工作树必须干净，HEAD 必须等于该远端的 `feat/opening-release`。脚本用 `gh api` 查询该完整 SHA 在 `ci.yml` 的最新 push 运行；必须 completed + success。旧成功、较新的失败、PR 成功、运行中、查不到结果或缺少 gh 均拒绝发布。

## 发布顺序

1. 核实 HEAD、远端主干与实际 CI，打包该提交并上传至唯一临时文件。
2. 在服务器持有同一把非阻塞 `flock`；发布、重启、回退不能并行。先检查 releases 与 backups 所在磁盘可用空间，默认各需至少 4 GiB；不足直接停止，不删除在线代码、旧 release、缓存或备份。
3. 解包新 release，独立执行 `npm ci` 与构建，补齐 standalone 静态资源，使用稳定 venv 在新 parser 目录执行 `--check`。安装、构建日志保存在本轮发布状态目录，不打印生产环境变量。
4. 从生产配置解析 `DATABASE_URL`，用 `pg_dump --format=custom` 写备份并执行 `pg_restore --list`；成功后才将 `.partial` 命名为 `.dump`。清除继承的 `PG*` 路由变量，只从 URL 重建连接参数。未知或重复 URL 查询参数直接拒绝，避免猜测备份目标。
5. 构建、parser 检查、备份归档校验完成后，保存 web override 与 worker 配置快照并启用故障恢复，然后对已存在的旧 worker unit 执行 stop，即便它处于 failed / auto-restart 等待期，以取消待执行的自动重启；确认其不再 active 后才执行迁移。首次安装确认 unit 不存在时跳过 stop。旧 worker 在构建和备份期间继续服务，但不能跨越 claim-token / 迟到写入保护的协议切换继续写回。迁移失败会恢复旧 worker 和配置、保留原软链、备份与新目录；已提交的 additive 变更不会被撤销。
6. 迁移成功后，worker helper 对实际新 release 以专用用户进行预检，配置服务使用 current 路径。不会在迁移阶段重新启动旧 worker。
7. 新 release 沿用源码中已审查的 `.worker-protocol=delivery-leases-study-v2`；历史无标记制品仍视为 `delivery-leases-v1`。三种受支持版本均具备 delivery lease 保护，`delivery-leases-study-v1` 额外识别 0081 作答条件，`delivery-leases-study-v2` 同时支持 0091 无材料题目身份及 0092 拍照识题任务。用同目录临时软链加 `mv -T` 原子切换 current，重启 web 与原来运行或启用的 worker；尝试启动 worker 前，先持久记录本轮 `lease-worker-start-attempted`，因为启动命令失败也可能已执行任务。禁用且未运行的 worker 保持关闭。
8. `/api/health` 成功后，还检查 `systemctl show` 的有效 MainPID / User / ExecStart / WorkingDirectory 与 `/proc` 中真实 cwd、可执行文件、UID，读取前后 MainPID 与启动配置必须一致。Next 会改写 process.title，所以 web 不依赖会消失的命令行参数；它的有效 ExecStart、真实 Node 可执行文件和 cwd 必须属于该 release。worker 必须是 `aistudy-worker`、UID 与该账号一致且非 root，在该 release 中执行 worker。高优先级 drop-in 把进程指回旧代码时不能通过。
9. 仅输出并核对明示允许的开关：adaptive planning、chat prose / answer style / artifacts、四个 teaching 开关和 daily cap。运行进程中的值必须与解析后的配置一致；不输出其余环境、连接串或密钥。最后原子记录成功 transition。

`MIN_FREE_KB` 可按已测量的构建与备份预算调大；变更部署目录可设置 `DIR`、`RELEASES_DIR`、`CURRENT_LINK`、`DEPLOY_STATE`、`BACKUP_DIR`。路径必须为规范绝对路径，仅允许字母、数字、下划线、短横线、点和路径分隔符。systemd / worker 配置目录默认使用系统路径。

迁往独立 `/www` 磁盘时，可将 `RELEASES_DIR` 指向 `/www/aistudy-releases`、`BACKUP_DIR` 指向 `/www/aistudy-backups`；保留 `DIR=/opt/aistudy`、`CURRENT_LINK=/opt/aistudy-current` 和 `DEPLOY_STATE=/opt/aistudy-deployment`，继续使用同一发布锁、服务配置和回退记录。目标检查同时允许新的 release 根与原默认 `${DIR}-releases` 根，因而可识别原 `/opt` 版本；是否允许回退仍受数据协议兼容性约束，其余目录仍拒绝。操作前确认 `/www` 确实挂载且空间足够，已有构建或发布必须先协调，不并行启动第二个发布者。原应用和备份不随迁移自动删除。

Worker unit 的 `WorkingDirectory`、`EnvironmentFile` 是单路径设置，不添加包围引号；`ReadWritePaths` 仍按路径列表引用，所有 unit 路径继续转义 `%`。实际 systemd 解析器的回归覆盖普通路径、空格及字面百分号，避免 mock 校验漏掉不可启动或被忽略的配置。

`pg_restore --list` 只证明归档可解析，不等于恢复演练。正式发布前仍需按备份规程在隔离数据库验证可恢复，并确认对象存储与配置备份。脚本保留旧应用、配置快照、失败 release 与数据库备份，不自动清理；清理须先核实 current、上一成功 transition 与所需备份。

## 自动恢复与显式回退

Study Web 会写入 0081 的 `copied_answer` / `guessed` 条件，旧 Web 不读取这些字段，可能错误计入独立作答资格。因此复用已有 `.worker-protocol` 版本字段区分兼容应用；Git SHA 和迁移成功本身不能使旧代码理解新数据。普通回归覆盖失败后的实际服务顺序和指针，不新增 hash、baseline 或独立 gate。

在尝试启动 Study Web 前持久记录 `study-app-start-attempted`，即使 worker 禁用也执行。此后自动恢复拒绝不兼容旧应用，停止 worker，保留当前兼容应用、配置及 `activation-incomplete`，明确返回失败；人工检查后以兼容 Study release 修复。显式 rollback 或 deploy 从 Study 降为旧 v1 / 无标记制品，也在服务变更前拒绝。相同 Study 版本之间正常回退；新 Web 尚未尝试启动时仍允许按旧配置恢复。0081 已记录的学习事实不逆向迁移、不自动还原旧数据库。

本轮 0091/0092 使用同一字段的 `delivery-leases-study-v2` 区分新增读写能力，不再把旧 Study v1 当作兼容回退目标。旧 Study 不能读取已保存的无来源题目身份，也不能投递 `recognize-photo-question` 任务；启动旧 worker 会反复消耗识题 outbox 的投递次数，最终把任务置为失败。因此在尝试启动 Study v2 Web 或 worker 前，还须在本轮 transition 中持久记录 `study-v2-app-start-attempted`。此后自动恢复禁止切回旧 Study v1 或更早应用，保留兼容版本、停止 worker 与 `activation-incomplete`；worker 禁用时，新 Web 的启动尝试同样生效。显式 rollback 或 deploy 从当前 Study v2 降为旧版本也会在服务变更前拒绝。同为 Study v2 的应用正常回退，升级在任何新进程尝试启动前失败时，仍可恢复旧 Study 配置和服务。DDL、原题、作答、识题结果及未知费用记录继续保留；不能通过恢复旧约束、删除任务或将 unknown 改为 queued 来降级。

切换或配置阶段失败时，脚本停止新 worker（也取消待执行的自动重启），恢复旧 current、web override、worker unit 与固定运行参数，再核验恢复结果。数据库备份和失败状态保留。相同数据协议的 release 之间可以正常恢复 worker；首次迁移或配置失败、且尚未尝试启动新 worker 时，也允许恢复原 legacy worker。部署前保留其有效用户与 UID，只有恢复匹配快照才允许使用该身份；旧 root 身份恢复会明确提示加固尚未生效。正常新发布始终要求专用非 root 用户，没有通用允许 root 开关。

仅对旧 `delivery-leases-v1` 的发布：worker 一旦尝试启动，回退到没有协议标记的 legacy 版本时，脚本只恢复 Web，保留 worker 停止状态。旧代码会接管陈旧 `running`，因此不能靠“新增列与旧代码兼容”认定重启安全。脚本输出 `DEGRADED`，显式回退返回 3；自动故障恢复保留原失败退出码，不报告完整恢复成功。未知预算、未知任务和已记录的学习事实均不会被重置或重放。

暂停记录位于 `worker-pauses/<目标路径 SHA-256>.pause`，目录 0700、文件 0600，首行保存原 worker 运行意图。发布脚本另维护 `aistudy-worker.service.d/90-aistudy-protocol-guard.conf`，用 `[Unit] ConditionPathExists=!<暂停记录>` 阻止 enabled 服务开机启动和直接 `systemctl start/restart`。条件不满足可能被 systemd 视作跳过而返回 0，验收应检查进程确实未启动。其他 drop-in 保留，原 guard 在本轮状态目录另存 `worker-protocol-guard.before`。这个安全条件按恢复目标重建，永久暂停记录不会随普通配置回滚删除。

对暂停目标，发布工具的 `restart` 主动拒绝并返回 3，`status` 检查 Web 后明确报告降级并返回 3。再次部署或回到受管新协议 release 可以恢复原运行意图，但不会删除旧目标的暂停记录；再次退回该旧目标仍受保护。管理员若确需启用 legacy，须先保持 worker 停止，核对所有残留运行任务、外部调用与费用并完成必要对账，保留备份后才人工移除对应暂停记录、reload 并检查进程；不能把未知任务改为 queued。脚本没有绕过暂停的开关。

若停止 worker、恢复指针或安装并 reload 持久 guard 无法确认成功，脚本不会继续恢复旧服务配置或启用旧 worker，会明确报告自动恢复失败并保留诊断状态，要求管理员现场处理。不能把磁盘上存在 drop-in 文件等同于 systemd 已加载条件，也不能把 stop 返回成功等同于进程确已停止。

每次配置或指针激活前还会持久写入 `activation-incomplete`，仅完整发布、回退或经健康与身份核对的一致恢复才清除。失败中断时，即使 current 已指回新版本而 unit 仍是旧的绝对路径，后续 `restart/status` 也会先报告 `INCOMPLETE` 并返回 3，不解除现有 systemd guard。管理员应从保留快照核对、修正不一致的配置，再执行受验证的发布或回退；若身份预检阻止继续，不能删除此标记绕过。手工修正 unit 本身不会清除此门禁。

```bash
bash infra/deploy/deploy-hermes.sh rollback
```

`rollback` 读取上一 transition 的原应用路径和服务配置。完整成功记录为 `succeeded`；跨协议回到 legacy 的 Web 恢复记录为 `degraded`，仍可再次回到前一受管 release。它也先保存当前状态；回退目标检查失败时，再恢复回退前的应用与配置。回退不会执行逆向 migration 或自动 `pg_restore`，以免覆盖新学习记录。业务 schema 必须继续兼容保留的 additive 迁移；不兼容的数据恢复须单独制定停机与恢复步骤。

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
