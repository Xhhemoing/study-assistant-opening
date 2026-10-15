# 项目状态看板

每个工具（Claude Code、pi、Grok Bot）开工前读这一页，收工时只改自己负责的行。不超过一屏；详细内容放在 PR 和计划里。

**更新：** 2026-10-15
**目标（至 2026-11 初）：** 自己每天真实使用 → 按使用反馈迭代笔记与 AI 表达；同时试跑 AI 主讲首个单元。

## 主干

- 开发主干：`study-assistant-opening` 远端的 `feat/opening-release`。
- `AIstudy` 远端的 `main` 冻结，不再推送（PR #2 F01 已过时，待关闭）。
- 已合入：G1 #23、G2 #24、S1 #25、S2 #26、S2 评估 #27、S5 #28、#29、#31、#32、#33、jingwei PR1–3；2026-10-14 合入 Grok 小卡 #34–#38。
- Hermes 已部署 `8b500e6`（含 #33）。

## 进行中

| 切片 | 负责 | 分支 / PR | 状态 |
|---|---|---|---|
| G9 保存回合按模式过滤任务建议（只有 listen 不提任务） | Grok + Claude | `fix/tutor-turn-candidate-mode` / #39 | CI 中，绿后可合 |
| 统一模型调度 + 证据闭环（M1–M6、E1–E5） | Claude → GPT | `feat/opening-release`；交接 `docs/plans/2026-10-15-gpt-handoff.md` | M3–M6、E1、E3–E5 已实现并推送；单元/类型/handler/集成回归通过；E2 暂缓，浏览器与真实供应商仍待用户 |

## 下一步（按顺序）

1. 自用：Hermes 换新 Lant key（用户直接写 `/opt/aistudy/.env.production`），确认对话可用；登录后复现“侧栏卡住”，现象记到使用反馈。
2. 大问题方案（用户在问外部意见，回来后定方案再开工）：
   - A 规划 Agent：模型看不到任务/计划/课表、没有工具和多步循环、排期纯规则 → 只读工具 + 只出草稿的写工具（复用 PlanDraft 接受/拒绝、`planDay` 排时段、`runBudgetedCall` 计预算）；聊天内显示计划卡；教练模式持久化并接 `canReorderTask`。
   - B 首次启动：正式版登录后不进 onboarding；onboarding 不收集意图；“开始学习”是固定摘要空记录；无 planning_settings 时没有计划草稿 → 空工作区对话式首启（学什么/何时考/有无材料），写入默认规划设置与场景预设生成首批任务，AI 不可用时降级到笔记/材料路径。
   - C 安全：`/api/opening/health` 无鉴权现场探测；`deploy-hermes.sh` 用保存的 root 密码且跳过主机指纹并改 sshd。
3. AI 主讲试跑（V2-16）：教学 provider 仍是桩（`compile-teaching-unit-wiring.ts`），大纲是模板；试跑前要先接真实模型，否则测不到核心体验。开关见 `docs/operations/hermes-deployment.md`「自用开关」。
4. S3 内联 `jw:` 块：自用中出现“这里需要图”的实例再做。

## 负责人已定（2026-10-13）

- 0060 migration 随 #21 合入：有重复键时迁移报错并列出 job，不删数据；回滚 `DROP INDEX opening_jobs_retest_accept_key_uidx`。
- #20：生产环境已重定向的旧页面，其 e2e 退役；仍可访问的页面照常修测试。
- 5 个未推送的旧 worktree 已备份为远端 `backup/wt-*` 分支，可随时删除本地目录。
- 笔记 + 表达与 AI 主讲两条线并行；AI 主讲先试跑已有代码，不新开任务。

## 等用户决定

- 本次模型/证据交接已快进推送到 `feat/opening-release`；已删除远端 `claude/keen-carson-ls19ie`、`feat/adaptive-loop-v2` 与内容已被目标分支覆盖的 `feat/course-seed-today-plan`。其余分支仍含独有提交，未删除。
- 合并与删除 worktree 会被 Claude 的权限拦截：需用户/Shipper 合并 PR，或在设置里放行 `gh pr merge` / `git worktree remove`。
- 本地 worktree 过多（超过 3 个上限）：已合 PR 的 `sao-fix-shell-review-badge-error`、`sao-docs-hermes-self-use-flags`、`sao-test-real-use-ac-03` 可删。

已解决（2026-10-14）：Hermes SSH reset 是后量子 KEX 握手在本机网络被掐断，`~/.ssh/config` 加 `KexAlgorithms curve25519-sha256`；Grok 改由 bot 团队按卡执行。

## 使用反馈

自用中发现的问题记在这里，一行一条：`日期 · 页面 · 现象`。优先级高于“下一步”。

- （暂无）
