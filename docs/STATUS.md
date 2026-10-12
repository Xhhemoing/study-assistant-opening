# 项目状态看板

每个工具（Claude Code、pi、Grok Bot）开工前读这一页，收工时只改自己负责的行。不超过一屏；详细内容放在 PR 和计划里。

**更新：** 2026-10-13
**目标（至 2026-11 初）：** 自己每天真实使用 → 按使用反馈迭代笔记与 AI 表达。

## 主干

- 开发主干：`study-assistant-opening` 远端的 `feat/opening-release`。
- `AIstudy` 远端的 `main` 冻结，不再推送（PR #2 F01 已过时，待关闭）。

## 进行中

| 切片 | 负责 | 分支 / PR | 状态 |
|---|---|---|---|
| 合并队列（#21 集成 13 个 PR） | Claude | `integrate/opening-release-batch` / #21 | 已撤出 #20，CI 重跑中 |
| #20 生产环境隔离 mock | Claude | `fix/production-mock-isolation` | 待决定：15 个旧页面 e2e 是迁移还是退役 |
| #1 学习入口简化 | Grok | `fix/opening-learning-experience` | 基线过旧，需 rebase |
| 协作流程与本看板 | Claude | `docs/agent-workflow` | 实现中 |

## 下一步（按顺序）

1. #21 合入 → 关闭已包含的 PR（#6 #7 及 #21 列出的各 PR）。
2. 部署到 Hermes，开始自用（见 `docs/operations/hermes-deployment.md`）。
3. AI 表达 S1 正文渲染 → S2 写作契约（`docs/plans/2026-10-12-ai-expression-plan.md`）。
4. jingwei PR4 笔记成果块（= 表达计划 S5）。

## 等用户决定

- 0060 migration（`opening_retest_accept_key`）签字，回滚方案在 #18。
- #20：旧 `/learn`、`/explore`、`/library` 页面在生产重定向后，对应 e2e 退役还是迁移到 `/opening/*`。
- 删除失效 worktree（清单由 Claude 列出后确认）。

## 使用反馈

自用中发现的问题记在这里，一行一条：`日期 · 页面 · 现象`。优先级高于“下一步”。

- （暂无）
