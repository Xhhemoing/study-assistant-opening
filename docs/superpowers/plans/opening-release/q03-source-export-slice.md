# Q03 来源导出底层切片

## 范围与分工

保留当前 dirty worktree，不提交/推送/部署，不触发模型业务调用。主 agent 规划、review、独立验证；grok-4.7 实现限定任务，模型不可用才回退 gpt-5.6-luna-fast。

1. 新增 `packages/database/src/repositories/opening-backup-sources.ts`、相邻 `.test.ts`、`tests/integration/opening-backup-sources.test.ts`。
   - `readOpeningBackupSources(sql, scope)` 返回 `{workspaceId,privacyEpoch,deletionJournal,sources}`。
   - 单个 repeatable read/read only 事务；先用 workspaceId + ownerUserId 查询 owner，未匹配抛 NOT_FOUND，再查询元数据。
   - 来源仅 uploaded 且不在该 workspace 的隐私排除日志；固定 SQL，明确列投影 id/version/bytes/sha256，顺序稳定。
   - sources 类型 `{sourceId:string;version:number;bytes:number;sha256:string}`；journal 时间 ISO 字符串。
   - 不返回 OpeningBackup、不导出正文/密钥/会话、不假装完整归档；不修改 barrel。
2. 新增 `packages/database/src/storage/opening-backup-manifest.ts` 与相邻 `.test.ts`。
   - `verifyOpeningBackupObjects(sources, storage)`；storage 为现有 OpeningStorage 的 finalKey/streamDigest 子集。
   - 验证 UUID、version 非负安全整数、bytes 正安全整数、sha256 64 hex、重复 source ID；所有输入先校验再 I/O。
   - 顺序调用 `streamDigest(finalKey(sourceId,version), bytes+1)`；真实摘要与大小严格匹配，否则拒绝整个 Promise，不返回部分成功。
   - 返回 OpeningBackupObject[]；archivePath 固定 `objects/<sourceId>/v<version>.bin`；actualSha256 来自存储读取而非输入。
   - 未复制对象字节；不能声称文件已归档，也不能声称跨 DB/S3 原子快照。
3. 主 agent 审查授权、事务、隐私和类型边界，复跑 focused unit、database typecheck、定向 ESLint；检查新 integration roots 的类型并在 guarded test DB 可用时运行集成。

## 验证命令

- `node node_modules/vitest/vitest.mjs run --project unit packages/database/src/repositories/opening-backup-sources.test.ts packages/database/src/storage/opening-backup-manifest.test.ts`
- `npm run typecheck -w @aistudy/database`
- `node node_modules/eslint/bin/eslint.js packages/database/src/repositories/opening-backup-sources.ts packages/database/src/repositories/opening-backup-sources.test.ts packages/database/src/storage/opening-backup-manifest.ts packages/database/src/storage/opening-backup-manifest.test.ts tests/integration/opening-backup-sources.test.ts`
- 集成仅允许显式 OPENING_TEST_DB=1 + loopback aistudy_opening_test；不迁移或 reset 预览/生产数据库。

## 边界及下一阶段

本轮实测 127.0.0.1:5432/6379/9000 均 ECONNREFUSED。unit 模拟不替代真实数据库或 S3 验收。
来源清单未覆盖记忆/课程/学习/计划表及历史版本；后续需完整表关系导出、对象字节复制、删除日志最终校验、隔离恢复与 SHA 绑定 CI。不得调用本组件后直接宣布 Q03 或 M02 restore 完成。无 migration，无数据库写入，因此无数据回滚操作；代码回滚仅限本轮新增文件。
