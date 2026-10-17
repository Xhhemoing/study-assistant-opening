# Worker 专用用户与回滚

`infra/deploy/provision-worker.sh` 在服务器本地以 root 执行，只准备身份、权限和 systemd 配置；不启动、停止、重启或启用服务。发布脚本负责串行发布、数据库备份、切换 `current`、健康检查及失败回退。首次切换前保留旧应用目录及其中的配置、venv 和模型缓存。

## 发布接口

构建新 release 后，在替换配置和切换 `current` 前调用。`--app-dir` 是稳定指针，`--release-dir` 是本次已构建的新目录；两者在切换前可以指向不同版本。

```bash
bash "$release/infra/deploy/provision-worker.sh" \
  --app-dir "$current" --release-dir "$release" \
  --legacy-app-dir /opt/aistudy \
  --config-file /opt/aistudy/.env.production \
  --parser-python /opt/aistudy/.local/docling-venv/bin/python \
  --state-dir "$transition"
```

默认配置位置为 `/etc/systemd/system/aistudy-worker.service` 和 `/etc/aistudy/worker-runtime.env`；隔离测试可传 `--systemd-dir`、`--config-dir` 和 `--cache-dir`。脚本与相邻的 `provision-worker.py` 必须一起部署，依赖服务器现有 Python 3、systemd、`runuser`、`useradd` 和 `groupadd`。

专用账号 `aistudy-worker` 使用同名主组和禁止登录的 shell。已有同名账号若指向 root、其他主组或交互 shell，脚本会停止，要求运维先核对身份，不擅自改造既有账号。

新 release 的目录、代码和依赖由 root 持有，worker 只有读取与必要的执行权限，包括以 `umask 077` 构建的 `node_modules`。内部 symlink 不跟随，外链指向可写 cache 或临时目录时拒绝发布；`.local` 与 `.tmp` 不被整树改权。配置文件内容保持原样，实际配置文件权限收紧为 root `0600`，由 systemd 读取后注入环境，worker 不需要直接读取它。

## 缓存与解析路径

首次创建 `/var/cache/aistudy-worker` 时，把旧 `HF_HOME`（未配置时为旧应用的 `.local/hf-home`）复制到其中的 `hf-home`。复制保留 Hugging Face 内部相对 symlink，拒绝缺失链接和指向复制范围以外的链接，排除根目录的 `token` 和 `stored_tokens` 登录凭据；旧缓存不删除、不移动。已有 worker 缓存不被旧缓存覆盖，也不会被 root 递归改权；缓存目录本身必须是真实目录且属于专用用户，symlink 或未知所有权会阻止发布。

独立的 `worker-runtime.env` 位于原 `EnvironmentFile` 之后，固定 `HOME`、HF/Torch/XDG 缓存、本地 Python、当前代码的 parser 目录与临时路径，避免旧配置覆盖这些路径。`PARSER_TEMP_DIR=/tmp/opening-parser`、`TMPDIR=/tmp` 配合 `PrivateTmp=true`；`ProtectSystem=strict` 只开放专用 cache，不再开放整棵源码。原 OCR 模型配置继续使用；模型文件需对 worker 只读可访问。

venv 保留既有绝对路径。脚本将选定 venv 的普通目录和文件设为 root 持有、只读可执行，跳过 symlink 目标。解释器不能位于 `/root` 或 `/home`，因为 unit 启用 `ProtectHome=true`。venv 的父目录也必须允许专用用户搜索；若 `.local` 是私有目录，应先定向授予搜索权限或将 venv 准备到专用 `/opt` 路径，勿扩大生产密钥文件权限。

替换 unit 前，脚本通过 `runuser` 以专用用户和明确的空环境起点，在本次新 release 中执行 `python -m opening_parser --check`，再验证生成的 systemd unit。reload 后读取实际生效的用户、组、只读限制、代码/cache 路径和环境文件顺序；已有 drop-in 覆盖这些边界时停止并还原配置，不擅自删除现场 drop-in。缺少读取权限、OCR 文件或 Python 依赖同样会使发布失败。解析检查只验证导入与配置；现场验收还需在相同身份及 systemd 文件系统限制下运行真实 PDF/PPTX 转换、材料上传、队列消费及临时文件清理。不能把本地模拟测试称为线上切换成功。

worker 的停止宽限期为 1,200 秒，覆盖通常最长 900 秒的 Docling 转换。更长媒体作业仍可能被停止；它们由作业心跳/失联恢复进入待核对的未知终态，不自动重发外部调用或释放未知预算。

## 配置快照与恢复

每次发布或显式回退使用独立的 `--state-dir`。只捕获配置时无需提供应用路径：

```bash
bash "$helper" --snapshot --state-dir "$transition"
bash "$helper" --restore --state-dir "$transition"
```

若使用了自定义 `--systemd-dir` 或 `--config-dir`，恢复时传入同样的路径。`worker-before/` 保存原 unit、原 runtime env（不存在时记 `.absent`）、目标路径和原 active/enabled 状态的 `manifest.json`，以及完整标记 `ready`。完整快照不覆盖；半份快照拒绝继续，保留供检查。目录为 root `0700`。

`--restore` 只恢复这两份 worker 配置并执行 `daemon-reload`，不会改变服务启用状态，也不会恢复数据库或重置未知作业。发布调用方先停止需要切换的 worker、回退代码指针、还原 web 配置，再调用此接口，并按发布前状态恢复服务、检查健康。provision 写配置或 reload 失败时也会尝试恢复自身配置，同时保留失败退出码。新用户与新 cache 保留不影响回退，旧 venv/cache 始终仍在。

跨执行协议回退另由发布脚本约束：尝试启动过带 claim-token 的 worker 后，不能自动启用会接管陈旧 running 的 legacy worker。发布脚本会保留 root 私有暂停记录，并安装 `90-aistudy-protocol-guard.conf` 的 `ConditionPathExists=!<暂停记录>`，阻止直接启动和开机自动启动；helper 不删除该 drop-in 或暂停记录。Web 恢复与 worker 暂停会明确报告为降级，发布工具 `restart/status` 返回 3。首次迁移失败且新 worker 从未尝试启动时仍可恢复原服务；新协议之间正常回退。完整处理及管理员对账步骤见 [hermes-deployment.md](hermes-deployment.md)。

## 本地验证

`node --test tests/tooling/provision-worker.test.mjs` 执行 Python 标准库行为测试，覆盖配置不执行、身份创建、只读产物、缓存与 symlink、重复执行、快照、失败还原及首次安装回退。测试使用临时目录并模拟账户与 systemd 命令，不修改本机用户或服务；生产权限、SSH 与模型可用性仍需现场确认。
