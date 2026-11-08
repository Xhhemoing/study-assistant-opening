# 数据库迁移操作手册

本文覆盖身份迁移 Gate 0.1 和 migration registry Gate 0.2 的数据保全流程。生产迁移唯一入口是 `npm run db:migrate`，它只调用 `packages/database/src/migrate.ts` 的 canonical runner。

## 1. 发布前阻断条件

出现以下任一情况时停止升级：

- 没有升级前备份，或未在隔离数据库验证备份可恢复；
- preflight 返回 `IDENTITY_ORPHAN_WORKSPACES`，但没有经审批的 owner 映射；
- 已记录 legacy-unverified `0003_identity.sql`、`0004_identity_repair.sql` 尚未执行、且没有 fingerprint 一致的 operator attestation；
- `library_revisions_no_delete` 或 `library_revisions_no_update` trigger 缺失；
- `learning_events_no_delete` 或 `learning_events_no_update` trigger 缺失（`0012` 拒绝 UPDATE，`0014_learning_event_delete_guard.sql` 拒绝普通 DELETE；不要给应用角色加 session-variable 旁路）；
- registry 出现未知 ID、非法/重复/跳号 migration version、未知 verification state，或 verified checksum 漂移。

不要修改已发布的 migration SQL，不要删除 orphan workspace，不要创建伪造 user 接管数据。历史迁移 ID 包含下划线（例如 `0004_identity_repair.sql`），不可重命名；新旧 ID 均须遵循 `^([0-9]{4})_[a-z0-9_-]+\.sql$`、版本从 `0001` 连续递增且唯一。

## 2. 备份与数据库指纹

1. 停止会写入数据库的 Web/Worker 实例或进入维护窗口。
2. 使用受控凭据执行 PostgreSQL custom-format 备份：

```bash
pg_dump --format=custom --file=/secure/backups/aistudy-pre-identity.dump "$DATABASE_URL"
sha256sum /secure/backups/aistudy-pre-identity.dump \
  > /secure/backups/aistudy-pre-identity.dump.sha256
```

3. 在隔离数据库恢复并运行应用只读 smoke test：

```bash
createdb aistudy_restore_rehearsal
pg_restore --exit-on-error \
  --dbname=aistudy_restore_rehearsal \
  /secure/backups/aistudy-pre-identity.dump
```

4. 在私有运维记录中保存备份位置、SHA-256、操作者、备份开始/完成时间（含时区）、目标数据库身份、数据库 fingerprint 以及恢复演练结果。将备份绑定到精确应用/runner SHA、已登记迁移 ID/checksum 和预期恢复时间点；核对备份文件完整性，并在新建空隔离数据库恢复后核对 registry、关键行数、约束/trigger 和只读应用结果。`identity_owner_mappings.database_fingerprint` 和 legacy `0003` attestation 都必须等于 canonical runner 为目标数据库和当前 schema 生成的值。
5. 由 PM 明确备份执行者、恢复执行者和完整性验收责任人，记录原授权、恢复可接受的数据损失窗口及停机窗口。迁移后的新增学习记录不在迁移前备份内，恢复旧备份不能被描述成无损回退。备份、恢复演练、真实恢复与切换分别按其操作边界取得授权；本文不授予执行权。

以上是待执行流程，不是备份或演练已完成的证据。恢复目标必须是新建空隔离数据库；不要将示例改为对真实学习数据库执行覆盖式 `pg_restore`。真实恢复需另行评估并获用户明确批准，包含迁移后新增数据的保全/核对方案和验收后切换方案。不要在公开仓库保存真实数据库身份、凭据、attestation、备份文件或原始恢复日志。

## 3. 运行 Preflight 与 Canonical Runner

运行唯一 production command：

```bash
DATABASE_URL="$DATABASE_URL" npm run db:migrate
```

runner 以 numeric version 读取 migration，取得 PostgreSQL session-level advisory lock 后才 bootstrap registry、验证已记录历史、逐文件事务执行并写 registry。新执行的 migration 记录 SHA-256 和 `verified`；既有 registry 行保留为 `legacy-unverified`，不会倒推或声称其 checksum 已验证。

存在 orphan 时 runner 抛出 `IDENTITY_ORPHAN_WORKSPACES`，并为每个 workspace 返回 ID、当前 owner ID、document/block/revision/relation/property/course/membership 数量。报告不包含标题、正文、revision blocks 或密码，应存入受限运维记录。

## 4. 处置 Owner 映射

仅在身份来源经过人工核对且目标 `users.id` 已存在时写入映射。`original_owner_user_id` 是迁移前 workspace owner，`owner_user_id` 是经验证的替代 owner：

```sql
INSERT INTO identity_owner_mappings (
  workspace_id,
  original_owner_user_id,
  owner_user_id,
  operator,
  source,
  database_fingerprint,
  backup_evidence
) VALUES (
  '<orphan-workspace-uuid>',
  '<missing-legacy-owner-uuid>',
  '<verified-user-uuid>',
  '<operator identity>',
  '<approved ownership source>',
  '<database fingerprint>',
  '<verified backup evidence path and checksum>'
);
```

runner 仅在 workspace 仍由 `original_owner_user_id` 持有、该原 owner 不存在、目标 user 存在、fingerprint 匹配且映射未应用时修改 owner。任何未映射 orphan 均会 fail closed。

## 5. Attest 已记录旧 0003

若 registry 已记录 `0003_identity.sql` 为 `legacy-unverified` 而 `0004_identity_repair.sql` 仍待执行，生成并受控保存一个 JSON 文件，内容必须包含当前 database fingerprint、按字典序的 observed registry IDs、操作人、非空 preflight 摘要和备份证据：

```json
{
  "databaseFingerprint": "<canonical fingerprint>",
  "observedMigrationIds": ["0001_library.sql", "0002_courses.sql", "0003_identity.sql"],
  "operator": "<approved migration operator>",
  "preflightSummary": "<reviewed orphan/owner report summary>",
  "backupEvidence": "<backup URI and SHA-256>"
}
```

将文件放在受限路径，以环境变量传入，不要提交：

```bash
DATABASE_URL="$DATABASE_URL" \
MIGRATION_LEGACY_0003_ATTESTATION_FILE=/secure/migrations/legacy-0003-attestation.json \
npm run db:migrate
```

runner 将 attestation 持久化在同一 schema 的 `migration_attestations`，并再次比较当前 fingerprint、完整 observed IDs、操作人和两个非空证据字段。缺失、格式不合法、过期或错库 attestation 一律返回 `MIGRATION_LEGACY_0003_ATTESTATION_REQUIRED`；attestation 通过后仍必须通过 orphan preflight 才会执行 `0004`。

## 6. 迁移后验证

确认 registry 和 owner 完整性：

```sql
SELECT id, checksum, verification_state, recorded_at
FROM schema_migrations
ORDER BY id;

SELECT w.id, w.owner_user_id
FROM workspaces w
LEFT JOIN users u ON u.id = w.owner_user_id
WHERE u.id IS NULL;
```

第二个查询必须返回零行。确认 revision triggers 已启用：

```sql
SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'library_revisions'::regclass
  AND tgname IN (
    'library_revisions_no_delete',
    'library_revisions_no_update'
  )
ORDER BY tgname;
```

两行的 `tgenabled` 都必须为 `O`。确认 learning event 追加写保护：

```sql
SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'learning_events'::regclass
  AND tgname IN (
    'learning_events_no_delete',
    'learning_events_no_update'
  )
ORDER BY tgname;
```

两行的 `tgenabled` 都必须为 `O`。对升级前记录的 workspace、document、block、revision、relation、property、course 和 membership 行数逐项比较，任何减少都阻断发布。

## 7. 失败恢复

- preflight、attestation 或 `0004` 失败：保持服务停止，保存错误与数据库状态；修正经审批的受控映射或 attestation 后重试。若需恢复，先按第 2 节在新建空隔离数据库验证已授权备份，再另行批准真实恢复与切换，不直接覆盖当前学习数据。
- 已记录旧版 `0003` 且数据已被删除：`0004_identity_repair.sql` 无法恢复数据。必须从已验证备份恢复到隔离环境，确认完整性后执行正式恢复；无备份时阻断发布并进入人工数据重建流程。
- trigger 验证失败：立即停止写入；按第 2 节另行批准恢复，或经审批在受控事务中修复 trigger 后重新验证；不要在保护关闭时开放应用流量。

## 8. 0108 跨版本兼容与回退（操作方案，尚未执行）

### 8.1 源码依据与授权顺序

本节只读核对主线 `be641ce61c15c3a85a4e5ce7ea613c53321bc79f` 的
`packages/database/src/migrate.ts`、`scripts/db-migrate.ts`、
`packages/database/src/repositories/opening-knowledge.ts`，以及
[#230](https://github.com/Xhhemoing/study-assistant-opening/pull/230) 冻结提交
`8ab660eefb3c7c5edcc32cf8df7847a5086cd21d` 同路径源码和
`packages/database/src/migrations/0108_opening_knowledge_confirmations.sql`。
这是两个精确版本的源码结论，不是当前数据库状态或恢复成功的证明；后续候选改变时必须重新核对。

发布顺序保持：**先完成本轮首个无迁移安全发布，再合 #230**。合入不等于批准执行
0108；含迁移部署和迁移执行仍需用户对每次操作、精确 SHA 和目标分别明确批准，由唯一 PM
安排。既有 2A 分工不变；本说明不授权 worker 合并、部署、迁移或操作真实数据。

### 8.2 升级前只读核对

由获准操作者使用只读连接，在迁移/部署前保存以下结果到私有记录；本次文档工作未连接数据库：

```sql
BEGIN READ ONLY;
SELECT id, checksum, verification_state, recorded_at
FROM schema_migrations ORDER BY id;
SELECT to_regclass('opening_knowledge_confirmations') IS NOT NULL
  AS confirmation_table_exists;
COMMIT;
```

- 对照精确候选制品中 `packages/database/src/migrations/` 的全部文件：ID 格式合法、编号从
  0001 连续且唯一、数据库历史 ID 均被候选识别；对每条 `verified` 历史比较原文件的
  SHA-256（例如在获准的候选副本上用 `sha256sum`）。不得重写历史 SQL、换行、checksum
  或 verification state 来消除差异；`legacy-unverified` 也不能冒充已验证。
- 比较升级源、升级目标、拟回退目标的完整迁移集合和历史 checksum；只看最大编号或确认表是否存在不够。
  0108 未登记而表已存在，或 0108 已登记而表不存在，均停止，交人工核查，不手工补账/删表。
- canonical runner **不是只读 preflight，也没有仅执行 0108 的开关**：取得锁后先调用
  `bootstrapRegistry`（含 DDL/UPDATE），再 `verifyRegistry`，通过后执行所有待执行文件。
  不用 `npm run db:migrate` 试探旧版兼容性；有未知历史或 checksum 漂移立即阻断。
- 按第 2 节完成获准备份和空隔离库恢复验证，将精确版本、时间点、完整性结果、恢复责任人与原授权关联；
  未完成不能放行，不能用历史备份或其他版本 CI 代替本次证据。

### 8.3 表、确认语义与 reader 兼容矩阵

0108 只创建 `opening_knowledge_confirmations` 及索引，不回填或改写已有知识图谱。
记录包含 workspace/owner/course/node、节点 label/kind、确认前后图版本（后者等于前者加一）、
该节点材料版本映射及非空证据 chunk 集合。它是**当前有效确认**，不是永久不可变审计表：
#230 的 `confirmNode()` 在同一事务内将 `needs_check` 节点改为 `supported`、图版本加一并写确认；
要求课程所有权、观测图/材料版本一致且当前证据仍获授权。重复或过期提交冲突，不是幂等重放。
`replace()` 自动重建只在节点身份/label/kind、证据集合、材料版本均符合确认且节点仍存在时保留支持状态；
节点移除或手工从 supported 撤回会删除该节点确认。材料变更标记 needs_check 不删除确认，但旧材料版本不能恢复支持。

下表“旧应用”仅指上述主线精确 SHA，不外推至任意历史版本：

| 数据库状态 | 旧应用 reader / writer | #230 应用 reader / writer | canonical runner |
| --- | --- | --- | --- |
| 历史到 0107、无确认表 | 原知识快照 reader 可读；无新确认能力 | 单纯 `get()` 仍读原快照；`confirmNode()` 和正常 `replace()` 路径需确认表，不能放行完整应用 | 旧 runner 认识到 0107；#230 runner 会尝试所有待执行迁移，必须先获批准 |
| 已登记 0108 且确认表完整、尚无确认 | 旧 reader 不查询新表，快照字段/状态仍可解析；旧 writer 不维护确认规则，不能视作安全回退 | 认识表与确认协议；仍需实际验证 | 旧 runner 报 `MIGRATION_UNKNOWN_HISTORY`；#230 runner 可识别 ID，但仍须校验 checksum/全部历史 |
| 已登记 0108、已有人工确认 | 旧 reader 可读 supported/needs_check，但不理解其确认来源；旧 replace/重建不读取或撤销确认，后续前向升级可能错误恢复已撤回的确认 | 按版本和证据匹配保留/撤销确认；不得绕过冲突 | 同上；应用可解析快照不等于部署前置 runner 可通过 |
| 已登记 0108、确认表缺失 | 即便部分旧读取可用，也属损坏状态 | 确认和 replace 会失败；前向 runner 已登记而跳过 0108，不会自动补表 | 阻断，不能 DROP 后寄望重跑修复 |

结论：**旧版 runner 遇到未知已登记 0108，绝不是“安全旧版”**。SQL 注释中的增量兼容不构成跨版本回退许可。
保留确认表不等于保留应用确认语义，应用回滚也不等于数据库回滚。

### 8.4 故障分支与最小 H 后继（当前阻塞）

1. 若 0108 执行失败，停止本次发布，保存错误与只读 registry/表状态。runner 为每个文件将 SQL
   与 registry INSERT 放在同一事务内，0108 失败应一起回滚；此前已提交文件不会因此撤销。
   不假定整个批次都回滚，先核实，不自行重跑或伪造已登记行。
2. 若 0108 已成功、应用异常，先由获准操作者停住相关知识图谱写入/重建/确认入口并保全现态，
   交 PM 选择前向修复或兼容应用回退；不能绕过部署迁移前置步骤直接换旧包开放 writer。
   即使临时只读，也须单独获准并核对精确 reader，不能宣称完整回退完成。
3. 当前两个源码版本均无可批准的跨 0108 旧 runner 流程，**跨版本应用回退阻塞**。
   最小后继是独立 H PR 提供精确回退候选：保留原样 0108 迁移文件并由 canonical runner
   识别/校验已登记 checksum，不忽略其他未知历史、不重放已登记迁移；同时保留或受控禁止
   会破坏确认保留/撤销语义的旧 writer。需测试“0108 已登记且有确认”的前向→回退→再前向，
   包括删除节点、撤销确认、材料版本变化、未知 ID 和 checksum 漂移的失败路径，并通过精确 head
   审查/CI 后另行申请部署批准。本 L 文档不实现或宣布该 H 修复已完成。
4. **禁止** DROP 确认表、删除/改写 `schema_migrations` 或 checksum、修改已发布 0108、另造 down migration
   绕过未知历史。需要数据库恢复时遵循第 2 节的独立授权及空隔离库验证流程；不建议以
   `pg_restore` 覆盖真实学习数据来“撤销 0108”。无备份/演练/兼容候选证据时保持阻塞，交用户决定。

本节未执行升级、备份、恢复演练、应用回退或数据库恢复；没有相应执行证据，不得记为通过。
