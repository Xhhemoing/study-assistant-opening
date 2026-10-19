# Study 助理升级实施与验收

本轮按用户提供的《Study 助理升级最终实施计划 2026-10-19》实施。复用规范作答、资格、计划草稿和预算账本，补齐从教学进入助理、帮助交付、独立首答、可信判分、状态解释及下一步的连接。用户授权每个可验收部分完成后提交；本轮不自动合并或部署。

## 阶段 0 实际基线

- 发布分支 `feat/opening-release`：`b140d54855798b873e3c39fa8d75a79b620607e9`，迁移末号 0073。发布提交的直接 checks 未返回；不能把空列表称为通过。其来源 PR #68 的 head c283e78 已有完整 CI 成功记录。
- 计划查询基线 `fa322b89ce9f3e88ec76086aa98c1e766a99a66a`（PR #69）；最新查询接线 `feat/study-query-evidence@93e455f57e8771d6ecd76f715117a29dfee35a1b`（PR #70），包含发布基线，迁移末号 0074。核对时 CI 39221765351 仍在运行。
- 本轮隔离分支 `codex/study-upgrade-20261019` 基于 93e455f；保留已有查询、权限及隐私改进，不重复实现或操作原 PR。

## 职责归属与实际缺口

| 层次 | 现有实现 | 本轮处理 |
|---|---|---|
| 规范事实 | opening-learning-attempts、observations、revisions、help、measurement | 保留首答与修订；补版本锚点、交付收据和精确 span 评分 |
| 确定性资格 | evaluateEvidenceEligibility 与 live evidence context | 仍为唯一资格 owner；补语言/数学支持及服务端顺序 |
| 只读投影 | readOpeningCourseEvidence、learner snapshot、planning snapshot | 增加 LearnerState 摘要/明细/保序特征，不能写学习事实或触发 repair |
| 预测 | measurement/BKT 等独立插件 | 影子 BKT/PFA/简单基线，作答前保存截止点和预测，不能签发掌握 |
| 候选与决策 | nextLearningStep、复测、先修、冲刺、PlanDraft | 保留候选生成和排时段分工；增加计划/会话/活动 Decision 及版本失效 |
| 助理 | tutor saved/ephemeral、system-query registry | 已有 8 类只读记录和保存聊天；补读工具、语义目的、交付校验、提案 |
| 预算 | runBudgetedCall + workspace daily ledger | 已有 reserve/claim/unknown/reconcile；缺同一父意图跨规划/回答/编译/fallback 的原子上限 |
| 数学与教学 | matrix evaluation、InlineAttempt、teaching blocks | 复用正式 attempt/evaluation；新增精确有理数 span 三模式和题库 |

“学习状态八处/下一步十来处”是排查范围，不等于八个事实源或十种冲突。任务生成、优先级、排时段、资格和预测分别保留职责；消费者必须解释其粒度及来源。

## 入口覆盖盘点

| 入口 | 已有身份/事实 | 缺口与接入 |
|---|---|---|
| 教学块 | activity/contentVersion/block；正式 attempt 固定教学版本 | 对话当前只拼标签，需结构化 anchor 与关系校验 |
| 练习 | session/attempt/itemVersion；首答/修订 | 普通 saved tutor 校验 attempt，但缺完整活动/材料版本归属 |
| 材料阅读 | source/version/page/chunk 定位 | 旧版本明确保留；实际含解答节选交付需曝光 |
| 今日任务 | 课程/活动/要求路径 | 保持 task 身份，补 anchor 和真实 Decision 解释 |
| 卡片 | source ancestry 与复习事实 | 翻答案的交付需记录，不能把读卡当独立表现 |
| 冲刺 | exam choice/attempt 与课程 bridge | 接同一状态、版本、帮助资格与解释 |
| 临时助理 | 临时来源准入/元数据 | 缺 attempt 链；只保存允许的交付元数据，不改变临时正文不落库约定 |

已有 help 主要在 worker completeTurn 成功后落账，hint/explain 加 learningSession 才覆盖；listen/think_together、历史解析以及其他入口需补齐。生成完成不代表开始放行，客户端 ack 也不是帮助开始的时间。

## 共同规则与迁移分配

1. 一个服务端 resolver 校验 owner/workspace/course/attempt/activity/block/item/source/chunk/KC 版本；无法解析旧版本明确未知或冲突，不静默改为最新。
2. generated、released、acknowledged 分列；释放前使用与提交相同的工作区历史锁，按服务端顺序解释独立性；release key 幂等，ack 不重复记帮助。
3. 父预算满足 settled + pending reservations + next conservative upper bound ≤ parent cap；重试和 fallback 共父 ID，计费未知保持预留，无法估计上界时不假装有保证。
4. Decision 保存层级、父 ID、状态/目标/意图/策略版本、候选与排除原因、选中动作、来源、失效条件。历史解释读取历史记录。
5. 四证据视角可同时成立；未检查不是能力差或已遗忘。忠实语言支持不自动否定数学独立性；内容会影响数学解题则按数学支持记录。
6. 精确判分验证识别后的数学内容；OCR/结构不确定返回 unknown，不记学生错误。教学题、调试题、保留验证题分开。

完成上述盘点后分配：0075 锚点/曝光；0076 父预算；0077 Decision；0078 影子预测。所有迁移 additive，部署前备份、迁移；应用回滚保留新增事实与版本，不删除记录，停止不兼容 worker 后回滚。具体外键/回滚边界随实现审查。

## 分部分交付

- W0：基线、职责、入口覆盖与共同规则。
- W1.5/W1.8：精确判分、边界用例和分离题库。
- W1.1/W1.2：锚点、help release/ack、入口一致性。
- W1.3：原子父预算、fallback、未知结果及晚账务。
- W1.4 与后续状态：LearnerState、分层 Decision、影子预测。
- W1.6 与阶段 2/3：自学/串讲/拔高真实学习路径、所有入口、状态视角及呈现。
- W1.7 与提案：单 Composer、读工具、回答校验、真实草稿及接受 CAS。
- 整合：独立 review、相关回归、最终构建与 CI。

## 不得以自动化替代的验收

用户浏览器/交互/视觉验收按 AGENTS.md 由用户负责。本轮完成代码和非浏览器测试，并交付具体入口与步骤，不运行本地 Playwright，也不改低 CI 门禁。11 月日常试用、自然间隔复测、同时间新题表现与迁移效果、帮助依赖/主观负担及预测校准必须通过真实学习数据；实现可记录这些结果，不能现在声称已有效。

固定回归必须覆盖混课 ID、旧版本、断线幂等、并发提示与提交、首答/修订、评分纠正与 Decision 失效、权限/截断/落后、历史原因、草稿接受重验和并行预算竞争。
