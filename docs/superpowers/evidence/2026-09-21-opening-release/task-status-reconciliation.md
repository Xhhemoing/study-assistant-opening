# Opening 首版任务状态对账

日期：2026-09-21
基线：`HEAD=8d616c0622e070799a4d8a3e3e7a172cf2caa189`

## 对账结论

`docs/superpowers/plans/opening-release/tasks.json` 当前明确记录为 **15 verified / 22 planned**。本轮 Tutor 可靠性修复（幂等意图、材料版本快照、失败/未知终态、owner 校验、当前提交生命周期 polling、服务端 page/chunk 授权校验）已有 focused test/typecheck 证据，但尚未把任务账本中的 M01/M02/L01/L02/P02 等任务批量提升为 `verified`；本文件不改变 `tasks.json`。

计划结构验证：

```text
node scripts/validate-opening-plan.mjs
Plan structure: PASS (37 tasks, acyclic dependencies, plan/evidence files present)

node --test tests/tooling/opening-plan.test.mjs tests/tooling/opening-capability-plan.test.mjs
15 passed, 0 failed
```

## 本轮代码证据

- Tutor replay 与 pending-job recovery focused Vitest：8 files / 83 tests passed（前一切片）。
- 本轮 pending-job recovery + R15 request-body guard focused Vitest：7 files / 90 tests passed。
- 包级 typecheck：`@aistudy/contracts`、`@aistudy/database`、`@aistudy/worker`、`@aistudy/web` passed。
- changed-file ESLint passed；`git diff --check` passed。
- Opening plan validator 与 tooling tests：`15 passed, 0 failed`。
- 已增加 owner-scoped pending Tutor job discovery：刷新/重新进入同一会话时可发现 `queued/running` job 并恢复 polling；仍不宣称通用跨设备恢复已完成。
- 已为 `POST /api/opening/turns` 增加 128 KiB 实际字节限制，覆盖 Content-Length 缺失或不可信场景；其他 Opening JSON endpoint 尚未统一接入。
- R17 已增加最小 Web 边界：`POST /api/opening/turns` 接受/生成 UUID `x-request-id`，并在响应中回传；由于当前 Tutor job 表和 worker payload 尚无 correlation 字段，本切片不宣称 Web→Worker→AI 链路已串联。
- 已启动本地隔离 UTF-8 PostgreSQL（`127.0.0.1:5433/aistudy_opening_test`），并实际应用 `0001`–`0026` 全部迁移；迁移命令返回 `status: ok`。
- `tests/integration/opening-tutor-turn.test.ts`：**17 passed**；首次运行发现旧断言仍期待 `failed`，根因是实现已正确写入 `outcome_unknown`，已更新断言并重跑通过。
- `tests/integration/handler/opening-tutor.test.ts`：**6 passed**。
- `tests/integration/handler/opening-*.test.ts`（Tutor、Plans、Memory）：**4 files / 20 passed**。
- Opening handler 全项目运行仍混入其他历史 handler suite；失败集中在非 Opening 代码和旧测试环境假设，不能作为本次 Opening 切片失败证据。
- 仍不能据局部 integration PASS 宣称发布验收完成。

## 仍未闭合的发布证据

- 隔离 PostgreSQL 上的迁移、repository integration、handler integration 运行结果。
- 中断网络/关闭页面/重新进入的真实恢复演练。
- 换设备后的完整恢复演练与更广泛的跨设备会话验证。
- 真机、真实模型、性能和生产级 observability 证据。
- H3 同一 source version 重解析后的 chunk/citation 稳定性、CitationIdentity、Today 服务端时区和 staging fallback。
- R15 当前仅覆盖 `POST /api/opening/turns`，其他 Opening JSON endpoint 仍需逐端点评估。
- R17 的 Tutor job 持久化 correlation、worker/AI propagation 和统一日志/trace 仍未闭合。

因此，当前结论仍是：**条件通过，允许继续验证；不允许冻结 Opening 首版发布计划。**
