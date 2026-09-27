# Q03 对象暂存与快照复核切片

前置：q03-source-export-slice.md 已有 owner-scoped inventory 与摘要校验。当前仍无完整备份导出器。

## 任务及接口

1. grok-worker：修改 `packages/database/src/storage/opening-backup-manifest.ts`，把同步验证+canonical copy 提取为导出 `snapshotOpeningBackupSources(sources)`（保留 existing verify 行为）；新增 `opening-backup-stage.ts`、`opening-backup-stage.test.ts`（同目录）。
   - `stageOpeningBackupObjects(sources, parentDirectory, storage:{finalKey(sourceId,version):string;readObject(key):Promise<AsyncIterable<Uint8Array>>})` 返回 `{directory,objects:OpeningBackupObject[]}`。
   - 所有来源参数先通过共享 snapshot 验证；异步前复制。parentDirectory 是调用方信任的本地目录，不接受用户 URL 路径，不创建缺失的 parent。
   - mkdtemp 在可信 parent 创建私有新目录，内部固定路径 objects/<canonical sourceId>/v<version>.bin；mkdir 子目录 0700，write stream flags wx/mode0600。任何时候不覆盖既有文件，不 rm 父目录。
   - 顺序 pipeline Readable.from(body)→Transform（计数、sha256，超限拒绝，不缓存整文件）→file。flush 严格比对字节数和哈希，成功才加入对象清单。
   - 任何输入/读取/哈希/大小/写入失败拒绝；创建目录后的失败清理仅本次 mkdtemp 目录。清理失败必须明确报错，不能宣称清理成功。
   - 未完成的 bytes 仅存在私有 staging，失败不返回目录或部分 manifest；调用方成功后负责生命周期。不上传、不压缩、不对外发布。
2. grok-worker：新增 `packages/database/src/repositories/opening-backup-current.ts` 与 `.test.ts`。
   - `assertOpeningBackupSnapshotCurrent(sql,scope,snapshot):Promise<void>`：同步复制 snapshot 中 workspace/epoch/journal/source metadata，再调用 readOpeningBackupSources(sql,scope)，重新鉴权。
   - snapshot workspace 必须等于 scope workspace（UUID case-insensitive）。现时和输入的 epoch、完整 journal sourceId/deletedAt、来源 sourceId/version/bytes/sha256 集合一致，顺序不影响，hash/UUID case-insensitive。任何变化抛 generic CONFLICT，不包含正文/IDs。owner 错误从 existing reader 传播 NOT_FOUND。
   - 文档明确仅边界观测，不能阻止返回后新删除，也不是全表/DB+S3原子保证；最终发布协议待设计。

## 测试及主 review

先失败回归，再实现。文件均不超过200行；测试超限拆独立文件须先报告。不触碰其它 dirty 文件、不改 barrel/路由/migration、不提交/部署。

- `node node_modules/vitest/vitest.mjs run --project unit packages/database/src/storage/opening-backup-stage.test.ts packages/database/src/storage/opening-backup-manifest.test.ts packages/database/src/repositories/opening-backup-current.test.ts packages/database/src/repositories/opening-backup-sources.test.ts`
- `npm run typecheck -w @aistudy/database`
- 新改文件定向 ESLint，TypeScript API 显式 test roots 检查。
- stage 单元测试使用真实临时目录/合成字节、fake object reader：输出内容/hash、多个对象、空清单、事先输入校验、短/超限/错误hash/读取中断清理、保留 parent sentinel、异步输入更改、禁止全文件内存缓冲。
- current 测试 mock 已验证 reader 边界：相同/重排/大小写、workspace错配、epoch变化、journal变化、任意来源变化、owner失败、等待期间输入突变。

## 交付界限

纯本地文件和受控 reader 测试不是 S3/DB 集成证明。未接真实 S3 流适配器、完整表导出、最终安全发布/加密、恢复或删除竞态锁。本轮无 migration，无生产数据；失败只清理自己创建的 staging。不提升 Q03 状态。主 agent 独立review、复跑并记录证据；grok不可用才回退luna-fast。
