# @aistudy/database

数据访问层:PostgreSQL schema、migration 与 repositories。所有 SQL 与迁移的单一所有者。

- 改 schema 必须新增 migration,不修改已发布 migration 文件。
- 验证:`npm run typecheck -w @aistudy/database`;migration 测试在 `tests/integration/migration-*`。
- repository 变更需匹配 `tests/integration/*repository*` 测试。
