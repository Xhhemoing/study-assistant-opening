# Personal-use Plan Verification — 2026-09-25

**范围：** 本次只编写多agent实施计划；未实现产品功能、启用付费模型、迁移数据库、提交/推送或部署。计划文件初始均为未跟踪文件；原有dirty源码和43任务状态保持原样，Graphify生成物有独立更新。

**产物：** [主计划](../2026-09-25-personal-use-multi-agent.md)、[执行账本](execution.json)、00–04五份子计划和本记录。12个执行节点全部planned，snapshotCommit/contractRevision为null，不能据此宣称任何功能已验证。

## 实际检查

| 检查 | 结果与边界 |
| --- | --- |
| 原计划validator | PASS：43项、依赖无环、计划/证据引用有效；不是产品正确性证明 |
| 两组plan tooling测试 | PASS：15/15，0失败、0跳过 |
| 新计划结构与内容检查 | PASS：12节点依赖无环、原任务映射有效；入口/操作/出口门禁、契约和租约引用有效；7份Markdown均≤200行且链接/围栏/空白检查通过 |
| scoped git diff --check | exit 0；Git不会完整检查未跟踪文件，以上内容检查补充行尾空白/链接/围栏检查 |
| graphify update . | exit 0；13,842节点、30,227边、686社区；只做AST更新，无付费语义调用 |

Graphify仍报告27个SQL文件因缺少tree_sitter_sql未入图、8个源文件零节点，以及社区标签与当前社区集合不完全一致。本轮未安装依赖或调用LLM重新标注；SQL/迁移判断使用实际文件，不以图谱代替源码证据。图谱生成物不纳入计划交付提交。

未运行产品unit/handler/integration/browser、lint/typecheck/build、live评估、恢复演练、真机和远端CI。后续节点仍须独立取得这些证据。

## 审查发现 → 原因 → 修订 → 复核

| 发现与原因 | 修订与复核依据 |
| --- | --- |
| 恢复迁移直接跳过预约号会破坏连续迁移序列 | PU00先扫描实际状态，恢复优先时只顺移未落盘预约；原计划validator及15项测试通过；本轮未改真实SQL或旧预约 |
| PowerShell后续命令会掩盖前条原生命令失败 | 各验收块逐条检查LASTEXITCODE，独立审查复核；本轮实际命令也即时检查 |
| live费用输入未明确真实账本关联 | PU04新增只读operator适配器计划，按tutor job/request ID关联reservation；记录结算及unknown占用，缺账本阻塞 |
| 延迟验证缺初次/延迟答题记录及时间 | 增加PilotAttemptRecord和真实记录引用/时间/来源约束，PU01统一schema；缺测保留缺测 |
| externalGates混用启动条件和本任务产出，会循环等待 | 拆entryGates/operationGates/exitEvidence；PU07入口显式检查费用许可/定价/持久账本；独立复核确认闭合 |
| writePaths被称来自manifest但没有对应字段 | PU00从子计划展开精确文件，统一生成leases.json并冻结revision；派发提示词同步，独立复核确认闭合 |

接续agent完成跨lane只读审查及最终修订复核，报告无残余执行阻塞。review仅为交接状态，账本保持active；PU07的observe/stop不等于verified。审查记录不冒充业务失败用例或红绿测试证据。

本轮记录生成脚本曾因JavaScript模板字符串内的反引号解析失败；确认目标文件尚不存在后，改用十六进制字符匹配围栏，再运行同一生成/检查步骤。该失败发生于执行前，不涉及产品写入。

## 可复现命令

在仓库根目录用pwsh执行；下列脚本检查计划结构，不能证明门禁已执行。Graphify已更新一次，本段不重复运行。

```powershell
$ErrorActionPreference = 'Stop'
node scripts/validate-opening-plan.mjs
if ($LASTEXITCODE -ne 0) { throw 'Original plan check failed' }
node --test tests/tooling/opening-plan.test.mjs tests/tooling/opening-capability-plan.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'Plan tooling tests failed' }
@'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateTaskGraph } from './scripts/validate-opening-plan.mjs';
const root = process.cwd();
const dir = path.join(root, 'docs/superpowers/plans/personal-use');
const read = p => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const manifest = JSON.parse(read(path.join(dir, 'execution.json')));
const canonical = JSON.parse(read(path.resolve(dir, manifest.canonicalScope)));
const originalIds = new Set(canonical.tasks.map(t => t.id));
const ids = new Set(manifest.tasks.map(t => t.id));
assert.equal(manifest.tasks.length, 12);
assert.deepEqual(validateTaskGraph(manifest.tasks), []);
assert.equal(manifest.snapshotCommit, null);
assert.equal(manifest.contractRevision, null);
assert.equal(manifest.baselineStatus, 'working_tree_not_frozen');
assert.equal(manifest.maxAgents, 4);
assert.equal(manifest.maxImplementationAgents, 2);
for (const t of manifest.tasks) {
  assert.equal(t.status, 'planned', t.id);
  assert.deepEqual(t.evidence, [], t.id);
  assert.ok(t.originalTasks.length && t.originalTasks.every(id => originalIds.has(id)), t.id);
  const target = path.resolve(dir, t.plan);
  assert.ok(target.startsWith(dir + path.sep) && fs.existsSync(target), t.id);
}
assert.ok(!('externalGates' in manifest));
for (const field of ['entryGates', 'exitEvidence']) {
  for (const [id, rules] of Object.entries(manifest[field])) {
    assert.ok(ids.has(id) && Array.isArray(rules) && rules.length, field + ':' + id);
    assert.ok(rules.every(rule => typeof rule === 'string' && rule.trim()), id);
  }
}
for (const [id, operations] of Object.entries(manifest.operationGates)) {
  assert.ok(ids.has(id), id);
  for (const rules of Object.values(operations)) assert.ok(Array.isArray(rules) && rules.length);
}
assert.ok(manifest.entryGates.PU07.some(s => s.includes('paid approval')));
assert.ok(manifest.entryGates.PU07.some(s => s.includes('pricing')));
assert.ok(manifest.entryGates.PU07.some(s => s.includes('budget ledger')));
const files = [
  path.join(dir, '../2026-09-25-personal-use-multi-agent.md'),
  ...fs.readdirSync(dir).filter(name => name.endsWith('.md')).map(name => path.join(dir, name)),
];
for (const file of files) {
  const text = read(file);
  const lines = text.replace(/\r\n/g, '\n').trimEnd().split('\n');
  assert.ok(lines.length <= 200, file + ': line limit');
  assert.ok(!lines.some(line => /[ \t]+$/.test(line)), file + ': trailing whitespace');
  assert.equal((text.match(/^\x60{3}/gm) ?? []).length % 2, 0, file + ': fences');
  for (const marker of ['TO' + 'DO', 'TB' + 'D', 'FIX' + 'ME']) {
    assert.ok(!new RegExp('\\b' + marker + '\\b').test(text), file + ': placeholder');
  }
  for (const match of text.matchAll(/\[[^\]\n]+\]\(([^)\n]+)\)/g)) {
    const link = match[1];
    if (/^(https?:|#)/.test(link)) continue;
    assert.ok(fs.existsSync(path.resolve(path.dirname(file), link.split('#')[0])), file + ': ' + link);
  }
}
const protocol = read(path.join(dir, '00-execution-protocol.md'));
assert.ok(protocol.includes('.local/personal-use/leases.json'));
assert.ok(protocol.includes('exitEvidence'));
const contracts = read(path.join(dir, '04-contracts.md'));
assert.ok(contracts.includes('PilotAttemptRecord') && contracts.includes('OperatorBudgetSnapshot'));
console.log('PASS: 12 acyclic planned tasks; valid original mappings, gates, leases and contracts.');
console.log('PASS: ' + files.length + ' Markdown files within 200 lines; links, fences and whitespace valid.');
'@ | node --input-type=module
if ($LASTEXITCODE -ne 0) { throw 'Personal-use plan integrity failed' }
git diff --check -- docs/superpowers/plans/2026-09-25-personal-use-multi-agent.md docs/superpowers/plans/personal-use
if ($LASTEXITCODE -ne 0) { throw 'Scoped diff check failed' }
```

**接手点：** PU00。先核对实际工作区，冻结可复现基线与写租约，再执行PU01契约；不从旧HEAD分派缺少当前实现的代码工作树。原CAP01–06范围和完整R2c仍由原计划验收。本轮没有已启动的后台执行或自动监督。
