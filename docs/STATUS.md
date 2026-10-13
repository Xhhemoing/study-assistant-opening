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
| G1 学习入口简化（Supersedes #1） | Claude 接手 | `fix/opening-learning-experience-v2` | 已推送，待开 PR |
| G2 生产隔离 mock + e2e 退役（Supersedes #20） | Claude 接手 | `fix/production-mock-isolation-v2` | 已推送，待开 PR |
| 协作流程与本看板 | Claude | `docs/agent-workflow` / #22 | 已合入新主干，CI 重跑 |
| S1 正文 Markdown/KaTeX 渲染 | Claude | `feat/learning-prose` | 已推送，待开 PR；待用户浏览器验收 |

## 下一步（按顺序）

1. G1/G2/S1 开 PR → CI 绿后合并，关闭 #1。（#21 已于 2026-10-13 合入。）
2. 部署到 Hermes，开始自用（见 `docs/operations/hermes-deployment.md`）。
3. AI 表达 S1 正文渲染 → S2 写作契约（`docs/plans/2026-10-12-ai-expression-plan.md`）。
4. jingwei PR4 笔记成果块（= 表达计划 S5）。

## 负责人已定（2026-10-13）

- 0060 migration 随 #21 合入：有重复键时迁移报错并列出 job，不删数据；回滚 `DROP INDEX opening_jobs_retest_accept_key_uidx`。
- #20：生产环境已重定向的旧页面，其 e2e 退役；仍可访问的页面照常修测试。
- 5 个未推送的旧 worktree 已备份为远端 `backup/wt-*` 分支，可随时删除本地目录。

## 等用户决定

- 开 PR：Claude 的 `gh pr create` 被权限拦截，需用户执行或放行。

## 使用反馈

自用中发现的问题记在这里，一行一条：`日期 · 页面 · 现象`。优先级高于“下一步”。

- （暂无）
