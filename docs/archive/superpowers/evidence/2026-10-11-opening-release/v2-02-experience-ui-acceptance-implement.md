# V2-02 Experience half — UI/交互验收线索 IMPLEMENT

**Date:** 2026-10-11（Asia/Shanghai）  
**Branch:** `feat/opening-release`  
**Baseline tip:** `1a4cf465c86da7f08b6fda3044f9b0f932b80824`  
**Owner:** Experience（AIstudy）  
**Task:** V2-02（Experience half）— UI/交互验收线索  
**Status:** IMPLEMENT（docs/fixtures only）— **not committed / not pushed / no stash/reset**  
**Product code changed:** **无**

## Paula 补充约束（必须引用）

Paula（本轮 steering）要求写入 UI/交互验收线索，M0 与后续 M1 均按此：

1. **复用**现有 Today / 助手 / 资料 / 证据账本与导航；AI 主讲是**主区演进**，不是旁路新 App。  
2. 新接口 / 组件接进**现有契约与样式**（Tailwind / lucide），**不**平行造第二套事实或评分。  
3. 入口优先「继续学习 / 开始学习」落在**现有首页与活动流**，不强迫新问卷或孤立页。

落盘位置：`docs/quality/teaching-v2-evaluation.md` → **§ EX. 嵌入现有程序 / 非旁路**（EX.1–EX.6，`M0-sample` / `M1-ui`），并交叉引用 E0 / E8 / E9。

## Files written / updated

| Path | Action | Notes |
|---|---|---|
| `docs/quality/teaching-v2-evaluation.md` | **create** | 全文骨架 + Experience UI·交互验收（E0–E9、**EX**）+ AI 占位 `<!-- AI: pedagogical samples / item bank / answer keys -->`；未拆第二文件 |
| `tests/fixtures/opening/teaching/README.md` | **create** | 仅边界说明：AI 拥有内容 fixtures；Experience UX 线索在 docs/quality；**无**自创题库；承认并存的 `unit-rank-nullspace/`（AI） |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-02-experience-ui-acceptance-implement.md` | **create** | 本证据 |

**未创建** `docs/quality/teaching-v2-ui-acceptance.md`（长度可单文件承载；若 AI 样本膨胀再拆并双向链接）。

## Explicit non-touches

- 无 `apps/` / `packages/` 生产代码改动  
- 未编辑 `packages/ai`、worker、database  
- 未改 `docs/superpowers/plans/opening-release/tasks.json` verified 行  
- 未触碰 `rp5-gha` 证据  
- 无 commit / push / stash / reset  

## Checklist sections summary（Experience）

| 节 | 内容 | 标记 |
|---|---|---|
| **EX** | 嵌入现有程序 / 非旁路（Paula） | `M0-sample` + `M1-ui` |
| E0 | 入口与主区；非阅读器先行 | 多为 `M1-ui`；文档层 `M0-sample` |
| E1 | 秩与零空间样例流（T 引入→零空间/像→定义→计算；更直观/证明/完整/英文/跳过） | `M1-ui` + 内容依赖 AI |
| E2 | 矩阵/向量/文字同参 | `M1-ui` |
| E3 | 引用可查；材料依据 vs 一般讲解徽章；无假引用 | `M1-ui` |
| E4 | 未曝光题不进教学检索 / picker | `M0-sample` + `M1-ui` |
| E5 | 暂停恢复：草稿/帮助/未核验能力；禁假掌握% | `M1-ui` |
| E6 | 无强制先测；可跳过/退出 | `M1-ui` |
| E7 | 生成失败不静默丢草稿 | `M1-ui` |
| E8 | Paula 浏览器建议步骤（含 EX 第 0 步）；诚实标明多数 UI 未建 | 线索 only |
| E9 | G1–G8 映射（含 EX） | — |
| AI 区 | 占位，留给 AI | — |

## How to review

1. 打开 `docs/quality/teaching-v2-evaluation.md`，确认 **EX** 六条可勾选且引用 Paula 三点。  
2. 扫 E0–E8：每条有 `M0-sample` 或 `M1-ui`；E8 写明验收线索而非 UI 已存在。  
3. 确认 AI 占位注释仍在，Experience 未填题库。  
4. 确认 `tests/fixtures/opening/teaching/README.md` 仅边界、无假 item bank。  
5. `git status` / `git diff --stat`：仅上述 docs/fixtures；无 apps/packages。  
6. `git rev-parse HEAD` 仍为 baseline `1a4cf46…`（本半未 commit）。

## Coordination for AI

- 落盘时已见 AI 目录 `tests/fixtures/opening/teaching/unit-rank-nullspace/`（含 `eval-heldout/`）。Experience **只**更新了同级 README 边界说明，**未**改 AI 内容文件。
- AI 可写入同文件 **「AI：教学样本 / 题库 / 答案键」** 区与 `tests/fixtures/opening/teaching/` 内容；**勿删除** Experience / EX 节。  
- Hold-out 题必须与教学检索包隔离（E4 + fixtures README）。  
- 样例流与 E1（\(T(x,y)=(x+y,0)\)）对齐，便于日后 UI 对照。

## Accept ask（Integrator）

请 Accept **V2-02 Experience half**（文档/线索半）当且仅当：

- [ ] EX（Paula 嵌入非旁路）已写入且可勾选  
- [ ] E0–E8 覆盖派工所列交互主题，并标 M0/M1  
- [ ] 无生产代码变更；未覆盖 opening-release verified 账本；未碰 rp5-gha  
- [ ] AI 占位保留；Experience 对 fixtures 仅 README 边界（AI 内容目录不由本半编写）  

**不**将本证据视为 UI 已上线或 `user_browser=verified`。AI half（样本/题库）可另条 Accept。

## Gates

文档任务：无强制 tsc/vitest。可选人工：

```bash
git rev-parse --short HEAD   # expect 1a4cf46
git status --short           # only docs/quality, tests/fixtures/.../README, this evidence
rg -n "嵌入现有程序|Paula" docs/quality/teaching-v2-evaluation.md
```
