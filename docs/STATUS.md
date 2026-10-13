# 项目状态看板

每个工具（Claude Code、pi、Grok Bot）开工前读这一页，收工时只改自己负责的行。不超过一屏；详细内容放在 PR 和计划里。

**更新：** 2026-10-13
**目标（至 2026-11 初）：** 自己每天真实使用 → 按使用反馈迭代笔记与 AI 表达；同时试跑 AI 主讲首个单元。

## 主干

- 开发主干：`study-assistant-opening` 远端的 `feat/opening-release`。
- `AIstudy` 远端的 `main` 冻结，不再推送（PR #2 F01 已过时，待关闭）。
- 已合入：G1 #23、G2 #24、S1 #25、S2 #26、S2 评估 #27、S5 #28、jingwei PR1–3。

## 进行中

| 切片 | 负责 | 分支 / PR | 状态 |
|---|---|---|---|
| S5 选区按 Markdown 源码保存（原 G4 卡） | Claude | `feat/selection-source-map` / #29 | CI 中；待用户浏览器验收 |
| S4a 行内引用：`[n]` 改写为 citations 序号 | Claude | `feat/inline-citations` | 进行中 |
| S4b 行内引用：正文 `[n]` 渲染为来源 chip | Grok | `feat/inline-citation-chips` | 等 Grok 登录后按卡实现 |

## 下一步（按顺序）

1. 部署到 Hermes 开始自用：打开 `OPENING_CHAT_PROSE`、`OPENING_ANSWER_STYLE`；`OPENING_CHAT_ARTIFACTS` 保持关。
2. AI 主讲试跑（V2-16）：V2-04…16 代码已在主干、默认关。部署时打开 `OPENING_TEACHING_LOOP`、`OPENING_TEACHING_WORKSPACE`、`OPENING_TEACHING_COMPILER_ENABLED`、`OPENING_TEACHING_VALIDATION_ENABLED` 并启用 worker，用「秩与零空间」单元（`tests/fixtures/opening/teaching/unit-rank-nullspace`）真实模型走一遍，问题记到“使用反馈”。
3. S4 行内引用合并后，按试跑反馈选：V2-20 探索与笔记接入教学（笔记 hub 方向，优先）或 V2-17 证据条件化教学选择。
4. S3 内联 `jw:` 块：自用中出现“这里需要图”的实例再做。

## 负责人已定（2026-10-13）

- 0060 migration 随 #21 合入：有重复键时迁移报错并列出 job，不删数据；回滚 `DROP INDEX opening_jobs_retest_accept_key_uidx`。
- #20：生产环境已重定向的旧页面，其 e2e 退役；仍可访问的页面照常修测试。
- 5 个未推送的旧 worktree 已备份为远端 `backup/wt-*` 分支，可随时删除本地目录。
- 笔记 + 表达与 AI 主讲两条线并行；AI 主讲先试跑已有代码，不新开任务。

## 等用户决定

- Hermes SSH：22 端口连接被重置（HTTPS 正常），部署脚本需要 SSH。请检查安全组/fail2ban 或本机出口 IP。
- Grok CLI 401：在终端运行 `grok` 重新登录，或把卡片贴进桌面版。
- 本地 24 个 worktree 超过上限 3 个：确认后由 Claude 清理已合并分支的目录。

## 使用反馈

自用中发现的问题记在这里，一行一条：`日期 · 页面 · 现象`。优先级高于“下一步”。

- （暂无）
