# Holistic verify — Understand: 整体验证与优化（当前态快照）

**Date:** 2026-10-10 ~07:36 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Tip (HEAD):** `63a4737` — `feat(opening): TZ01 reminder/API local-day closeout; mark verified`  
**RP7 quality tip (index-bound):** `05217a5` — GHA quality run `37958795828` (pass)  
**Working tree:** clean of product dirt; untracked only `docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-91b1c73-typecheck-fail.md` (historical note)  
**Gate this pass:** Understand docs only — **no** `tasks.json` flips, **no** product IMPLEMENT, **no** hermes redeploy, **no** commit/push

## 一句话

功能面与研究硬化（RP5/RP7/DL11/BC1/TZ01）已 verified；发布包装 Q03 仍 active；Q01/Q02/Q04 仍 planned；RP7 索引仍绑 `05217a5`，相对 tip `63a4737` 属 **stale vs tip**（非失败）。

## Ledger snapshot（`tasks.json` 只读）

### Verified（本轮关注）

| Id | Owner | Notes |
|---|---|---|
| **RP5** | INTEGRATOR | CI gate；quality green @ `05217a5` / run `37958795828` |
| **RP7** | INTEGRATOR | 发布证据索引+只读 board；**tipSha 仍为 `05217a5`**，非 HEAD |
| **DL11** | DATA | day-planner earliest + planningNow + submit reject-early |
| **BC1** | AI+DATA | 预算契约；worker `operationId`；ephemeral web `operationId` **已接受延期** |
| **TZ01** | DATA+AI | `resolveLocalDayBounds`；预算半开本地日；提醒 IANA；nature 矩阵 **partial** |
| 其余 B*/F*/I*/T*/M*/L*/P*/U*/C*/V*/K*/DL1–10/RP1–6/P04a… | — | 开学功能链大体已 verified（见 tasks.json） |

### Active

| Id | Owner | Blocker honesty |
|---|---|---|
| **Q03** | INTEGRATOR+QA | packaging / Docker compose image build / restore drill 未宣称绿灯；索引中 Q03 相关 checks 均为 **stale** |

### Planned

| Id | Owner | Depends / note |
|---|---|---|
| **Q01** | QA | depends Q03 等；Q01-prep（Understand/Plan/coverage/red skeleton）已 accepted；**仍 planned** |
| **Q02** | QA | depends Q01 |
| **Q04** | QA+INTEGRATOR | depends U04+Q02（proactive acceptance gate） |

## Tip vs RP7 quality tip

```text
05217a5  ← RP7 index tipSha + GHA quality PASS (37958795828)
   …
0e851a5  docs: RP7 index
9182003  docs: RP7 verified
17b29ef  feat: DL11 planningNow + RP7 board
1d5c69e  feat: DL11 retest submit reject-early
5187ec7  docs: DL11 verified
3ec1468  docs: Q01-prep skeleton
471950d  docs: Q01-prep accepted; Q01 stays planned
b2a2004  feat: TZ01 AI budget local-day
63a4737  feat: TZ01 reminder/API local-day closeout; TZ01 verified  ← HEAD
```

- `05217a5` **is ancestor of** `63a4737`。
- RP7 语义：索引绑定**一个** quality SHA；其后 in-scope 提交**不得静默继承**旧绿灯 → 对 tip `63a4737`，质量行应视为 **stale vs tip**（或 pending 重跑），不是 “RP7 失败”。
- DL11 / TZ01 产品提交发生在 index tip **之后** → 若刷新索引，应对这些域相关自动化证据标 stale/pass-after-rerun，而不是假装仍等于 `05217a5`。

## Hermes / live-test 约束

- **禁止**本轮 hermes / opening 服务 redeploy（除非 PM 另行授权）。
- Agent 可做：单元/契约/handler/integration 子集、只读证据、文档 Understand→Plan。
- Paula 浏览器 / study-week 走查：observe-only；不改部署；真实账户联调按 `AGENTS.md` 由用户负责。
- 近期 hermes 相关证据（如 GLM malformed JSON、vision soft readiness）已有 Accept；**不**因整体验证自动重开 hermes 部署。

## Residual honesty（verified 不等于零缺口）

| Area | Residual |
|---|---|
| TZ01 | nature/property 矩阵 partial（overnight/DST/adjacent 有锁；重叠 free / 完整课表展开未宣称） |
| BC1 | ephemeral web `operationId` 延期；worker 侧已锁 |
| DL11 | UI 禁用按钮非验收必需；服务端 reject-early 已锁 |
| RP7 | index tip ≠ HEAD；Q03 rows stale；Q01/Q02/Q04 unknown |
| Q03 | Docker image/compose up、packaging-green、完整 restore drill 未闭环 |
| Q01 | Create-list 4/5 文件缺失；backup Modify 绑 completed Q03；prep-only |

## Sources read（本 Understand）

- `docs/superpowers/plans/opening-release/tasks.json`
- `docs/superpowers/plans/opening-release/15-research-hardening.md`
- `docs/superpowers/plans/opening-release/08-delivery.md` §Q01–Q03
- `docs/superpowers/evidence/2026-10-10-opening-release/release-evidence-index.json` (+ md/board)
- Recent verified notes: `rp7-verified.md`, `dl11-verified.md`, `tz01-verified.md`, Q01-prep set, BC1 accept
- `git log -5 --oneline` / `git status --short` / `git rev-parse HEAD`

## Out of scope（本 Understand）

- 改 `tasks.json` 状态 / evidence 数组
- 产品 IMPLEMENT、hermes redeploy、Docker 宣称绿灯
- 重写 RP7 index（仅在 Plan 中提出 refresh 提案）
- commit / push（Integrator）
