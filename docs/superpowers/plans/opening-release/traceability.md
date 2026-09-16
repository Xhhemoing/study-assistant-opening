# Scope-to-task traceability

此表是计划自审，不是已实现能力声明。2026-09-14新增范围以[能力补充](../../specs/2026-09-14-learning-capability-expansion.md)为准；M4是基础交付，M5/Q04才覆盖本轮完整需求。

## 新增明确需求 → 实现 → 真实验收

| ID | 要求 | 实现任务 | Q04验收依据 |
|---|---|---|---|
| CAP01 | 学校自建邮箱自动接入 | X01,C01,C02,U04 | 获准IMAP只读同步、附件原件、游标/去重/撤销；手工eml不冒充自动同步 |
| CAP02 | 钉钉学习数据接入 | C01,C03,U04 | 具体应用权限、可读通知/文件、验签重放；机器人推送不冒充历史群聊读取 |
| CAP03 | 课件/视频/录音理解 | I01,I02,V01,U04 | 页码/音轨时间/关键帧引用、纠错、静音和噪声样本，不能只验存储 |
| CAP04 | 课程知识架构自动构建 | K01,U04 | 节点与先修有来源、增量修订、非法引用/循环拒绝、跨端可读 |
| CAP05 | 动态学习追踪和针对性辅导 | L01,L02,K02,U04 | 题目/技能/帮助证据→独立新题→延迟重测→更新建议；无虚假掌握百分比 |
| CAP06 | 少思考少选择的学习生活安排 | P01,P02,P04,U04 | 多源去重/改期、≤3优先行动、集中确认、睡眠保护、拒绝不重推 |

新增门禁：`node --test tests/tooling/opening-capability-plan.test.mjs`检查CAP映射及Q04的传递依赖；不检查实际模型或平台效果。

## 原基础范围

| 已批准要求 | 实现任务 | 验收 |
|---|---|---|
| 手机照片/PPT/PDF/音频原件 | I01,I02,U02 | Q01,Q02 |
| 来源可核对的课程辅导 | T01,T02,T03,U03 | 引用不存在拒绝、原件页码、真实样本 |
| 独立学习＋卡点求助 | L01,L02,L03,U03 | 帮助曝光不可抹去、不同题不串扰 |
| 长期理解与可纠正记忆 | T03,M01,U03 | 对话产生候选->用户确认->后续上下文 |
| 临时疲劳不成人格标签 | M01,M03,P02 | 过期、候选隔离、倾听不变任务 |
| 记忆删除与不保存会话 | M02,M03,Q03 | 无正文持久化、删除竞态、旧备份不复活 |
| 校园通知与事务 | T03,P02,U03 | 候选任务、模糊日期确认、来源绑定 |
| 作息精力、休息保护 | P01,P02,U03 | 无空档则不排、不偷睡眠 |
| 协商型权限 | M01,P02,U03 | accept/reject、版本冲突、重复点击 |
| 减少重复输入 | I01,T03,M01,U02,U03 | 上传去重、跨会话恢复、候选集中确认 |
| 分周课表 | P01,P02 | 重复格去重、周六、缺钟点不造日期 |
| 两端同一真实状态 | F03,L03,U03 | 手机写入后电脑读取，无Mock兜底 |
| 单用户安全与未来可迁移 | F01,F03,Q03 | owner隔离、关闭注册、版本化导出 |
| 可恢复后台与费用边界 | I03,T01,Q03 | 崩溃、幂等、未知计费、预算并发 |
| 提醒诚实显示 | P03,U03 | in-app不等于push、回执与取消 |
| 不破坏已有项目 | B00-B02与全局约束 | 独立工作区、原未提交状态保留 |
| 运行监督 | Q03 | 日志脱敏、heartbeat、告警是否真正配置 |

## 本轮语义自审补丁

1. 将T03的模型建议落到持久候选表；补齐M01记忆确认、P02任务确认的消费路径，避免只有聊天、没有后续动作。
2. 补齐TaskCreateInput、EphemeralTurnInput、verdictSource与learningSessionId，避免相邻任务自行发明不兼容字段。
3. 上传票据仅允许写staging对象，完成后转为server-only不可变原件；防止有效票据覆盖已引用资料。
4. 备份恢复先实现再验收；计划任务图无循环。
5. 纸面未知判定不塞进旧boolean正确性模型；用户自报、模型建议和参考核对分别展示。
6. 开学版使用独立opening入口及服务端client，不以重写全部旧平台功能为前置，不把保留的实验页面当正式产品。

## 修改计划时的门禁

先更新interfaces.md及相关任务，再更新tasks.json依赖/状态，运行`node --test tests/tooling/opening-plan.test.mjs`和`node scripts/validate-opening-plan.mjs`；涉及实现再跑相应业务测试。通过结构校验不是免除人工语义复核。

## Real-use AC → task → proposed commands

Source: `docs/quality/opening-real-use-audit.md` §5 and RU-01–07. This is the **test-plan skeleton only**: map each AC onto existing plan tasks and the closest suite command. Probe implementation waits for F02 (then F01) verified. Do **not** open a parallel acceptance suite — extend `tests/` / `tests/integration/` / `tests/e2e/` when writing probes. Fake provider checks protocol; semantic gold labels are human. Release gate order remains Q03→Q01→Q02; early chat UI ≠ backup/delete/live-model/device acceptance.

| AC | Primary RU | Tasks | Proposed commands | Existing hook / boundary |
|---|---|---|---|---|
| AC01 | (mail / draft course) | T03,P02,U03,Q02 | `npm test`; `npm run typecheck` | No probe yet |
| AC02 | (appendix honesty) | I02,T02,Q02 | `npm test` | No probe yet |
| AC03 | RU-01 | F01,F02,I01,U01,U03 | `npm run test:integration -- course-asset-identity`; `npm run typecheck` | `tests/integration/course-asset-identity.test.ts` covers **document** membership; **source** membership awaits F02 (membership-only; no `SourceRecord.courseId`) |
| AC04 | RU-03 | I02,T02,U02,Q02 | `npm test`; `npm run test:integration` | No physical-page probe yet; sample pages in evidence E02 |
| AC05 | (unclear photo) | I02,T01,T02,L01,Q02 | `npm test` | No probe yet |
| AC06 | RU-04 | T03,L01,L02,Q01 | `npm test`; `npm run test:integration` | No learningSession wash probe yet |
| AC07 | RU-02 | T02,T03,U03,Q02 | `npm test`; later U03/T03 | No cross-device resume probe yet; F02 adds `ConversationResume` |
| AC08 | (schedule gaps) | P01,P02,U03,Q01 | `npm test` | F02 adds `TimeConfig.version`; no probe yet |
| AC09 | RU-06 | M01,M03,T02,P02,Q02 | `npm test` | No course-scoped preference probe yet |
| AC10 | (verdict labels) | L01,L02,Q02 | `npm test` | No probe yet |
| AC11 | (weak net / timeout) | I01,I03,T01,T03,U02,U03 | `npm test` | No probe yet |
| AC12 | (reject / delete / restore) | M02,P02,Q03,Q01 | `npm test`; `npm run test:browser` when backup e2e ready | `tests/e2e/native-backup.spec.ts` / integration backup exist for older paths — do not claim opening AC12 until Q03 |

**Shared plan gates (run anytime):** `node scripts/validate-opening-plan.mjs`; `node --test tests/tooling/opening-plan.test.mjs`; `npx vitest run packages/contracts/src/opening/contracts.test.ts`

Protocol probes (post-F02, non-product): `tests/contract/opening-real-use-ac.probes.test.ts` — AC-tagged contract assertions; AC12 remains todo until Q03.

Placeholder cases (skipped): `tests/contract/opening-real-use-ac.placeholders.test.ts` — IDs, commands, and hang points only; bodies wait for F02 verified.

**Wave1 first cut when F02 is verified:** AC03 (RU-01 / source membership link-unlink) → AC04 (RU-03 / current page) → AC07 (RU-02 / ConversationResume). Integration DB tests require `DATABASE_URL`.
