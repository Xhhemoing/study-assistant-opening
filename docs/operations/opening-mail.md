# Opening Mail Operations

## 现状（2026-10-09，agent-owned）

- 隔离 IMAP integration 门禁已通过（`tests/integration/opening-imap-sync.test.ts` **5/5**）；C02 账本为 verified，见 `docs/superpowers/evidence/2026-10-09-opening-release/c02-imap-sync-verified.md`。
- 学校真实 IMAP / CAP01 live（授权主机、实接邮箱、读一封+附件、确认未改已读、撤销）**尚未运行**，不得标完成。
- 浏览器实接验收未跑。

## 当前实现范围

- IMAP 同步适配器位于 `apps/worker/src/connectors/imap-sync.ts`。
- Worker 边界：`apps/worker/src/jobs/sync-mail.ts` 提供 `createSyncMailHandler`（同步）与 `createCheckMailHandler`（只读连通性检查）。
- HTTP 边界：`POST /api/opening/connections/[id]/sync` 与 `POST /api/opening/connections/[id]/check` 在凭据与主机 allowlist 就绪时，将 `kind=imap` 接到上述 handler；不再对 IMAP 一律 503 stub。
- 适配器使用 ImapFlow 只读打开邮箱：`mailboxOpen(folder, { readOnly: true })`。
- 使用 MailParser 解析邮件，禁用 HTML 转文本和外链解析。
- 每轮最多读取 100 封；单封邮件上限 25 MiB；单个附件上限 20 MiB；附件总和上限 25 MiB。
- 附件名会剥离路径；正文长度截断到 50,000 字符。
- 原始 `.eml` 会作为不可变 Opening source 保存，并写入 import receipt。
- UID cursor 只在 source 保存与 import receipt 提交成功后推进。
- UIDVALIDITY 变化会重置该 folder generation，不会复用旧 UID 语义。

## HTTP check / sync 行为

- **check（IMAP）**：校验 allowlist → 解密 vault 凭据 → ImapFlow 只读连接（`rejectUnauthorized: true`）→ 打开已选文件夹或 list → logout。成功返回 `{ ok: true, kind: "imap" }`。不 STORE flags、不 EXPUNGE、不发信。
- **sync（IMAP）**：调用既有 `createSyncMailHandler`；游标推进仍只在 `syncMailbox` 成功提交后发生。
- **revoked**：check/sync 均返回 409。
- **未授权主机**：创建时与 check/sync 适配器路径均映射为 VALIDATION（400）。
- **DingTalk check**：本地 fail-closed JSON（无读能力 → `needs_authorization`；有读能力 → `ready` / `unsupported_history_read`；已撤销 → 409）；**不**调用远程钉钉 API，也**不**再对钉钉 check 一律 503。细节见 `opening-dingtalk.md` 与 `c03-dingtalk-verified.md`。

## 明确边界

- 不执行 STORE flags。
- 不 EXPUNGE 或删除邮件。
- 不发送邮件。
- 不加载邮件中的远程资源。
- 不把手工 `.eml` 上传伪装成自动同步。
- 不接受任意远程 URL；主机必须在 `OPENING_IMAP_ALLOWED_HOSTS` 中。

## 运行前提

- Worker 需要配置既有 S3、PostgreSQL 与连接凭据加密变量。
- 管理员必须通过 `OPENING_IMAP_ALLOWED_HOSTS` 明确授权学校 IMAP 主机。
- IMAP 凭据通过既有 AES-GCM credential vault 解密，密钥不进入日志或模型输入。
- 连接必须由用户显式创建并保存凭据；默认关闭，不会自动扫描邮箱。

## 未完成门禁

- 隔离标准 IMAP integration 门禁**已通过**（`opening-imap-sync` **5/5**，C02 verified）；见 `c02-imap-sync-verified.md`。
- **学校真实 IMAP / CAP01 live 仍未运行**，不能把自动同步标为实接完成。
- 学校实接仍需单独验收：核对 host/port/TLS/认证，读取授权测试邮件与附件，确认未改已读状态，再撤销连接。
- 浏览器实接未跑。
