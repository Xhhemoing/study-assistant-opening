# Authorized Data Connections Implementation Plan

> **For agentic workers:** Use executing-plans task-by-task; steps use checkbox syntax. This plan adds requirements, not completed capabilities.

**Goal:** 接入学校自建邮箱与实际获准的钉钉学习数据，复用成熟协议库，不再把主动提交当作全部数据采集。
**Architecture:** 现有worker运行连接适配器，私有S3保存原件，PostgreSQL记录授权、游标、来源与幂等结果；接入与课程理解分层。
**Tech Stack:** Node.js20+、ImapFlow、MailParser、既有BullMQ/PostgreSQL/S3；EmailEngine仅为单独批准的商业备选。

## Global Constraints

遵循[需求补充](../../specs/2026-09-14-learning-capability-expansion.md)、[X01协议](capability-interfaces.md)、[复用证据](../../../quality/opening-capability-reuse-research.md)。不自写IMAP/MIME实现，不自建邮件服务器，不抓取未授权聊天。学校自建不预设协议可用。
所有新模块≤200行。连接默认关闭；无凭据、无学校IMAP或钉钉权限只阻塞实接，不伪造ready。新任务只能planned→active→verified，真实门禁未满足保持blocked。

### X01: Additive capability contracts and library adoption checks

**Owner:** INTEGRATOR. **Depends:** F02.
**Create:** `packages/contracts/src/opening/connections.ts`, `imports.ts`, `media.ts`, `knowledge.ts`, `proactive.ts`（均在同目录）；`packages/contracts/src/opening/capabilities.test.ts`。
**Modify:** `packages/contracts/src/opening/sources.ts`、`index.ts`；`apps/worker/package.json`、`package-lock.json`仅在制品验证后变更。
**Interfaces:** 本目录`capability-interfaces.md`全部DTO与API定义；secret不属于ConnectionView；现有F02字段不删除。

- [ ] 写协议失败测试：连接输出拒绝secret、无效TLS模式拒绝、支持视频与eml但按各自限额拒绝超限；旧PDF输入仍通过。
```ts
it('never exposes credentials in a connection view', () => {
  expect(connectionViewSchema.safeParse({id:U,version:0,kind:'imap',label:'学校',state:'disabled',allowedScopes:[],lastSuccessAt:null,errorCode:null,secret:'private'}).success).toBe(false);
});
```
测试文件导入Vitest和`connectionViewSchema`，`U='11111111-1111-4111-8111-111111111111'`。
- [ ] 运行`node node_modules/vitest/vitest.mjs run --project unit packages/contracts/src/opening/capabilities.test.ts`确认失败，再实现strict schema和兼容性导出。
- [ ] 从实际registry制品核验ImapFlow/MailParser版本、integrity、Node兼容及LICENSE并锁版本；研究源码版本2.0.2/3.9.26不是安装证据。扫描依赖风险并保存采用清单；禁止默认引入EmailEngine商业服务。
- [ ] 重跑同测试及`npm run typecheck -w @aistudy/contracts`。固定依赖失败时只阻塞库适配部分，契约不借用未证实API。

### C01: Connection consent, credentials, lineage and revocation

**Owner:** DATA+PIPELINE. **Depends:** X01,F03,M02,P02.
**Create:** `packages/database/src/schema/opening-connections.ts`、`repositories/opening-connections.ts`、`repositories/opening-imports.ts`、`migrations/0021_opening_connections.sql`；`apps/worker/src/connectors/credential-vault.ts`、`import-identity.ts`、`import-identity.test.ts`；`apps/web/src/features/opening/connections/service.ts`；`tests/integration/handler/opening-connections.test.ts`。
**Create routes:** `apps/web/src/app/api/opening/connections/route.ts`、`imap/route.ts`、`dingtalk/route.ts`、`[id]/credential/route.ts`、`[id]/check/route.ts`、`[id]/sync/route.ts`、`[id]/revoke/route.ts`（后六条均在connections目录下）。
**Interfaces:** `importIdentityKey(identity:ImportIdentity):string`；连接版本+privacyEpoch同时约束worker读取与最终写回。迁移0021须在既有0020后注册，不覆盖历史迁移。

- [ ] 先测UIDVALIDITY和连接隔离，禁止Message-ID单独去重：
```ts
it('does not conflate two mailbox generations', () => {
  const a={connectionId:'c',container:'INBOX',generation:'1',remoteId:'9'};
  expect(importIdentityKey(a)).not.toBe(importIdentityKey({...a,generation:'2'}));
});
```
- [ ] 运行`node node_modules/vitest/vitest.mjs run --project unit apps/worker/src/connectors/import-identity.test.ts`和隔离库`npm run test:handler -- opening-connections`确认红灯。
- [ ] 以Node标准crypto实现AES-GCM凭据封装而非自创密码算法；唯一nonce/AAD/workspace绑定、keyId轮换、secret与备份隔离。TLS端点来自用户配置的主机allowlist，防SSRF/元数据地址，STARTTLS强制升级且验证证书；校内私网端点需明确管理员配置，不通过关闭证书校验解决。
- [ ] 事务保存connection/import receipt/游标；唯一约束覆盖connection/container/generation/remoteId。撤销删凭据、增版本并取消队列；运行中旧版本不得写回。暂停/撤销不擅删原邮箱，也不隐式删除已导入原件；独立删除走M02并留下阻止重导入的墓碑。
- [ ] 同命令复测：跨workspace、日志秘密检查、重复导入、撤销竞态、备份无凭据。迁移测试`npm run test:integration -- migration`。回滚先关闭连接worker、撤销凭据，保留新表与原件供修复，不执行破坏性down migration。

### C02: School-hosted IMAP ingestion with open-source adapters

**Owner:** PIPELINE. **Depends:** C01,I01,I03.
**Create:** `apps/worker/src/connectors/imap-client.ts`、`imap-sync.ts`、`imap-sync.test.ts`、`mail-parser.ts`、`mail-parser.test.ts`；`apps/worker/src/jobs/sync-mail.ts`；`apps/web/src/app/api/opening/imports/email/route.ts`；`tests/integration/opening-imap-sync.test.ts`；`tests/fixtures/opening/mail/README.md`及合成`.eml`；`docs/operations/opening-mail.md`。
**Interfaces:** `nextImapCursor(previous:ImapCursor,uid:number):ImapCursor`只在一封邮件来源/附件提交成功后调用；generation变化由同步器另行重置范围。`syncMailbox({connectionId,signal}):Promise<{imported:number;skipped:number}>`在worker读取凭据和allowlist，不接受任意远程URL。

- [ ] 先测游标不倒退、断线重放不重复、坏附件不提前推进：
```ts
it('never moves a committed UID cursor backwards', () => {
  expect(nextImapCursor({folder:'INBOX',uidValidity:'7',lastUid:10},9).lastUid).toBe(10);
});
```
- [ ] 运行`node node_modules/vitest/vitest.mjs run --project unit apps/worker/src/connectors/imap-sync.test.ts apps/worker/src/connectors/mail-parser.test.ts`确认红灯；使用注入客户端测试双重投递/取消，不自制产品协议栈。
- [ ] 复用ImapFlow按固定版本文档开启只读邮箱访问、UID检索和流下载；不STORE flags、不EXPUNGE、不发送邮件。用MailParser流解析字符集/正文/附件，附件流逐个释放；默认纯文本、不执行HTML、不加载跟踪像素、附件名不作路径。
- [ ] 每轮100封，先过滤folder/since再拉正文；按X01邮件/附件上限流式计数，超限明确失败，失败UID保留可重试。原始邮件和附件复用I01不可变原件提交边界，导入关系连到同一receipt；不伪装客户端上传完成。
- [ ] 使用隔离的标准IMAP测试服务完成`npm run test:integration -- opening-imap-sync`：TLS、编码、附件、连接中断、UIDVALIDITY变化、服务重启、重复Message-ID；无真实测试服务则本门禁blocked。
- [ ] 学校实接单独验收：先核对帮助页的host/port/TLS/认证，用户选择文件夹/日期；读一封授权测试邮件及附件，证明未改已读/未删除，再撤销连接。学校无IMAP则记录原因、提供`.eml`导入，不把手工路径算作CAP01自动同步通过。

### C03: Permission-aware DingTalk learning-data adapter

**Owner:** PIPELINE. **Depends:** C01,I01,I03.
**Create:** `apps/worker/src/connectors/dingtalk-client.ts`、`dingtalk-policy.ts`、`dingtalk-policy.test.ts`；`apps/worker/src/jobs/sync-dingtalk.ts`；`apps/web/src/app/api/opening/connections/dingtalk/events/route.ts`；`tests/integration/opening-dingtalk.test.ts`；`docs/operations/opening-dingtalk.md`。
**Interfaces:** `canReadDingTalkResource(requiredScope:string,grantedScopes:string[]):boolean`；适配器统一产出ImportIdentity/ImportReceipt。事件回调仅接受已配置应用、验签/解密和防重放，不以回调内容扩展授权。

- [ ] 写失败测试：
```ts
it('does not treat robot send permission as permission to read messages', () => {
  expect(canReadDingTalkResource('messages.read',['robot.send'])).toBe(false);
});
```
这里权限字符串为内部能力名，不冒充钉钉官方scope；实现前建立经官方文档核对的映射。
- [ ] 运行`node node_modules/vitest/vitest.mjs run --project unit apps/worker/src/connectors/dingtalk-policy.test.ts`确认失败。
- [ ] 在operations文件记录实际官方API URL、SDK制品/许可、企业内部/第三方应用类型、组织管理员需求、可读通知/文件资源、分页/限流、回调验签方式。只实现已获授权能力；没有历史群聊API则明确不支持历史读取，不以机器人能发消息推断能收历史。
- [ ] 实现SDK薄适配、幂等事件和附件接收；附件只能来自验证事件中的受准资源并经受限下载器处理，不让模型提供下载地址。未授权显示needs_authorization；同时支持现有上传入口提交导出/截图并标manual。
- [ ] 重跑单测及`npm run test:integration -- opening-dingtalk`：伪造签名、过期回调、重复事件、分页限流、撤销、跨组织ID。真实组织授权/通知/文件样本单列验收；权限阻塞不阻塞C02/V01独立开发，但CAP02不得标实接完成。
