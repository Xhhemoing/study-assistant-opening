---
title: 对标 DeepStudent 的产品与架构研究
date: 2026-09-06
status: exploring
scope:
  - 产品定位、学习闭环、数据权威、AI 治理、分发
  - Learn / Explore / Library / Practice / Review
  - LearningEvent / Attempt / AssessmentSnapshot / Goal / PlanItem
  - apps/web、apps/worker、packages/domain、packages/database
related:
  - ../product/PRD.md
  - ../product/UX_AND_AI_POLICY.md
  - ../architecture/ARCHITECTURE.md
  - ../business/OPEN_SOURCE_AND_MARKETPLACE.md
  - ../quality/2026-08-15-learning-loop-issue-register.md
  - ../plans/2026-07-21-lifelong-learning-design.md
  - ALGORITHM_MAP.md
promotion_target:
  - 不自动提升；仅作研究笔记
  - 不得据此改 PRD 去复制桌面工作台、FSRS、MCP 或思维导图
  - 后续正式化只允许服务现有 P0：Learn 主读切服务端、Goals/plan-state、门禁与开源治理
---

# 对标 DeepStudent 的产品与架构研究

## 1. 决策问题

DeepStudent（[helixnow/deep-student](https://github.com/helixnow/deep-student)）是 2026 年可见度最高的开源“AI 学习工作台”之一。AIstudy 也自称终身学习平台。两者容易被误读为同一赛道，从而把桌面客户端、FSRS、MCP、思维导图和资料问答做成下一优先级。

本记录回答：

1. DeepStudent 实际在卖什么，而不是功能清单上写了什么；
2. AIstudy 在 HEAD 上真正已提交、仍是草稿、仍属规划的边界；
3. 哪些差异必须保留（数据权威、AI 审核、教育学闭环）；
4. 哪些缺口是 AIstudy 自己的 P0，而不是对标抄作业。

本记录是研究候选，不批准实现，不修改 PRD，不把未提交 Goals/plan-state 草稿视为已发布。

## 2. 指向范围

| 层次 | 明确指向 |
|---|---|
| 用户场景 | 成人学习者带着目标、资料和练习进入产品后，能否形成可复核的学习事实、状态和下一步；对比 DeepStudent 的“导入资料 → 问答 → 导图 → 出题 → 闪卡”工作台路径 |
| 产品入口/流程 | Learn / Explore / Library；Practice / Review / Today Plan；DeepStudent 的 Chat V2 / Learning Hub / CardForge / Skills |
| 领域对象 | `LearningEvent`、`Attempt`、`AssessmentSnapshot`、`Card`、`PracticeItem`、`Goal`、`PlanItem`、`Document/Block/Revision`、`Exploration` |
| 代码边界 | `apps/web`、`apps/worker`、`packages/{domain,database,contracts,ai}`；DeepStudent 为 Tauri 2 + SQLite/LanceDB/Blob |
| 计划任务 | 问题总账 AIST-001～007（P0）、AIST-008/009/013；不新增桌面/FSRS/MCP 任务 |

## 3. 不变量与约束

- AIstudy 已批准方向是云端优先终身学习 OS：三平等入口，课程是可选长期上下文，不可变学习事件 + 可重算派生评估。见 [PRD](../product/PRD.md) 与 [终身学习平台调整设计](../plans/2026-07-21-lifelong-learning-design.md)。
- 默认 UI 只显示状态词 + 少量结果 + 下一步。AI 默认副驾驶：候选需确认；禁止 AI 代学。见 [UX_AND_AI_POLICY](../product/UX_AND_AI_POLICY.md)。
- 工作区现有未提交改动视为用户所有。未提交 `0016_goal_and_plan_state.sql` 与 `/api/goals` 草稿不算已发布。
- 不得 merge `origin/v0/xhhemoing-890edbc1`（早期 UI/pnpm 实验，相对 HEAD `42 5`）。
- 不得把 AGPL-3.0 直接套到 AIstudy。开源治理缺口是 LICENSE/CONTRIBUTING/SECURITY 缺失（AIST-013），不是许可证对标。
- 冷启动原则仍是一个高数种子包 + 4–8 周成人试点；Marketplace、教师/班级、离线客户端、插件 SDK、pgvector、FSRS/IRT/BKT 暂缓。
- 本环境未重跑 unit/integration/handler/browser/build。本地无 Docker CLI、PATH 无 `bash`。不得把未跑过的门禁写成已通过。

## 4. 已验证事实

### 4.1 证据边界

| 对象 | 证据截止 | 不包含 |
|---|---|---|
| DeepStudent | 2026-09-06 公开材料：GitHub README（中/英）、[官网](https://deepstudent.cn/)、[文档站](https://deepstudent.cn/docs/)、latest release **v0.9.54**（2026-09-05）、`package.json`/`Cargo.toml`/`tauri.conf.json` 版本同步 0.9.54 | **未做本地安装或功能实测**。用户手册仓库副本写明基于 **v0.9.42**（2026-07-19），手册可能落后于 v0.9.54 |
| AIstudy | HEAD `bdf0162`（`feat/complete-phase1-current-work`）+ 已提交 migration `0001`–`0015` + 已跟踪 API 路由 | 未提交 `0016`、`/api/goals`、`goal-service.ts` 及对应测试；README/TODO 仍写 HEAD `146d666`（已知 AIST-014 漂移，本记录不修复） |
| 质量门禁 | 仅记录环境阻塞事实 | 本轮未声称测试通过 |

GitHub API（2026-09-06）：`helixnow/deep-student`，描述 “An open-source, local-first AI learning workbench”；license AGPL-3.0；stars **261**；forks **55**；open issues **21**；latest release [v0.9.54](https://github.com/helixnow/deep-student/releases/tag/v0.9.54)。

### 4.2 DeepStudent：公开产品事实

定位：开源、本地优先的 AI 学习工作台。官网标题同时使用 “您的终身学习空间｜DeepStudent” 与 “Become Your Lifelong Learning Space”。核心主张不是功能更多，而是 **给 AI 原生读写全部学习数据**，用统一 VFS/数据层打通资料、笔记、导图、题目、翻译和闪卡。

公开能力面（README / 文档站，非实测）：

- 资料 AI 问答，预置 12 家模型供应商；权限三档 Ask / Plan / Craft（中文：问一问 / 想一想 / 做一做），**默认 Craft**。
- 跨平台分发：Win `.exe`、macOS `.dmg`、Linux `.deb`/`.AppImage`（README 另列 rpm）、Android `.apk`；iOS 仅 Xcode 源码构建。
- 数据：SQLite（rusqlite）+ LanceDB + Blob；全量 ZIP 备份；AES-256-GCM。
- 云同步：实验性、备份式；桌面 WebDAV / S3 / 实验性 FTP，Android 仅 WebDAV；非实时协作。
- 笔记：Milkdown 富文本 + 标签 + AI；知识导图（大纲/导图双视图、背诵模式）。
- 练习：AI 出题、题库、自动判分；闪卡 FSRS（vendored `rs-fsrs`）+ APKG + AnkiConnect。
- 翻译精读、导入 OCR、深度调研（多搜索引擎）+ arXiv/OpenAlex、作文批改、MCP/skills（宣称 40+ 内置技能）。
- 无实时多人协作。路线图通往 v1.0：体验/稳定、双端 UI、云同步增强、技能扩展、更多模型。

架构：Tauri 2 + React 18 + Vite 6 + TypeScript；前端 `src/features/*`，后端 `src-tauri`（chat_v2、vfs、memory、mcp、cloud_storage、qbank_grading 等）。

### 4.3 AIstudy：HEAD `bdf0162` 能力边界

产品：云端优先终身学习平台。三平等入口：目标学习 / 自由探索 / 笔记知识库。课程是可选长期上下文。不可变学习事件 + 可重算派生评估。默认 UI 只显示状态词（稳固/可用/薄弱/未测）+ 少量结果 + 下一步。AI 默认副驾驶。

架构：npm workspaces；`apps/web` Next.js App Router；`apps/worker`；`packages/{domain,database,contracts,ai,config,ui}`；PostgreSQL + Redis/BullMQ + S3/MinIO。学习页真实路径在 `apps/web/src/app/(workspace)/learn/...`，不是 `(app)`。

**已提交且可追溯（migration `0001`–`0015`）：**

- Workspace、Document/Block/Revision/Relation/Property、Course/AssetMembership。
- Auth + 可吊销会话 + Workspace 授权。
- Exploration + 候选审核/promotion。
- Learning Event、Cards、Practice content、Assessment replay、Attempts、Reviews。
- Native backup export/restore；Markdown/Anki 导出投影。
- `/api/attempts` 服务端判题；请求契约不再接受客户端权威 `correct`。
- SRS `FOR UPDATE` + 并发测试文件在 HEAD。
- `0014` 表级 no-delete trigger。
- 预览页：`/preview/notebook`、`/preview/notion-import`。
- domain：SRS scheduler、assessment bands、planner、intervention、requirement profiles、guidance modes、markdown/anki/native portability。

已跟踪 API 目录：`assessment, attempts, auth, backups, cards, courses, documents, explorations, exports, health, practice, promotions, reviews, revision-proposals, search, workspace`。工作区虽有 `goals/` 目录，但是 **untracked**，不算已发布。

**存在但未闭合 / 不算已发布：**

- Learn/Goals/Practice/Review/Today Plan **主读仍是 `createMockProvider()` + localStorage**。证据：`apps/web/src/lib/data/react.ts` 的 `useStudyProvider()` 包装 `createMockProvider`；`today-plan-view.tsx`、`goal-list.tsx`、`practice-player.tsx`、`review-session.tsx` 均调用该 hook。
- 练习页：`/api/attempts` 已服务端判题，但题目仍从 Mock 取；`practice-player.tsx` 本地仍调用 `isPracticeAnswerCorrect`。
- `withPersistedAttempts` / `withPersistedReviews` 是 Mock 主读上的服务端旁路，不是主读切换。
- `/api/assessment` 可从 events 重放，UI 仍 Mock。
- 未提交 `0016` + `/api/goals` 草稿 ≠ 已发布（`git ls-files` 对 `goal-service.ts` / `0016` 为空）。
- Worker 仍是 in-memory smoke processor（`apps/worker/src/index.ts`）。
- LICENSE / CONTRIBUTING / SECURITY 缺失（AIST-013）。
- Marketplace、教师/班级、离线客户端、插件 SDK、pgvector、FSRS/IRT/BKT 暂缓。

权威问题总账：[docs/quality/2026-08-15-learning-loop-issue-register.md](../quality/2026-08-15-learning-loop-issue-register.md)。P0 仍是 AIST-001～007（attempts 服务端判题已 Partial；Learn 主读 Mock 未闭合）。总账正文仍标注 HEAD `146d666`，与真实 HEAD `bdf0162` 存在文档漂移（AIST-014）。

### 4.4 本仓库 Git 同步事实（2026-09-06）

- remote：`git@github.com:Xhhemoing/AIstudy.git`
- 当前分支：`feat/complete-phase1-current-work`
- HEAD：`bdf0162 docs: align HEAD capability boundary with migrations 0012-0015`
- 已 `fetch --all --prune --tags`；**未 merge、未 stash、未 push**。
- 相对 `origin/feat/complete-phase1-current-work`：ahead 10。
- 相对 `origin/main`：`39 0`（包含全部 main）；相对 `origin/dev`：`33 0`（包含全部 dev）。
- `local main == origin/main == 7e0f6b8`。
- 未合入 HEAD 的远端分支只有 `origin/v0/xhhemoing-890edbc1`（`42 5`，不要合并）与已包含的 `origin/v0/xhhemoing-06c10454`（`42 0`）。
- 工作区脏：用户所有的 auth/goals schema 修改，以及未跟踪的 Goals/plan-state 草稿。本记录不触碰这些路径。

验证现实：本环境未重跑质量门禁。本地无 Docker CLI、PATH 无 `bash`。CI `main` 近期 run 被 `bitnami/minio:2025.4.22` manifest unknown 阻断。

## 5. 假设与未知项

| 假设/未知项 | 风险 | 验证方法 |
|---|---|---|
| DeepStudent README 能力面与 v0.9.54 实际行为一致 | 公开文档可能超前或滞后于客户端；尤其用户手册基线是 v0.9.42 | 本地安装 v0.9.54 后沿“导入 PDF → 问答 → 导图 → 出题 → 闪卡”走查；本轮未做 |
| Craft 默认写权限在真实使用中足够克制 | 若默认执行写操作，学习事实与用户意图可能被 AI 污染 | 阅读权限矩阵与一次真实制卡/出题操作；对照 AIstudy 的“禁止代学” |
| AIstudy Learn Mock 主读一旦切换，现有 domain planner/assessment 可直接驱动 UI | 契约或夹具缺口可能迫使并行改造 API | 先写失败测试：清空 localStorage 后 Today Plan / Practice / Review 仍来自服务端 |
| 未提交 0016 草稿最终会成为 Goals 真源 | 草稿可能改名、拆分或放弃；提前当已发布会造成文档污染 | 仅在提交 + handler/integration 通过后登记 |
| 成人高数试点用户更需要“可信任的下一步”，而不是“资料工作台” | 若真实用户首要痛点是 PDF/导图/Anki，AIstudy 差异化会显得空洞 | 4–8 周试点访谈；在 Learn 主读闭合前不做产品转向 |

## 6. 候选方案

### 方案 A：当前基线（闭合服务端权威学习闭环）

继续 AIstudy 已批准方向：云端 Web、事件账本、服务端判题、可重算评估、AI 候选+审核。下一刀只切 P0：

1. Learn/Practice/Review/Today Plan 主读离开 Mock；
2. 完成并验证 Goals/plan-state（当前仅草稿）；
3. 修复 CI MinIO 与本地 bash/Docker 阻塞；
4. 补 LICENSE/SECURITY 等治理文件，不先做 AGPL 对标。

这是可运行的最低复杂度方案：不新增产品面，只让已有教育学内核接上真实数据。

### 方案 B：增强方案（在 A 完成后再吸收工作台局部能力）

仅当 A 的主读、事件、评估和试点指标稳定后，再评估 **单点** 能力是否值得引入：例如更好的 PDF 阅读、Anki 导出体验、导入 OCR。每一项必须证明服务现有三入口，而不是把 AIstudy 变成第二套 DeepStudent。

额外成本：桌面壳、VFS、MCP、FSRS 优化器和多供应商聊天都会显著扩大攻击面与维护面。

### 方案 C：替代方案（复制 DeepStudent 工作台）

把下一阶段改成 Tauri 客户端、统一 VFS、默认 Craft、FSRS/APKG、MCP skills、思维导图。这会放弃 AIstudy 已投入的服务端权威账本、Workspace 授权、exploration promotion 和评估切片，并引入 AGPL 许可证冲突。

不适用原因：与已批准 PRD 冲突；P0 数据可信度问题不会因此消失；范围膨胀正是 AIST-018 已记录的风险。

## 7. 八维对标与方案评估

比较按 AIstudy 自己的产品原则，不按功能 checklist。每项标注 AIstudy 现状：已提交 / 草稿 / 规划。

### 7.1 产品哲学

| 产品 | 主张 |
|---|---|
| DeepStudent | local-first 学习工作台；统一 VFS；AI 直接读写全部材料 |
| AIstudy | cloud-first 终身学习 OS；三入口；服务端权威学习事实；AI 候选+审核 |

AIstudy 现状：**已提交**产品原则与资产模型；**未闭合** Learn 主链。两边都自称“学习 OS”，膨胀风险对称。AIstudy 的差异化不在功能数量，而在“学习事实能否被独立重放”。

### 7.2 数据权威 —— 最大对标缺口

| 产品 | 真源 |
|---|---|
| DeepStudent | 本地 SQLite + LanceDB + Blob；云同步实验性、备份式 |
| AIstudy 设计 | PostgreSQL 事件账本 + 可重算派生；共享内容与个人状态分离 |
| AIstudy HEAD | 设计上服务端权威；Learn 主读仍 Mock/localStorage |

AIstudy 现状：事件/判题/assessment replay **已提交**；UI 主读 **未闭合**；Goals/plan-state **草稿**。DeepStudent 的本地真源与 AIstudy 的服务端真源不可互相替代。抄 VFS 不会修复 Mock 双真源（AIST-002）。

### 7.3 学习闭环

| 产品 | 闭环形态 |
|---|---|
| DeepStudent | 资料 → 问答 → 导图 → 出题 → 闪卡 FSRS；工作流完整，偏工具整合 |
| AIstudy | 事件 → 评估切片(stable/usable/weak/untested) → 计划 → 干预；教育学更强，主链未接通真实数据 |

AIstudy 现状：domain scheduler/assessment/planner/intervention **已提交**；Today Plan / Practice / Review UI **仍 Mock**。DeepStudent 能让用户当天走完整条工具链；AIstudy 目前不能让用户看到由真实事件驱动的下一步。

### 7.4 笔记 / 知识库

| 产品 | 模型 | 完成度 |
|---|---|---|
| AIstudy | block + wiki link + typed relation + revision + exploration promotion | 数据模型更深；桌面完成度低；笔记本/Notion 导入仍是 preview |
| DeepStudent | Milkdown 富文本 + 导图 + 标签 + VFS 检索 | 桌面完成度更高，结构更浅 |

AIstudy 现状：Library 核心模型 **已提交**；笔记本工作台 **预览**；Notion 导入 **预览**。不要用导图替换 block/revision 模型。

### 7.5 练习 / SRS

| 产品 | 策略 |
|---|---|
| DeepStudent | APKG / FSRS / AnkiConnect，开箱闪卡；掌握度回流对 FSRS 做有界偏置 |
| AIstudy | 自研 SRS + 多能力切片 + 错因干预；FSRS 明确后置 |

AIstudy 现状：服务端判题、SRS 行锁、practice content **已提交**；练习 UI 未切服务端；FSRS **规划/暂缓**。对标结论：先让服务端题目和事件成为 UI 真源，而不是引入第二套调度器。

### 7.6 AI 治理 —— 必须保留的差异化

| 产品 | 权限 |
|---|---|
| DeepStudent | Ask / Plan / Craft，默认 Craft；AI 对数据读写权更大 |
| AIstudy | 手工 / 副驾驶 / 教练；正式内容必须审核；禁止 AI 代学 |

AIstudy 现状：政策 **已提交**；Explore promotion / revision proposal **已提交**；Learn 侧 AI 正式写路径仍受 Mock 与 Worker smoke 限制。不要把 Craft 默认写权限搬过来。DeepStudent 优化的是“一句话打通工具”；AIstudy 优化的是“AI 不能污染学习证据”。

### 7.7 分发与开源

| 产品 | 形态 |
|---|---|
| DeepStudent | 跨平台客户端 + AGPL-3.0 + 官网下载 v0.9.54 |
| AIstudy | Web 云端优先；自托管/离线/LICENSE 未落地 |

AIstudy 现状：Web app **已提交**；自托管完整 Compose **规划**；LICENSE/SECURITY **缺失**；离线客户端 **规划**。分发不是当前 P0。许可证对标尤其危险：AGPL 会反向约束云端服务形态，不能因为对标对象用了就跟随。

### 7.8 范围纪律

两边都有“学习 OS”膨胀风险。DeepStudent 用工作台把聊天、Office、调研、作文、MCP 收入同一壳；AIstudy 的问题总账已把 Marketplace、教师、离线、插件、深度模型标为 Accepted gap。

冷启动仍应是：**一个高数种子包 + 4–8 周成人试点**。若现在去对齐 DeepStudent 的功能面，会把 AIST-001/002 的数据可信度问题继续埋在演示数据下。

### 7.9 方案评估表

| 维度 | A 闭合服务端闭环 | B A 完成后再局部吸收 | C 复制工作台 |
|---|---|---|---|
| 目标效果 | 用户看到可复核的状态与下一步 | 在可信事实上补阅读/导入体验 | 当天可演示完整工具链，但放弃账本 |
| 数据需求 | 现有事件、内容包、目标 | 额外语料与导入夹具 | 本地 VFS/向量/多供应商配置 |
| 延迟/吞吐 | Web 请求 + 重放，可接受 | 视 OCR/PDF 而定 | 本地推理与索引，产品形态不同 |
| 成本 | 最低：完成已有 P0 | 中等 | 最高：新客户端与许可证 |
| 可解释性 | 评估切片 + evidence snapshot | 保持 | 掌握度/FSRS 对用户更黑盒 |
| 隐私与安全 | 服务端权威，需补删除/Provider 边界 | 需逐项威胁模型 | 本地优先有隐私优势，但 Craft 写权限更大 |
| 可迁移/可回滚 | 不改产品原则，可回退 Mock 演示 | 可单点回退 | 难以回退到云端账本 |
| 扩展性 | 先窄后宽 | 按试点证据扩展 | 功能面先行，内核后补 |
| 失败降级 | 规则队列；AI 失败不阻塞练习 | 同 A | 无服务端事实可降级 |

## 8. 推荐结论

- **推荐方案：** 方案 A。不要复制 DeepStudent 的桌面功能面，要闭合服务端权威学习闭环。
- **适用边界：** 当前分支、首个成人试点、P0 问题总账关闭之前。
- **暂不采用：** 桌面客户端、FSRS 替换自研 SRS、MCP/skills 市场、思维导图作为下一优先级、AGPL 许可证跟随、Craft 默认写权限。
- **升级触发条件：** Learn 主读不再使用 `createMockProvider()`；清空 localStorage 后状态/计划/复习仍在；handler + 至少一条练习 E2E 证明服务端判题与内容包一致；成人试点出现明确的资料阅读/Anki 互操作需求。
- **回退方案：** 保持 preview 与 Mock 演示隔离；正式路由失败时显式降级，而不是静默写回 localStorage 作为真源。

可执行建议（服务现有 P0，不是抄 DeepStudent）：

1. 把 Learn/Practice/Review/Today Plan 主读从 Mock 切到服务端内容包与事件。
2. 完成并验证 Goals/plan-state（当前 0016 草稿），再接 planner。
3. 修复 CI MinIO 镜像与本地 bash/Docker 阻塞，形成可复核门禁。
4. 补 LICENSE/SECURITY 等开源治理（AIST-013），不要先做 AGPL 对标。
5. 保持 AI 候选+审核；不要把 Craft 默认写权限搬过来。

## 9. 验证计划

- **数据集或测试夹具：** 现有 practice content（migration `0015`）、learning event 重放、handler attempts 测试；Goals 仅在 0016 提交后纳入。
- **当前基线：** UI 主读 Mock；`/api/attempts` 服务端判题；assessment replay 有 API 无 UI。
- **离线指标：** 清空 localStorage 前后 Today Plan / 状态 / due cards 一致；跨 Workspace 取题失败；额外 `correct` 字段被拒绝。
- **线上/产品指标：** 本阶段不设线上指标。试点阶段才统计 7 日未见变式题结果（AIST-017），先统计不调参。
- **用户验收场景：** 登录后不依赖演示种子即可练习、复习、看到由事件派生的状态词和下一步。
- **通过阈值：** `useStudyProvider()` 不再作为 Learn 主读；相关 handler/integration 在可运行环境通过。本轮未跑这些命令。
- **失败停止条件：** 若切换主读后无法从事件重放重建计划，停止扩大产品面，先修真源。

## 10. 风险与治理

- **来源可信度：** DeepStudent 材料来自公开 README/官网/release，非安装实测；AIstudy 能力以 HEAD 源码与已提交 migration 为准。
- **版权与许可证：** 不得把 AGPL-3.0 或 DeepStudent 文案/资源引入 AIstudy；对标只吸收问题定义，不吸收代码。
- **隐私：** DeepStudent 本地优先降低云端暴露，但默认 Craft 扩大本地写权限；AIstudy 云端优先必须补删除、未成年人、Provider 数据边界（AIST-012），不能用“以后做客户端”回避。
- **越权访问：** AIstudy 已有 Workspace 授权；Learn Mock 主读仍可能展示与授权数据不一致的演示内容。
- **提示注入与错误自动化：** 更大的 VFS/MCP 工具面增加注入面；AIstudy 应继续把正式卡片、题目、计划变更放在审核之后。
- **偏差与代学：** 若 AI 直接出题并自动判掌握度，会污染评估切片；保持“先尝试、最小提示、独立验证”。
- **删除与审计：** `0014` 表级 no-delete 已提交；账号级合规删除未做。DeepStudent 的本地删除模型不能直接当云端合规方案。
- **供应商锁定：** 双方都依赖外部模型供应商；AIstudy Worker 尚未成为真实 consumer，过早接入 12 家供应商只会放大 AIST-009。

## 11. 正式化路径

获批后需要更新（本记录默认 **不获批产品转向**；仅允许服务 P0 的工程闭合）：

- [ ] PRD/场景：不因本记录修改。除非试点证据表明首个价值楔子应从“目标学习闭环”改为“资料工作台”。
- [ ] UX 与 AI 权限政策：不引入 Craft 默认写。可在副驾驶矩阵中更明确“正式出题/制卡必须 promotion”。
- [ ] 设计或实施计划：只追加 Learn 主读切换与 Goals 真源任务，不新增桌面/FSRS/MCP 工作流。
- [ ] ADR：主读从 Mock 迁到服务端时再写数据提供者 ADR。
- [ ] Contract/Schema/API：Goals/plan-state 仅在 0016 提交后进入正式契约。
- [ ] 测试与验收场景：清空 localStorage、跨设备一致、拒绝客户端权威判题。
- [ ] 监控与回滚说明：CI MinIO 镜像修复；门禁失败不得用文档宣称通过。

## 12. 变更记录

| 日期 | 状态 | 变化 | 依据 |
|---|---|---|---|
| 2026-09-06 | exploring | 首次记录：对标 helixnow/deep-student v0.9.54，结论为闭合服务端权威学习闭环而非复制桌面工作台 | 公开 README/官网/release；AIstudy HEAD `bdf0162` 源码与 migration `0001`–`0015` |
