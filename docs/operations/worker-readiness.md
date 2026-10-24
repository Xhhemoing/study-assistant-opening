# OPT12 Worker 启动与消费者就绪

Worker 的 systemd `active` 只代表进程存在，不代表解析器预检完成或队列可消费。

## 就绪凭据

- 启动时先删除旧凭据；每个角色的完整消费者集合都 `await waitUntilReady()`，并核对 Redis CLIENT LIST 中本 PID/启动 UUID 命名的 BullMQ blocking consumer（`rawname`），同时验证 running、未 paused。
- 成功后原子写 JSON：实际消费者 PID、tsx supervisor PID、真实 release 目录、role、完整 queue kinds、检查时间和 15 秒有效期。每 5 秒复核；连接错误、消费者错误/关闭、parser lease 失效、正常退出立即删除，失联/冻结不能无限保留就绪。
- `hermes-health.mjs` 在现有 systemd MainPID/命令路径/账号核验之外读取凭据，并验证消费者 `/proc` 的 release、命令路径与直接父子 PID（tsx CLI 会派生实际运行进程）。无凭据、过期、角色/队列集合不一致均失败；`hermes-release.sh` 有界等待冷启动，不再看到 Web healthy 就立即用 active 放行。
- 默认文件 `.tmp/worker-<role>-ready.json`。受管 provision 写到可写 `/var/cache/aistudy-worker/worker-ready.json`；多角色实例必须分别指定 `WORKER_READINESS_FILE`。不支持 Redis CLIENT LIST/SETNAME 的后端会 fail closed。

## 预检成功缓存与预热

`PARSER_PREFLIGHT_TIMEOUT_MS` 默认 120000（1000..600000）；`PARSER_PREFLIGHT_CACHE_TTL_MS` 默认 3600000（0..86400000，0 禁用复用）；`PARSER_PREFLIGHT_CACHE_FILE` 默认 `.tmp/parser-preflight-success.json`，受管 provision 置于 Worker cache 目录。

缓存只保存成功的 `opening_parser --check`、成功时间与指纹。Python executable/venv 安装包目录、依赖锁、解析代码、本地 HF/Torch/OCR 模型目录参与指纹：小源码/锁做内容 hash，大型依赖/模型记录真实路径、大小、mtime、ctime（假定模型本地只读，不防恶意元数据伪造）。损坏、过期、未来时间、路径/指纹改变或无法读取指纹都会执行真实预检，失败清除旧凭据、不缓存失败。OCR 推理和数据库健康租约仍每次真实启动执行，预检缓存不替代 OCR 健康，也不代表消费者就绪。

显式预热（仓库根目录、与 Worker 相同账号/环境）：

```sh
node --env-file=/path/to/worker.env --import tsx apps/worker/src/parsers/warmup.ts
```

CLI 强制真实预检并更新成功缓存，再执行 OCR 健康检查；无 Redis/DB 连接，不发布就绪凭据。受管部署需同时加载 production.env 和 worker-runtime.env 的实际运行变量，不改变生产配置即可由运维在获得授权后执行。

## 进程内退避

启动失败清理 Worker/Queue/SQL/Redis 连接后，进程内等待 `WORKER_STARTUP_RETRY_INITIAL_MS`（默认5000），指数增加到 `WORKER_STARTUP_RETRY_MAX_MS`（默认60000），上限不得小于初值，二者范围1000..300000。SIGTERM/SIGINT 中断等待；不依赖快速 systemd 重启反复加载 Python。成功就绪后连接等不可恢复运行故障 fail-stop，交既有 supervisor 恢复；OCR 健康失败按下节仅降级解析消费者。`WORKER_READY_TIMEOUT_MS` 默认30000（1000..300000）。配置格式错误在任何连接分配前拒绝；修正环境后再启动。

新部署门禁按新协议 fail closed。自动恢复/显式回滚只在可信私有恢复快照与目标版本匹配、旧版本确实不含消费者就绪模块时，沿用既有进程身份检查；明确输出“历史消费者就绪未验证”，仍需独立队列消费验收。支持凭据的版本回滚仍必须提供新鲜凭据；不允许用恢复路径、旧凭据或其他进程伪装新版本就绪。

## OCR 运行期降级

`PARSER_OCR_PREFLIGHT_TIMEOUT_MS` 默认 120000（1000..600000），独立于导入预检预算。单次/两次探针或报告写入失败只允许沿用仍有效的旧健康租约；连续三次失败或租约到期暂停 `parse`/`parse-media`，不关闭学习队列或中断正在执行的解析。健康报告成功写入后复用原消费者恢复，不新建 Worker。

最近成功解码的文档/分段输出可在有活跃解析且证据未过期时替代新的推理探针；仅“队列繁忙”、旧缓存、失败输出不能续租。租约到期仍有同步准入检查；挂起续约有独立截止时间，关闭会取消探针，迟到完成不能复活已关闭 Worker。

解析降级删除完整消费者就绪凭据，学习队列仍被独立检查；恢复解析并重新验证完整消费者后才发布凭据。真实 Redis、70 页 PDF 并发和持续跨启动窗口的验收仍属于发布前待执行项，单元模拟不替代它们。

## 开发验证命令

```sh
npm run typecheck -w @aistudy/config
npm run typecheck -w @aistudy/worker
npx vitest run --project unit packages/config/src/env.test.ts packages/config/src/server-config.test.ts apps/worker/src/parsers/parser-preflight-timeout.test.ts apps/worker/src/parsers/preflight-cache.test.ts apps/worker/src/runtime/worker-readiness.test.ts apps/worker/src/runtime/worker-role.test.ts apps/worker/src/runtime/parser-health-lease.test.ts
node --test tests/tooling/worker-readiness.test.mjs tests/tooling/hermes-runtime.test.mjs tests/tooling/hermes-deployment.test.mjs
python3 -m unittest discover -s tests/tooling -p 'provision_worker_test.py'
npx tsx scripts/env-examples.ts --check
```

后续隔离真实 Redis 验收：三种 role 分别启动，核凭据完整队列集合；停 Redis/关闭一个 consumer/发送 SIGTERM 后门禁必须失败；停止后重启需新 PID，旧凭据不能通过。真实模型冷启动与运维发布需另行授权。
