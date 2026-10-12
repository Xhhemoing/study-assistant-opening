# 多工具开发分工

**生效：** 2026-10-13，取代 [codex-team.md](codex-team.md) 与 [project-lead-prompt.md](project-lead-prompt.md) 中的角色、模型路由和派单流程（两者仅作历史）。根 `AGENTS.md` 的编码、测试、浏览器验收分工约定不变。

## 分工

| 工具 | 特点 | 负责 |
|---|---|---|
| Claude Code | 强，贵 | 难的部分：架构与接口设计、migration、并发/事务/权限、跨包改动、长期定位不了的 bug、集成冲突、最终审查与合并。写任务卡。 |
| Grok Bot | 快，量大 | 照任务卡实现：边界清楚的功能切片、测试补齐、rebase、lint/类型修复、机械重构、文档整理。 |
| pi | 模型多，功能简单 | 第二意见：用与实现方不同的模型做只读审查或方案对比；快速问答。不负责统筹。 |

判断难不难，看三点：会不会动共享契约 / migration / 权限；需不需要在多个包之间权衡；失败一次的代价大不大。占一条就交 Claude，否则交 Grok。

## 一个切片的流程

1. **拆卡（Claude）**：从 [STATUS.md](../STATUS.md) 选下一项，写一张任务卡（模板见下），在 STATUS 里登记负责方和分支。
2. **实现**：难的部分由 Claude 直接写；其余交 Grok，每张卡一个 worktree、一个分支。
3. **审查**：Grok 的改动先由 pi 的只读审查角色看一遍（可选，改动大时做），再由 Claude 看 diff 和 CI。Claude 只修确定的缺陷，风格问题不返工。
4. **合并（Claude）**：开 PR 到 `feat/opening-release`，CI 绿后合并，更新 STATUS。
5. **验收（用户）**：浏览器和真实使用由用户负责；问题写进 STATUS 的“使用反馈”。

同时最多 3 个活跃 worktree（本机内存曾因此耗尽）。PR 合并后删掉对应 worktree。

## 任务卡模板

```text
目标：<用户看得到的结果，一句话>
仓库：E:/Project/study-assistant-opening，基于 feat/opening-release 新建分支 <type>/<name>，在独立 worktree 里做
允许修改：<文件或目录>
不许动：packages/contracts 公共导出、migration、package.json/lockfile、CI（需要时停下来报告）
要保留的行为：<安全、权限、错误处理等>
完成标准：<最近的测试命令>、所属包 typecheck 通过
返回：改了哪些文件、实际运行的命令和结果、没解决的问题
先读 AGENTS.md 和目标包的 AGENTS.md。不要 commit/push 之外的 Git 历史操作，不跑浏览器测试，不调用付费模型 API。
```

## 工具用法

**Grok Bot**：桌面版直接贴任务卡。命令行用 `grok -w <分支名> --prompt-file <卡片文件>`，首次需要登录（`grok` 交互界面里完成）。pi 里的 `sand-ai/grok-bot` 只能聊天，不支持工具调用，不能用来写代码。

**pi**：只读审查用项目角色 `opening-sol-reviewer`（`tokenfree-sol/gpt-6.1-sol`，2026-10-13 实测可用）。`glm-reviewer`、`k3-reviewer`（`lant`）当天连接失败，恢复后可作为更换模型的第二审查。换了网关后只改 `.pi/agents/*.md` 的 `model` 一行，并在这里更新可用列表，不再新增路由文档。

**Claude Code**：一个会话只做一个切片或一个合并批次。开工先读 STATUS，收工更新 STATUS；多个 Claude 会话并行时，按分支划清所有权。

## 不再做

- 反复“全面分析项目进度”。现状以 STATUS 和 PR 列表为准，有具体问题再查。
- 新建 evidence、baseline 文件，或把任务账本当状态入口。`docs/superpowers/plans/*/tasks.json` 仍受 `validate-opening-plan.mjs` 校验，保持可通过即可；当前状态只看 STATUS。
- 为一个小改动走完整的定位→实现→审查→交付角色链。
