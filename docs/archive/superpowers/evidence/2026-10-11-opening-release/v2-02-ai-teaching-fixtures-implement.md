# V2-02 AI half — 教学样本 / fixtures / 评测标准 IMPLEMENT

**Date:** 2026-10-11（Asia/Shanghai）  
**Branch:** `feat/opening-release`  
**Baseline tip:** `1a4cf465c86da7f08b6fda3044f9b0f932b80824`  
**Owner:** AI（AIstudy）  
**Task:** V2-02（AI half）— 秩与零空间可核查教学单元与评测样本  
**Status:** IMPLEMENT（docs/fixtures only）— **not committed / not pushed / no stash/reset**  
**Product code changed:** **无**

## Scope delivered

1. `tests/fixtures/opening/teaching/unit-rank-nullspace/` — 原材料、教学目标、正确例/典型错误、讲解检索白名单、未曝光评测隔离、异常案例。  
2. `docs/quality/teaching-v2-evaluation.md` — **仅填写 AI 区**（内容标准、评测标准、样本清单、人工核查、合交说明）；**保留** Experience EX + E0–E9。  
3. `tests/fixtures/opening/teaching/README.md` — **保留** Experience 边界文；追加 AI inventory / 计数。

## Counts

| Category | Count |
|---|---|
| materials sources | 5 |
| chunks | 14 |
| correct examples | 12 |
| typical errors | 10 |
| heldout problems | 15 |
| anomaly cases | 9 |
| **countable total** (chunks+examples+errors+heldout+anomalies) | **60** |

（工程建议区间 30–60；非功效分析样本量。）

## Files

| Path | Action |
|---|---|
| `tests/fixtures/opening/teaching/unit-rank-nullspace/manifest.json` | create |
| `tests/fixtures/opening/teaching/unit-rank-nullspace/symbols.md` | create |
| `tests/fixtures/opening/teaching/unit-rank-nullspace/materials/SRC-RN-01…05-*.md` | create |
| `tests/fixtures/opening/teaching/unit-rank-nullspace/materials/sources-index.json` | create |
| `tests/fixtures/opening/teaching/unit-rank-nullspace/goals/teaching-goals.json` | create |
| `tests/fixtures/opening/teaching/unit-rank-nullspace/examples/correct-examples.json` | create |
| `tests/fixtures/opening/teaching/unit-rank-nullspace/examples/typical-errors.json` | create |
| `tests/fixtures/opening/teaching/unit-rank-nullspace/lecture/activity-outline.json` | create |
| `tests/fixtures/opening/teaching/unit-rank-nullspace/lecture/retrieval-allowlist.json` | create |
| `tests/fixtures/opening/teaching/unit-rank-nullspace/eval-heldout/ISOLATION.md` | create |
| `tests/fixtures/opening/teaching/unit-rank-nullspace/eval-heldout/heldout-problems.json` | create |
| `tests/fixtures/opening/teaching/unit-rank-nullspace/eval-heldout/retrieval-denylist.json` | create |
| `tests/fixtures/opening/teaching/unit-rank-nullspace/anomaly-cases/cases.json` | create |
| `tests/fixtures/opening/teaching/README.md` | update（append；保留 Experience） |
| `docs/quality/teaching-v2-evaluation.md` | update（填 AI 区；不删 EX/E） |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-02-ai-teaching-fixtures-implement.md` | create（本文件） |

## Explicit non-touches

- 无 `apps/` / `packages/` 生产代码  
- 未改 Experience EX / E0–E9 正文  
- 未改 `docs/superpowers/plans/opening-release/tasks.json` / `ai-led-learning-v2/tasks.json`  
- 无 commit / push / stash / reset  
- 未宣称真实模型通过、浏览器验收或学习效果

## Isolation (acceptance hard constraint)

- Lecture retrieval allowlist ⊆ materials + lecture examples only  
- Held-out problemIds ⊆ `retrieval-denylist.json`；**不**出现在 allowlist  
- `eval-heldout/ISOLATION.md` 写明：未曝光题不得进入教学检索 / tutor instruction context  
- 换引用 ID 或微调数字 ≠ transfer（anomaly + eval doc）

## Sanity checks run

- 全部相关 JSON `json.load` OK  
- heldout ⊆ denylist 且 denylist ⊆ heldout  
- 无 heldout id 在 allowlist  
- goals/examples/errors/activities/allowlist 的 sourceId 均在 sources-index  
- manifest counts 与实际一致  
- Experience merge markers 仍在 README + eval doc  

**RESULT: ALL CHECKS PASSED**

## 未能核验项

- 样例矩阵金标：本地 rank/nullspace 核对过 hook / 主要 worked 与部分 heldout；**无**未能核验金标条目列入清单。  
- 真实模型生成质量、浏览器 UI、学习效果：**未跑**（evidence_status 保持 not_run / pending_user / unknown）。

## How to review (Integrator)

1. 扫 `unit-rank-nullspace/`：材料 → 目标 → 正例/错例 → lecture allowlist → eval-heldout denylist。  
2. 打开 `docs/quality/teaching-v2-evaluation.md`：确认 EX/E0–E9 仍在；AI §1–7 已填。  
3. 确认 heldout 不进 allowlist；E4 与 fixtures 互引。  
4. `git status`：仅 docs/fixtures（及他专员未推文件）；无 apps/packages。  
5. Experience 半边已 ACCEPT；本半为合 Accept 的 AI 侧。

## Accept ask（Integrator）

请 Accept **V2-02 AI half**（可与已 ACCEPT 的 Experience 半边合为 V2-02）当且仅当：

- [ ] 首单元有可回查材料与独立评测标准  
- [ ] 未曝光题隔离（denylist / ISOLATION / 不进 allowlist）成立  
- [ ] 样本计数在工程建议范围；JSON/引用一致性检查通过  
- [ ] 无生产代码；未覆盖 opening-release verified 账本；未推  
- [ ] Experience EX/E 节未被 AI 删除或改写  

## Rollback

移除 `tests/fixtures/opening/teaching/unit-rank-nullspace/` 与本证据；还原 eval doc AI 区为占位；**不**删除用户材料；不触碰 Experience 已 ACCEPT 半边除非 PM 指示。
