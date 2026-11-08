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
pg_restore --exit-on-error --clean --if-exists \
  --dbname=aistudy_restore_rehearsal \
  /secure/backups/aistudy-pre-identity.dump
```

4. 记录备份位置、SHA-256、操作者、时间、目标数据库 host/database、数据库 fingerprint 以及恢复演练结果。`identity_owner_mappings.database_fingerprint` 和 legacy `0003` attestation 都必须等于 canonical runner 为目标数据库和当前 schema 生成的值。不要在仓库中保存凭据、attestation 或备份文件。

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

## 7. 0108 确认协议的兼容恢复边界（执行仍需另批）

0108 是增量建表，但这**不意味着任意旧应用可以安全回退**。旧 runner 不认识
`0108_opening_knowledge_confirmations.sql`，仍必须报 `MIGRATION_UNKNOWN_HISTORY`；旧 writer
不会完整撤回确认，不能恢复写入。禁止 `allowUnknown`、down DDL、删表、删除或伪造
ledger/checksum/attestation，也不通过修改 `OLD_TARGET` 或 transition 绕过受管流程。

本次新增的是 **reader/writer 兼容锚点和只读资格报告**，不是历史制品的通用豁免：

- canonical owner 仍是 `packages/database/src/migrate.ts`，不存在独立 migration-registry。
- 仅认识真实、连续的 0001..0108：逐行要求原始 `verified` checksum；107 尚未升级、
  unknown 0109、legacy-unverified、checksum 漂移、缺失确认表/约束/索引都拒绝。
  preflight 不 bootstrap registry、不补写 checksum、不自动执行 0108。
- 候选须带完整相同 migration inventory；其 runner、knowledge repository、受管 DB helper
  的实际内容必须等于执行 preflight 的可信锚点，且匹配独立审查发布清单里的内容摘要。
  这不是任意输入字符串的能力声明，也不接受候选自行上报“兼容”。此 profile 仅针对
  未修改的 source release；编译包、其它依赖和整个制品的供应链真实性仍由精确 SHA 的
  发布清单、审查和 CI 保证，报告不替代这些门禁。当前没有自动批准的历史恢复目标。
- 新 writer 在图的节点/边内容或完整 source version 集合变化后撤回确认；相同内容的
  worker status 重分类才可保留。手动撤销、删除节点和 source maintenance 都删除 receipt，
  即使节点已是 needs_check 也删除；变回旧图/旧源不能复活旧确认。
  confirm/replace/maintenance 按 workspace → graph 顺序串行；maintenance 即使 status 未变也
  推进 graph version 的 CAS 栅栏，使维护前提交的确认冲突，失败事务不得留下半次确认。

在已获得单独的操作授权、独立核准兼容锚点和候选精确 SHA 后，可由受管操作人员运行：

```bash
node <trusted-anchor>/infra/deploy/hermes-db.mjs confirmation-recovery-preflight \
  <private-config-file> <candidate-source-release> <reviewed-content-digest>
```

内容摘要的算法是 SHA-256，按以下顺序串联每个相对路径、NUL、原始文件字节、NUL：
`packages/database/src/migrate.ts`、`packages/database/src/repositories/opening-knowledge.ts`、
`infra/deploy/hermes-db.mjs`。摘要须从独立审查过的版本生成和保存，不从不可信候选取值。
JSON 报告只含 profile、ledgerThrough、migrationChecksum、artifactContentDigest、writerProtocol、
readOnly 和 automaticRecovery，不含数据库地址、账号或学习资料。helper 用可信锚点的
runner 执行，只读 repeatable-read 事务核对数据库，不执行候选代码。

**报告是时点观测，不是恢复许可证或数据库 attestation。** 写入应保持停止；任何目标、
ledger、schema 或制品变化后报告失效，必须重新核对。现有 deploy/release 脚本没有接入
这一动作；它不会迁移、切指针、改 transition、恢复服务或恢复 writer。若受管流程只能回到
能力不足的旧目标，结论就是不可恢复，保持停写并提交 forward-fix/新兼容 reader-writer
锚点方案，不能偷偷更换恢复目标。迁移执行、含迁移部署、真正恢复演练及新发布顺序均另批。

## 8. 失败恢复

- preflight、attestation 或 `0004` 失败：保持服务停止，保存错误与数据库状态；修正受控映射或 attestation 后重试，或恢复到已验证备份。
- 已记录旧版 `0003` 且数据已被删除：`0004_identity_repair.sql` 无法恢复数据。必须从已验证备份恢复到隔离环境，确认完整性后执行正式恢复；无备份时阻断发布并进入人工数据重建流程。
- trigger 验证失败：立即停止写入，从备份恢复或在受控事务中修复 trigger 后重新验证；不要在保护关闭时开放应用流量。
