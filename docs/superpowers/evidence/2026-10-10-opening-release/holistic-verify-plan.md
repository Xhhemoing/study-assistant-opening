# Holistic verify — Plan: 整体验证与优化（READY_FOR_PM_REVIEW）

**Date:** 2026-10-10 ~07:36 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Tip:** `63a4737` · **RP7 quality tip:** `05217a5`  
**PM gate:** **READY_FOR_PM_REVIEW**  
**Constraints:** 无大产品改动；无 hermes redeploy；无 commit/push；无 `tasks.json` 状态翻转；优先闭环正确性，拒绝 `npm audit fix --force` / 新 Agent 框架

Companion: [`holistic-verify-understand.md`](./holistic-verify-understand.md)

---

## 中文摘要（给 Paula / PM）

功能与研究硬化已 verified；卡点在 **Q03 包装/恢复** 与其后的 **Q01→Q02→Q04**。本会话建议：Agent 子集复跑 + Paula 浏览器 observe-only 走查 + 小优化切片提案（含 RP7 索引相对 tip 标 stale）。**不要**为了“看起来更新”去重部署 hermes 或强推 Docker。

---

## Sequencing：本会话 vs 等待

| Now (this session / agent-owned) | Wait |
|---|---|
| Agent 按 §1 复跑单元/契约/handler/integration 子集并记录 PASS | Q03 Docker image build / compose up / packaging-green（需 Docker + Integrator） |
| Paula §2 浏览器 study-week observe-only（不 redeploy） | Q01 Create-list IMPLEMENT（需 PM 授权 Phase2/3 **且** Q03 允许 backup 门） |
| §3 小切片提案评审（含 RP7 index refresh 提案） | Q02 mobile/model samples；Q04 proactive gate |
| Integrator：审 Diff/证据后决定是否 commit 本两份 md | 生产切换 / 购买 / 公网部署 |

---

## 1) Agent-owned re-verify（commands / gates）

Concrete commands agents can re-run **without** Docker / Paula. Prefer `node node_modules/vitest/vitest.mjs`（与既有 Accept 一致）。Expected signal: `Test Files N passed` / exit 0；GHA：若 tip 移动，watch quality workflow，**不得**静默沿用 `05217a5` 绿灯。

### Integrator

```bash
# Lint + typecheck (heavy; optional full gate)
npm run lint
npm run typecheck

# CI verify script (local, no deploy claim)
npm run verify:ci

# Contract smoke
node node_modules/vitest/vitest.mjs run --project contract
```

**PASS:** lint/typecheck exit 0；contract project green。  
**GHA watch:** tip ≠ `05217a5` 时，打开 Actions quality run；结果写入证据时标 `pass`/`fail`/`pending`，旧 `05217a5` 行改 `stale`。

### Data（DL11 / TZ01 / day-boundary）

```bash
node node_modules/vitest/vitest.mjs run --project unit \
  packages/domain/src/opening/day-planner.test.ts \
  packages/domain/src/opening/local-day-bounds.test.ts \
  packages/domain/src/opening/daily-draft.test.ts \
  packages/domain/src/opening/retest-activity.test.ts \
  packages/domain/src/opening/extract-study-actions.test.ts \
  packages/database/src/repositories/opening-reminders.test.ts \
  apps/web/src/features/opening/planning/plan-service.test.ts \
  apps/web/src/features/opening/learning/attempt-service.retest-earliest.test.ts \
  apps/web/src/features/opening/learning/retest-attempt.test.ts \
  apps/worker/src/jobs/remind.test.ts
```

**PASS signal (historical Accept ballpark):** day-planner / local-day / plan-service / retest-earliest 子集全绿（先前 DL11 closeout ~55；TZ01 Data ~95 across 6 files — re-run counts may differ slightly as tip moves）。

Optional tsc:

```bash
npx tsc -p packages/domain --noEmit
npx tsc -p packages/database --noEmit
npx tsc -p apps/worker --noEmit
```

### AI（BC1 / budget local-day / readiness）

```bash
node node_modules/vitest/vitest.mjs run --project unit \
  apps/worker/src/runtime/budget-contract-discovery.test.ts \
  apps/worker/src/runtime/budgeted-call.test.ts \
  apps/worker/src/jobs/tutor-turn.test.ts \
  packages/ai/src/opening/errors.test.ts \
  packages/ai/src/opening/usage.test.ts \
  packages/ai/src/opening/effective-cap.test.ts \
  packages/ai/src/opening/catalog-merge.test.ts \
  packages/ai/src/opening/budget-local-day.test.ts
```

**PASS signal:** BC1 Accept 曾报 **7 files / 93 PASS**（不含 budget-local-day）；加上 TZ01 AI 文件后全绿 + `npx tsc -p packages/ai --noEmit`。

### Experience（UI/submit surfaces — unit only）

```bash
node node_modules/vitest/vitest.mjs run --project unit \
  apps/web/src/features/opening/learning/attempt-service.retest-earliest.test.ts \
  apps/web/src/features/opening/learning/attempt-service.retest-close.test.ts \
  apps/web/src/features/opening/learning/retest-attempt.test.ts \
  apps/web/src/features/auth/service.test.ts \
  apps/web/src/features/opening/planning/plan-service.test.ts
```

**PASS:** 上述 unit 绿。浏览器 E2E 见 §2（Paula）或 Integrator 既有 `npm run test:browser`（需环境；不强制本会话）。

### Pipeline（ingestion / worker jobs — light）

```bash
# Handler subset (needs isolated DB via project globalSetup — DL10 path)
npm run test:handler

# Integration subset (same; no Docker packaging claim)
npm run test:integration
```

若环境缺 DB：记录 **blocked: isolated services**，不要伪造绿。优先 handler/integration 中与 opening backup/privacy / connections 相关的已有文件；**不**把 packaging image build 算进本条。

### Cross-cutting expected PASS table

| Gate | Command shape | PASS looks like |
|---|---|---|
| unit subsets | `vitest --project unit <paths>` | all listed files passed |
| contract | `vitest --project contract` | exit 0 |
| handler | `npm run test:handler` | exit 0 on isolated DB |
| integration | `npm run test:integration` | exit 0 on isolated DB |
| typecheck | `npm run typecheck` or scoped `tsc -p` | exit 0 |
| GHA quality | Actions watch on **current tip** | green run URL；else stale/pending/fail |

---

## 2) Needs Paula browser / study-week walkthrough

**Mode:** observe-only。**No redeploy** of hermes / opening stacks unless PM explicitly authorizes. Agents may prep checklist; Paula drives real UI.

### Checklist（建议顺序）

1. **Today plan / 今日计划**
   - 打开 opening 今日视图；确认草案/已确认计划与本地日一致（上海日界）。
   - 观察：补测是否被排到 `recommendedAt` / earliest 之前（DL11）；若有“未排”原因是否可解释。
2. **Retest earliest / 补测最早可测**
   - 选一条 `recommendedAt` 在下午的补测；尝试过早提交。
   - 期望：服务端拒早（`RETEST_SUBMIT_TOO_EARLY` 或等价业务错误）；UI 可禁用但不作为唯一保障。
3. **Budget settings / AI 预算**
   - 设置页：日额度、今日已用/剩余、`budget_disabled` 与就绪清单一致（BC1/DL7/TZ01）。
   - 不要求本轮打满付费调用；若做 live 调用须显式预算与知情。
4. **Tutor / 辅导一轮**
   - 已登录工作区发一条辅导；观察引用/失败可恢复/无双扣迹象。
   - **不**为修 GLM/vision 而 redeploy hermes；若再现 malformed JSON，记现象 + tip，另开授权切片。
5. **Privacy / 隐私**
   - 记忆/来源删除或隐私相关入口：确认无匿名可读；双主体隔离若可观察则记。
   - Backup/restore UI 若不可用：记 **blocked on Q03**，不宣称恢复演练通过。

### Evidence hygiene

- 记录：时间（CST）、tip SHA、环境（local / hermes URL **as-is**）、步骤、截图路径（若有）、pass/fail/blocked。
- 不把“演示成功”写成 Q01/Q02 verified。

---

## 3) Optimization slices（risk / benefit）

原则：**闭环正确性 > 新框架**。建议 3–7 个小切片；PM 勾选后再授权 IMPLEMENT。

| # | Slice | Benefit | Risk | Owner hint |
|---|---|---|---|---|
| A | **RP7 index refresh（提案）** — 将 `tipSha` 叙事改为：quality 仍记 `05217a5` pass；对 HEAD `63a4737` 将 gha-quality/rp5 标 **stale**（或重跑后 pass）；为 TZ01/DL11 相关自动化行标注 stale vs tip / pass-after-rerun。**不重写**整板业务，除非 trivial docs note | 证据诚实，避免静默继承旧绿灯 | 低；纯文档/JSON | INTEGRATOR（Data 可协助核对行） |
| B | Agent §1 子集复跑落证据一页（holistic-reverify-run.md） | 快速确认 tip 未回归 | 低；耗时/DB 依赖 | INTEGRATOR 协调；Data/AI/Experience 分片 |
| C | TZ01 nature 矩阵补 1–2 个高价值 case（重叠 free / 跨夜容量）— **仅当** PM 要收紧 residual | 日界锁更强 | 中；可能暴露排程边角 | DATA |
| D | BC1 ephemeral web `operationId`（曾延期）— 仅授权时做最小接线 | 设置页短路径与账本重试一致 | 中；触 `apps/web` | AI+EXPERIENCE |
| E | Q01-prep **Phase2** skipped/WIP reds — **仅 PM 授权**；默认 CI 不跑红 | 为 Q01 铺红灯骨架 | 中；误入 CI 会红 | QA |
| F | Q03 packaging wait — Docker image/compose/restore drill 清单保持等待；本地继续 CLI/fixture 不宣称 packaging-green | 诚实阻塞可见 | 低（等待） | INTEGRATOR+QA |
| G | Known residual 文档钉扎（DL11 UI 非门、BC1 defer、TZ01 partial、RP7 stale-vs-tip）→ 一页 residual register | PM 可见“verified ≠ zero gap” | 低 | INTEGRATOR |

### Explicitly rejected

- `npm audit fix --force` / 依赖大爆炸“修漏洞换绿灯”
- 新 Agent 编排框架 / 再加聊天页当主线
- 无授权 hermes redeploy、生产切换、静默把 Q03/Q01 标 verified
- 为刷新索引而重写产品代码

### RP7 index refresh — propose only（trivial docs note OK）

Proposed note (Integrator may apply as trivial docs, or defer):

```text
RP7 tipSha remains 05217a5 (quality PASS 37958795828).
Branch tip 63a4737 is descendant; treat gha-quality/rp5-ci-gate as stale-vs-tip
until re-run on 63a4737+. DL11/TZ01 landed after index tip — domain evidence
paths exist under 2026-10-10-opening-release/ but are not tip-bound quality rows.
Do not rewrite board markup unless refreshing JSON+MD together.
```

**This Plan does not rewrite** `release-evidence-index.json` unless PM/Integrator treats the above as trivial docs note in a follow-up.

---

## 4) Still blocked

| Item | Why blocked | Unblock needs |
|---|---|---|
| **Q03** Docker/compose/CI packaging | image build / compose.opening 绿灯 / 完整 restore drill 未宣称；索引 Q03 checks **stale** | Docker + Integrator packaging gates；证据重跑绑 tip |
| **Q01 verified** | depends **Q03**；Create-list 4/5 缺失；backup 门绑 completed Q03 | Q03 完成路径 + PM 授权 IMPLEMENT + 观察证据 |
| **Q02** | depends Q01 | Q01 verified 路径 |
| **Q04** | depends Q02（+U04 already verified） | Q02 |
| Hermes live deep-fix | no redeploy this pass；真实 provider/视觉链路受部署与预算约束 | PM 授权 redeploy + 预算 |
| Full TZ01 nature matrix | intentionally partial | optional slice C |
| BC1 web operationId | accepted deferral | optional slice D |
| Packaging-green / prod cutover | never from local scaffold alone | explicit auth |

---

## Acceptance（this Plan doc）

- [x] Four PM sections present (§1–§4)
- [x] Sequencing: this session vs wait
- [x] READY_FOR_PM_REVIEW；无 ledger flip；无 hermes redeploy；无 commit/push
- [x] Reject npm audit force / new agent frameworks
- [x] RP7 TZ01/DL11 index refresh **proposed**, not silently rewritten
- [ ] PM / stronger review accepts → authorize selected slices / Paula walkthrough / Integrator commit of these md files

## READY_FOR_PM_REVIEW

Holistic Understand+Plan 已就绪，供 Paula/PM 评审。本 agent **不** IMPLEMENT、**不**改 tasks.json、**不** redeploy hermes、**不** commit/push。

---

## Opt A/B/G implement (follow-up)

**2026-10-10 ~07:44 CST:** Paula-authorized slices **A+B+G** docs landed — see [`holistic-opt-abg-implement.md`](./holistic-opt-abg-implement.md). Pending Data Accept; no commit/push this pass.
