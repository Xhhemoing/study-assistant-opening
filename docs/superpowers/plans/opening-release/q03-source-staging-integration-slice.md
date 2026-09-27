# Q03 S3 reader 与来源暂存编排

接续 q03-object-staging-slice.md；主 agent 规划/review/独立验证，grok-worker(grok-4.7) 实现，模型不可用才回退 luna-fast。

## Task A：S3 streaming adapter

新增 `packages/database/src/storage/opening-backup-reader.ts`、`.test.ts`。

- `createOpeningBackupReader(storage:Pick<OpeningS3,'client'|'bucket'|'finalKey'>):OpeningBackupObjectReader`。
- finalKey 委托现有 storage 保留 this；readObject 使用 GetObjectCommand({Bucket,Key})。
- SDK Body 必须 AsyncIterable，逐 chunk yield Uint8Array/Buffer，不拼接整对象、不调用 transformToByteArray。读取/迭代错误转成无敏感文本 OpeningStorageError；404/NoSuchKey→NOT_FOUND，其余→UNAVAILABLE。
- for-await 包装确保消费者提前退出时调用底层 iterator return/destroy。保留 Node streaming，非 iterable Body 明确拒绝。
- 测试捕获真实 GetObjectCommand 参数、惰性 chunk 消费、提前关闭、流中途失败、404/其他失败、无效 Body/非字节 chunk、this 绑定；fake SDK，不连接实际 S3。可新增单独 `.integration.test.ts`（unit project 下）仅用于 reader→stage 真文件组合，不冒充服务 integration。
- 不修改 opening-s3.ts 或既有 OpeningStorage 合同，避免牵连其它 mocks。

## Task B：来源暂存编排

新增 `packages/database/src/repositories/opening-backup-prepare.ts`、`.test.ts`。

- `prepareOpeningSourceBackup(sql:Sql,scope:OpeningScope,parentDirectory:string,reader:OpeningBackupObjectReader)` 返回 `{directory,snapshot,objects}`。
- 同步复制 scope → readOpeningBackupSources (owner gate) → stageOpeningBackupObjects → assertOpeningBackupSnapshotCurrent → return。
- owner gate 失败不得调用对象 reader/创建 staging；stage 失败由 stage 自清理；复核失败则 rm 本次返回 staging directory，之后保留 owner NOT_FOUND / CONFLICT 原错误。清理失败抛无敏感文本的 cleanup failed，不吞掉失败、不宣称无残留。
- 返回的是来源原件暂存，不是 OpeningBackup、完整归档或 restore。后续仍需全表导出、历史版本、最终发布协议/加密、恢复演练。
- 测试 vi.mock repository reader/current 边界，不给生产函数添加替换鉴权 callback；真实 stage/临时目录/fake object reader，断言顺序、owner拒绝无I/O、成功文件内容、复核冲突/owner丢失无残留、stage失败不复核、scope等待期间突变不影响。
- <=200行/文件，需要拆测试可以新增 prepare-failure.test.ts，不改其它文件。

## Main 验证

先定向失败再实现；子报告不替代主验证。
`node node_modules/vitest/vitest.mjs run --project unit` 后带全部 backup unit test 文件；database typecheck；定向 ESLint；TypeScript API 显式测试 roots（包 tsconfig 排除tests）。
本轮实测 5432/9000 ECONNREFUSED；不启动服务，不 reset/migrate 未知数据库，不提交/推送/部署、不增加CLI/路由、不改变tasks状态。

## 边界

- 新增 read adapter 是真实 SDK 调用代码，不代表真实 S3 集成已经运行。
- 复核返回后仍可能发生新删除，不能把边界观测当最终发布锁。
- 可信 parent 需要私密权限；Windows ACL 未验证，调用方必须确保。
- 私有 staging 无自动过期清理，成功后由调用方清理；本轮不发布或保留真实个人数据。
