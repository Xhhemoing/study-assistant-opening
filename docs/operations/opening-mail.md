# Opening Mail Operations

## 当前实现范围

- IMAP 同步适配器位于 `apps/worker/src/connectors/imap-sync.ts`。
- 适配器使用 ImapFlow 只读打开邮箱：`mailboxOpen(folder, { readOnly: true })`。
- 使用 MailParser 解析邮件，禁用 HTML 转文本和外链解析。
- 每轮最多读取 100 封；单封邮件上限 25 MiB；单个附件上限 20 MiB；附件总和上限 25 MiB。
- 附件名会剥离路径；正文长度截断到 50,000 字符。
- 原始 `.eml` 会作为不可变 Opening source 保存，并写入 import receipt。
- UID cursor 只在 source 保存与 import receipt 提交成功后推进。
- UIDVALIDITY 变化会重置该 folder generation，不会复用旧 UID 语义。

## 明确边界

- 不执行 STORE flags。
- 不 EXPUNGE 或删除邮件。
- 不发送邮件。
- 不加载邮件中的远程资源。
- 不把手工 `.eml` 上传伪装成自动同步。

## 运行前提

- Worker 需要配置既有 S3、PostgreSQL 与连接凭据加密变量。
- 管理员必须通过 `OPENING_IMAP_ALLOWED_HOSTS` 明确授权学校 IMAP 主机。
- IMAP 凭据通过既有 AES-GCM credential vault 解密，密钥不进入日志或模型输入。
- 连接必须由用户显式创建并保存凭据；默认关闭，不会自动扫描邮箱。

## 未完成门禁

- 隔离标准 IMAP 服务的 integration 尚未运行；该门禁当前 blocked。
- 因此 CAP01 自动同步不能标记为完成。
- 学校实接仍需单独验收：核对 host/port/TLS/认证，读取授权测试邮件与附件，确认未改已读状态，再撤销连接。
