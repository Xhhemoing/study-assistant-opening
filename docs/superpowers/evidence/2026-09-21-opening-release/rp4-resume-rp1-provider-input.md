# RP4 引用恢复与 RP1 Provider 输入验收

基线：`feat/opening-release` / `8d616c0` + 既有未提交工作树。未提交、推送或部署；不提升 RP1–RP6 账本状态。

## 协作与模型证据

- RP4 实现 run：`muc2s1r5-74656870`（用户指定新模型前）。
- 用户指定 Grok 4.7 后，将 `.pi/agents/cursor-grok-worker.md` 配置切至 `xhh-grok/grok-4.7`。
- RP4 只读复核：`muc37kex-56dbffe0`；RP1 测试实现：`muc3c51g-0115b982`。主会话读取 run JSON 中 assistant 消息的 provider/model，二者均为 `xhh-grok/grok-4.7`。
- sparkle 委派 `run_d4b59034-ac89-4daf-8f2c-2d3ffd2cafb5`、`run_9f2e0c70-0453-4656-acaf-813ed7aae0e4` 均 FAILED，无有效审查报告；改用 subagent 通道后获得结果。不将失败委派作为审查通过证据。

## RP4：failure → cause → fix → recheck

1. 实现 subagent 报告初始回归为 5 failed / 36 passed：resume schema 拒绝 citations，bounded history/service 丢失引用。
2. 根因经主会话源码核查：`loadContinuityTurns` 只查询 role/text；`buildBoundedHistory` 再次仅映射 role/text；resume 使用 provider strict schema。
3. 最小修复：repository 读取 citations；continuity 返回完整引用数组；resume 使用独立 strict schema，citations optional 兼容旧 payload；view 用 `?? []`。provider history 契约不放宽。没有数据库 migration。
4. subagent 报告同命令 41 passed；主会话独立运行扩展集合 61 passed，隔离库组合 25 passed，三包类型检查 exit 0（详见下文）。初始 RED 属 subagent 运行证据，不冒称主会话复现。

涉及主要文件：
- `packages/contracts/src/opening/conversations.ts`、`conversation-resume.test.ts`
- `packages/database/src/repositories/opening-conversations.ts`（loadContinuityTurns）
- `apps/web/src/features/opening/tutor/conversation-continuity.ts` 及测试
- `apps/web/src/features/opening/assistant/message-model.ts` 及测试
- `apps/web/src/features/opening/client/api.test.ts`、`tutor/tutor-service.test.ts`
- `tests/integration/opening-conversation-resume.test.ts`

兼容边界：旧 payload 缺 citations 时 schema 保持缺省字段，view 归一化为空数组；新 server payload 带 citations。未验证旧版严格客户端消费新版 server 的滚动发布兼容性，应同版本发布 web/server；回滚需一起回退这组代码，无数据库回滚。

## RP1：真实删除后的请求体证据

新增 `tests/integration/opening-tutor-privacy-input.test.ts`（164 行），真实隔离 PostgreSQL、memory/privacy repositories、handler、provider adapter；仅 mock fetch，不调用真实模型。

- 控制路径先证明旧秘密问答确实发送；通过真实 `proposeMemory/deleteMemory` 排除材料后，不选材料的追问 HTTP body 不含旧问答，包含当前问题，fetch 一次且 job succeeded。
- 同时选择排除材料与允许材料时，实际 HTTP body 保留允许材料，排除秘密 chunk 与历史问答。
- 这是已有实现的验收补充：首次 2 passed，没有人为构造 RED，不修改生产代码。

## 主会话独立验证

```bash
node node_modules/vitest/vitest.mjs run --project unit packages/contracts/src/opening/conversation-resume.test.ts packages/contracts/src/opening/provider-history.test.ts packages/contracts/src/opening/contracts.test.ts apps/web/src/features/opening/tutor/conversation-continuity.test.ts apps/web/src/features/opening/tutor/tutor-service.test.ts apps/web/src/features/opening/assistant/message-model.test.ts apps/web/src/features/opening/client/api.test.ts
# Test Files 7 passed (7); Tests 61 passed (61)

OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5433/aistudy_opening_test node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-tutor-privacy-input.test.ts tests/integration/opening-conversation-resume.test.ts tests/integration/opening-tutor-history.test.ts tests/integration/opening-tutor-turn.test.ts
# Test Files 4 passed (4); Tests 25 passed (25)

npm run typecheck -w @aistudy/contracts && npm run typecheck -w @aistudy/database && npm run typecheck -w @aistudy/web
# exit 0
```

以上 RP4/RP1 涉及的 11 个 TypeScript 文件定向 ESLint exit 0；`git diff --check` exit 0（有既存 LF/CRLF 提示）。本机没有 docker 命令，但既存隔离 PostgreSQL 实际执行上述集成测试成功；不声称 compose 健康检查通过。

## 剩余验收与交付边界

- RP1 历史 SQL 与 worker 的隐私查询尚非单一 repository 查询规则来源；本切片仅补输入验收，不声称统一查询任务完成。
- RP2 仍缺删除/写回两个连接真实重叠的行锁测试，目前只有预设 epoch 漂移回滚测试。
- RP4 未运行 HTTP/browser 端到端引用点击及版本不一致演练；Grok 4.7 只读复核无阻塞发现，不替代运行验收。
- 未跑全量 lint/test/handler/browser/build 或远端 CI；合入须通过 PR/CI 对具体 SHA 验收，并手动验证刷新恢复引用与按版本查看。局部通过不等于首版发布通过。
