# Opening DingTalk Operations

## 当前实现范围

- 权限策略位于 `apps/worker/src/connectors/dingtalk-policy.ts`。
- `canReadDingTalkResource(requiredScope, grantedScopes)` 只做内部能力名精确匹配。
- 权限字符串是 Opening 的内部能力名，不冒充钉钉官方 scope。
- 当前连接创建后 `allowedScopes` 为空，状态为 `needs_authorization`；请求的 scope 不会被视为已授权能力。
- 同步入口位于 `apps/worker/src/jobs/sync-dingtalk.ts`，只接受 `messages.read`、`events.read`、`files.read` 中的一个内部读能力；`robot.send` 不触发读取。
- 因为钉钉没有历史群聊读取 API，同步入口即使具备读能力也返回 `unsupported_history_read`，不执行历史拉取。
- 连接检查入口同文件的 `checkDingTalk` / `createCheckDingTalkHandler`：只做本地持久化判定，**不调用远程钉钉 API**。
  - 已撤销 → HTTP 409（connections service 先行拒绝）。
  - 无内部读能力 / `needs_authorization` → `{ ok: false, kind: "dingtalk", status: "needs_authorization", allowedScopes }`。
  - 具备内部读能力 → `{ ok: true, kind: "dingtalk", status: "ready" | "unsupported_history_read", allowedScopes }`；`ready` 仅表示内部读能力已具备（可供回调/事件摄入），**不表示历史拉取可用**，也不发明远程健康探针。
- HTTP：`POST /api/opening/connections/[id]/check` 对 `kind==="dingtalk"` 返回上述 JSON；对其它未实现 kind 仍 503 fail-closed。
- 事件回调服务位于 `apps/web/src/features/opening/connections/dingtalk-callback-service.ts`，HTTP 边界位于 `apps/web/src/app/api/opening/connections/dingtalk/events/route.ts`。
- 设置页提供最小钉钉连接面板；`/api/opening/connections/[id]/sync` 只返回钉钉授权/历史读取边界结果，不伪装历史同步。
- 内部能力名与官方文档表面的对照见 `apps/worker/src/connectors/dingtalk-policy.ts` 文件头注释；`robot.send` ≠ `messages.read`。

## 官方文档核对结果

以下 URL 在 2026-10-06 通过本机网络实际访问确认可达（HTTP 200）：

- `https://open.dingtalk.com/document/orgapp/events`
- `https://open.dingtalk.com/document/orgapp/event-subscriptions`
- `https://open.dingtalk.com/document/orgapp/event-encryption-and-decryption`
- `https://open.dingtalk.com/document/orgapp/verify-the-signature-of-callback-message`
- `https://open.dingtalk.com/document/orgapp/api-throttling`
- `https://open.dingtalk.com/document/orgapp/obtain-orgapp-token`
- `https://open.dingtalk.com/document/orgapp/robot-receive-message`
- `https://open.dingtalk.com/document/orgapp/dingtalk-event-overview`
- `https://api.dingtalk.com/v1.0/oauth2/accessToken`
- `https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2`

钉钉文档站多数页面是 React SPA，部分页面正文需要浏览器渲染。上表中 `dingtalk-event-overview`、`robot-receive-message`、`obtain-orgapp-token` 返回了完整 SSR HTML，可确认页面主题；其余正文细节不在本地浏览器验收范围内，因此实现只依赖已确认的协议结构与官方制品能力，不猜测未验证的 API 行为。

## SDK 与回调加解密制品

- 官方 TypeScript SDK：`@alicloud/dingtalk` v2.2.48。
  - 许可证：Apache-2.0。
  - 已在临时制品目录确认包含 `oauth2_1_0`、`robot_1_0`、`im_1_0`、`event_1_0`、`impaas_1_0` 等模块。
  - 认证方式为 HTTP header `x-acs-dingtalk-access-token`，主要 endpoint 为 `api.dingtalk.com`。
  - 当前代码切片不引入完整 SDK，避免为未授权能力增加运行时依赖。
- 回调加解密参考库：`dingtalk-encrypt` v2.1.2。
  - 许可证：Apache-2.0。
  - 暴露 `DingTalkEncryptor(token, encodingAesKey, key)`、`getDecryptMsg(msgSignature, timestamp, nonce, encryptMsg)`、`getEncryptedMap(...)`、`getSignature(...)`。
  - 协议结构为 SHA-1 验签与 AES-CBC/PKCS7；企业内部应用的 key 为 Corpid。
  - `ENCODING_AES_KEY` 为 43 个 Base62 字符；TOKEN 建议 3-8 字符。
- npm 上 `dingtalk-api-sdk`、`@dingtalk/cli`、`@dingtalk/openapi` 无法解析为可用制品。

## 可读资源边界

- 钉钉没有历史群聊消息读取 API。
- 机器人接收消息依赖回调推送，只能处理到达的新消息或事件。
- 不能由“机器人能发送消息”推断“机器人能读取历史消息”。
- 当前适配器不支持历史群聊读取，也不会实现伪装的历史同步。
- 已授权回调事件处理与手工上传是当前支持的两类输入；手工上传必须保持 `manual` 语义，不得写入 connection import receipt 或伪称自动同步。

## 回调安全边界

- 事件回调只接受已配置应用。
- 回调 URL 不携带 Opening 的 workspace、owner 或 connection 内部坐标。
- 管理员通过 `OPENING_DINGTALK_CALLBACK_CONNECTIONS` 配置 Corpid 到已授权连接的映射；未配置或映射缺失时 fail-closed。
- 必须先验签：`SHA1(token, timestamp, nonce, encrypt_msg)` 排序拼接。
- 必须解密：AES-CBC/PKCS7，明文包含 random、消息长度、消息与 Corpid 后缀。
- 解密后必须校验企业身份，只处理映射后的 workspace、connection 与 Corpid。
- 必须防重放：过期 timestamp 拒绝；重复事件在 source 创建前通过 import receipt 幂等跳过。
- 回调内容不能扩展授权，不能提升 `allowedScopes`，不能把回调正文中的 URL 当作受信下载目标。
- 附件下载主机必须由 `OPENING_DINGTALK_ALLOWED_DOWNLOAD_HOSTS` 显式配置；未配置时拒绝附件。
- 附件与事件内容复用不可变 source 边界，并写入 import receipt；connection version 变化或撤销时由既有 receipt 边界拒绝。

## 运行前提

- 需要企业管理员创建企业内部应用，并提供回调 TOKEN、`ENCODING_AES_KEY` 与企业身份信息。
- 需要企业管理员显式授予应用可用的资源与事件；Opening 不根据用户请求自动获得授权。
- 管理员需要配置回调连接映射与附件下载主机 allowlist。
- Access token、应用凭据、回调密钥不写入日志或模型输入。
- 真实组织授权、真实回调推送、真实附件下载、真实分页与限流行为需要单独验收。

## 当前未完成门禁

- 本地集成门禁 `tests/integration/opening-dingtalk.test.ts` 已实现并通过；真实组织授权与样本仍未验收。
- 真实组织授权与真实通知/文件样本验收 blocked，不阻塞本地安全边界测试。
- 在上述门禁通过前，C03 保持 `active`，CAP02 不能标记为实接完成。
