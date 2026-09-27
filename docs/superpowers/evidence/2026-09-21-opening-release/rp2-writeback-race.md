# RP2：删除与 Tutor 写回的真实并发验收

基线：`feat/opening-release` @ `8d616c0` 加既有未提交工作树。仅新增测试，没有生产行为变更、migration、提交、推送或部署；不提升任务账本状态。

## 变更

- `tests/integration/opening-privacy-writeback-race.test.ts`
- `tests/integration/opening-race-helpers.ts`

所有连接复用 `assertOpeningTestDatabase`，只允许显式开启的本机隔离库。writer/delete/gate/observer 使用独立、max=1 的连接；通过 PID、`pg_locks`、`pg_blocking_pids` 和 `pg_stat_activity.query` 确认真实重叠，不用固定 sleep 推断。

### 删除先取得工作区锁

1. gate 锁目标 memory。
2. 真实 `deleteMemory` 取得 workspace 锁，在 memory 的 `FOR UPDATE` 等 gate。
3. 真实 `completeTurn(expectedPrivacyEpoch=0)` 在 workspace 的 `FOR UPDATE` 等 delete。
4. 释放 gate 并等待 gate 事务完成；delete 提交 epoch=1；completeTurn 拒绝 `privacy epoch drift`。
5. 断言 memory deleted、epoch=1、job running、assistant pending/text 空/citations 空、candidate 与 help exposure 均未写入。合法 session/exposure 输入避免通过无效 fixture 造成假回滚。

### 写回先取得工作区锁

1. gate 锁 assistant turn。
2. 真实 `completeTurn` 取得 workspace 锁，在 `UPDATE opening_turns SET` 等 gate；明确断言正在等待的 SQL。
3. 真实 `deleteMemory` 在 workspace 的 `FOR UPDATE` 等 writer。
4. 释放 gate 后 completeTurn 成功、delete 随后成功，epoch=1；answer/job succeeded、candidate/exposure 均正常写入。

这证明写回先于删除的序列化顺序，不把该顺序误报为删除后写回。

## 协作与复核

使用 `xhh-grok/grok-4.7`：实现 `muc67jp0-4545c71f`；测试质量修正 `muc6ehsl-182574b9`；只读复核 `muc6r2oo-bd2eb4bf`。主会话读取初始 run JSON 的实际 provider/model 确认模型，并独立读文件/运行最终检查。

只读复核质疑第二种顺序的 relation lock 证据不足。主会话删除该弱断言，补充四处实际阻塞 SQL 断言。复核中“阻塞发生在 candidate FK 而非 UPDATE turn”的推断未被运行结果支持：新增 `UPDATE opening_turns SET` 匹配断言实际通过。保留证据边界，不将 subagent 判断直接当事实。

## failure → cause → fix → recheck

- 初始功能测试首次即绿：没有人为制造生产代码 RED。
- 初版测试对象 citations 缺少真实 Citation 字段；专属 TypeScript 检查还发现可能为空的 rows[0] 与 release 回调类型错误（subagent 报告 4 条本文件诊断）。根因是 `tsconfig.e2e.json` 不包含 integration，先前该命令成功不证明新增文件类型正确。
- 修正：typed completeTurn 输入、合法 citation、空值检查、显式回调类型。专属 TypeScript API 以新增两个文件为 roots；主会话最终独立检查 `DIAGNOSTICS 0`。
- 主会话复核另修清理路径：所有 race session 设 SQL 超时；gate done 可等待；提前创建 release latch，避免 opened 超时后早释放丢失；close 错误可见。poll 5s、lock/statement 8s、idle transaction 20s，每个 case 25s。
- 主会话模型证据查询曾因 one-liner 多余括号报 SyntaxError；修正表达式后输出 `Actual models: [ 'xhh-grok/grok-4.7' ]`。该辅助命令失败不是产品测试失败。

## 主会话最终验证

```bash
OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5433/aistudy_opening_test node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-privacy-writeback-race.test.ts tests/integration/opening-tutor-privacy-input.test.ts tests/integration/opening-privacy.test.ts tests/integration/opening-tutor-turn.test.ts
# Test Files 4 passed (4)
# Tests 26 passed (26)

node node_modules/eslint/bin/eslint.js tests/integration/opening-race-helpers.ts tests/integration/opening-privacy-writeback-race.test.ts
# exit 0
```

专属类型检查（包括 import 闭包）：

```javascript
const ts = require('typescript');
const cfg = ts.readConfigFile('tsconfig.base.json', ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, process.cwd());
const program = ts.createProgram([
  'tests/integration/opening-race-helpers.ts',
  'tests/integration/opening-privacy-writeback-race.test.ts',
], { ...parsed.options, noEmit: true });
const diagnostics = ts.getPreEmitDiagnostics(program);
console.log('DIAGNOSTICS', diagnostics.length);
process.exitCode = diagnostics.length ? 1 : 0;
// DIAGNOSTICS 0
```

## 边界及下一验收

- repository 抛错回滚后 job 仍 running 是预期；worker 捕获错误并调用 fail() 的并发全链路未覆盖，不能宣称完整 RP2 verified。
- 没有真实模型请求；未验证多 memory、跨 workspace 并发及幂等重删组合。
- 合入通过 PR/CI 对具体 SHA 运行上述隔离库检查；尚未运行本轮全量门禁或远端 CI。本切片无数据库回滚需求，回退新增测试文件即可，不涉及既有用户改动。
