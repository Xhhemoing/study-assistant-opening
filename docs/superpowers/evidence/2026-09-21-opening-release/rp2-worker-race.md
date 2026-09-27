# RP2：worker handler 并发失败终态验收

基线：`feat/opening-release` @ `8d616c0` 加既有未提交工作树。仅新增测试与本证据，不改生产行为、migration 或账本状态。未提交、推送、部署。

## 路径与协作

- `tests/integration/opening-worker-privacy-race.test.ts`（133 行）
- `tests/integration/opening-worker-race-fixture.ts`（67 行）
- 复用既有 `opening-race-helpers.ts`，本轮不修改该 helper。

实现 run `muc7yc9c-72628a79`；只读复核 run `muc8963o-4ef93cf4`。主会话解析两份 run JSON 的 assistant provider/model，均为 `xhh-grok/grok-4.7`。复核未发现阻塞性假通过；最终验收以主会话重跑为准。

## 确定性交错与断言

真实隔离 PostgreSQL、conversation/memory/privacy/budget/tutor repositories、`createTutorTurnHandler` 和 `createOpeningProvider`；只替换 fetch，禁止真实模型请求。

1. gate 锁 memory；worker claim queued job、读取 epoch=0、加载材料并 reserve，进入 fetch barrier。
2. 真实 deleteMemory 取得 workspace 锁，在 memory 的 `FOR UPDATE` 等 gate。观察 epoch 仍为 0。
3. 返回合法模拟 Provider 响应（引用实际 chunk、candidate、usage=20/8）；worker settle，前置 epoch 检查读到旧已提交版本 0。
4. `pg_blocking_pids` 和 `pg_stat_activity.query` 确认 writer 在 workspace `FOR UPDATE` 等 delete：证明 handler 走到了事务写回，而不是被前置检查提前拒绝。
5. 释放 gate并等待其事务完成，delete提交 epoch=1，completeTurn拒绝 `privacy epoch drift`；worker catch执行真实 fail。
6. 断言 job/assistant 均 failed、错误含 drift、无秘密模型答案、citations为空、candidate/exposure为0、memory deleted、exclusion精确匹配source。
7. 预算 state=completed 且 amount_cents=28（测试费率每百万token 1,000,000分，usage 20+8），不因回答被丢弃而退回已产生费用。
8. 同job再次直接调用handler返回 skipped=true，fetch仍只有一次。

writer/delete/gate/observer 均复用 max=1、带SQL超时的 openRaceSession；fetch开始等待使用5秒 vi.waitFor，finally释放fetch与gate并等待在途事务、关闭连接。

## failure → cause → fix → recheck

### subagent 实现阶段（报告证据）

首次 `completeTurn not blocked yet`。subagent报告原因是handler原用多连接fixture pool，观测PID与事务PID不一致；改为max=1后同命令通过1 test。主会话未重复制造该初始失败。

### 主会话复核与修正

- 初次组合复跑 5 files / 27 passed，但发现重复 `openPinned` 缺少SQL超时，且直接等待fetch entered无独立期限。删除重复helper，统一复用 openRaceSession，并以有界 vi.waitFor 等待请求开始。
- 增强预算金额断言时主会话实际复现 `PostgresError: column "actual_cents" does not exist`，1 test failed。根因：错误假设列名；真实 `opening-budget.ts:settle` 写回 `amount_cents`。
- 仅修测试查询和类型字段为 amount_cents；同一focused命令重跑 1 test passed。最终组合重跑 5 files / 27 passed，专属类型检查 DIAGNOSTICS 0，定向ESLint exit 0。

## 主会话最终命令

```bash
OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5433/aistudy_opening_test node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-worker-privacy-race.test.ts tests/integration/opening-privacy-writeback-race.test.ts tests/integration/opening-tutor-privacy-input.test.ts tests/integration/opening-privacy.test.ts tests/integration/opening-tutor-turn.test.ts
# Test Files 5 passed (5)
# Tests 27 passed (27)

node node_modules/eslint/bin/eslint.js tests/integration/opening-worker-privacy-race.test.ts tests/integration/opening-worker-race-fixture.ts
# exit 0
```

类型检查使用 TypeScript API：读取 `tsconfig.base.json`，`parseJsonConfigFileContent` 获取options，`createProgram` roots指定上述两个新增TS文件，`noEmit:true`，`getPreEmitDiagnostics`检查import闭包；输出 **DIAGNOSTICS 0**。没有用不包含integration的e2e tsconfig冒充本文件类型检查。

## 交付边界

- 补齐上一切片所缺的handler catch/fail、预算保留、直接重复投递路径；不是BullMQ真实进程、runJob或队列重试策略验收。
- 覆盖 explain / 单source / 单chunk 的这一交错，不代表所有并发序列、模式和设备均已验收。
- 不提升RP2为verified：仍需合入树完整门禁及PR/CI绑定SHA证据；本轮未执行远端CI、浏览器或完整构建。
- 无migration/破坏性变更；回退只涉及新增测试及证据，不触碰既有用户改动。
