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
| L1 学习闭环基础：安全、首启、受限规划、真实教学 | ChatGPT | `feat/learning-loop-hardening-20261014` | 本地定向单测/边界通过；数据库 CI 验证中，未合并/部署；范围见 `docs/plans/2026-10-14-learning-loop-hardening.md` |
| S4b 行内引用：正文 `[n]` 渲染为来源链接 | Claude（Grok 401，改为自做） | `feat/inline-citation-chips` / #32 | CI 中；待用户浏览器验收 |

已合入（2026-10-13）：#29 选区按源码保存、#31 S4a 服务端引用编号。

## 下一步（按顺序）

1. 部署到 Hermes 开始自用：打开 `OPENING_CHAT_PROSE`、`OPENING_ANSWER_STYLE`；`OPENING_CHAT_ARTIFACTS` 保持关。
2. AI 主讲试跑（V2-16）：V2-04…16 代码已在主干、默认关。部署时打开 `OPENING_TEACHING_LOOP`、`OPENING_TEACHING_WORKSPACE`、`OPENING_TEACHING_COMPILER_ENABLED`、`OPENING_TEACHING_VALIDATION_ENABLED` 并启用 worker，用「秩与零空间」单元（`tests/fixtures/opening/teaching/unit-rank-nullspace`）真实模型走一遍，问题记到“使用反馈”。
3. 按试跑反馈选：V2-20 探索与笔记接入教学（笔记 hub 方向，优先）或 V2-17 证据条件化教学选择。
4. S3 内联 `jw:` 块：自用中出现“这里需要图”的实例再做。

## 负责人已定（2026-10-13）

- 0060 migration 随 #21 合入：有重复键时迁移报错并列出 job，不删数据；回滚 `DROP INDEX opening_jobs_retest_accept_key_uidx`。
- #20：生产环境已重定向的旧页面，其 e2e 退役；仍可访问的页面照常修测试。
- 5 个未推送的旧 worktree 已备份为远端 `backup/wt-*` 分支，可随时删除本地目录。
- 笔记 + 表达与 AI 主讲两条线并行；AI 主讲先试跑已有代码，不新开任务。

## 等用户决定

- Hermes SSH：22 端口连接被重置（HTTPS 正常），部署脚本需要 SSH。请检查安全组/fail2ban 或本机出口 IP。
- Grok CLI 401：在终端运行 `grok` 重新登录后才能派卡。
- 合并与删除 worktree 会被 Claude 的权限拦截：需用户合并 PR，或在设置里放行 `gh pr merge` / `git worktree remove`。
- 本地 25 个 worktree：18 个干净且已在主干或远端，可删；`AIstudy`、`_wt-g1-learning-v2`、`sao-fix-migration-checksum-compat`、`sao-typecheck-int` 有未提交改动，先别删。

## 使用反馈

自用中发现的问题记在这里，一行一条：`日期 · 页面 · 现象`。优先级高于“下一步”。

- （暂无）
