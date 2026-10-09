# UI 闭环收敛 R2 — Understand 清单 only（待 Integrator 审）

**Date:** 2026-10-10 ~07:53 CST  
**Branch tip (box):** `dcac730`  
**Owner:** Experience  
**Status:** LIST_ONLY — **禁止 IMPLEMENT**，待 Integrator 审 → PM 授权后再动手  
**硬约束：**不得误伤 **Today / 计划 / Tutor / 练习 / 复测 / 卡片 / 连接材料**；后端不删；不碰 Q03/Docker；不自推；不标 verified；无 hermes 除非 Paula 要

## 标记说明

| 标记 | 含义 |
|---|---|
| **保留** | 默认可见；属闭环主干或明确支撑 |
| **可收敛** | 建议藏高级 / 删导航入口 / 弱化展示；风险低，不挡闭环 |
| **需 Paula 确认** | 可能影响习惯路径、材料进闭环或 AI 可用性；未确认前不改 |

## A. 硬保留（不得裁）

| 表面 | 项 | 现状路径 | 标记 | 风险若误裁 |
|---|---|---|---|---|
| 侧栏 | 今日 | `/opening/today` | **保留** | 丢主入口 |
| 侧栏 | 助理（Tutor） | `/opening/assistant` | **保留** | 丢辅导 |
| 侧栏 | 课程 | `/opening/courses` | **保留** | 丢长期上下文与材料入口 |
| 侧栏 | 卡片 | `/opening/cards` | **保留** | 丢复习证据 |
| 侧栏 | 待确认 | `/opening/review` | **保留** | 丢建议确认 |
| 侧栏 | 连接 | `/opening/settings/connections` | **保留** | 材料进不来 |
| Today | 任务队列 / 计划草案 / 优先行动 digest | Today 页内 | **保留** | 断「Today→计划」 |
| Today | 待确认 / 到期卡片横幅 | → review / cards | **保留** | 丢提醒 |
| Today | 快捷：卡片 / 待确认 / 连接 / #action-digest / 课程知识·材料 | 同上 | **保留** | 断闭环跳转 |
| EntryLinks | 今日·卡片·待确认·课程·连接 | design/ui | **保留** | 同上 |
| 课程页 | knowledge / media / practice / retest | 课程内 | **保留** | 断练习·复测·材料 |
| Tutor | AiReadiness **硬**项（额度等） | assistant | **保留** | AI 不可用却无指引 |
| 设置主 | 「开启 AI 每日额度」→ advanced `#daily-budget` | 短链 | **保留** | Paula 开不了 AI（已知痛点） |
| 设置主 | 学习偏好（闭环相关） | `#preferences` | **保留** | 偏好丢失入口 |
| 命令面板 | today / assistant / courses / cards / review / connections / settings / settings-advanced | palette | **保留** | 键盘路径断 |
| Topbar | 卡片·待确认图标；设置；专注模式/计时 | shell | **保留** | 次要但仍属学习辅助 |

## B. 可收敛（建议裁，风险低）

| 表面 | 项 | 建议 | 标记 | 风险 |
|---|---|---|---|---|
| 命令面板 | `目标学习` → `/learn` | 删入口（middleware 已可重定向 opening） | **可收敛** | 低：legacy 双入口；计划已在 Today |
| 命令面板 | `学习目标` → `/learn/goals` | 删入口 | **可收敛** | 低：非 opening 闭环默认路径 |
| 命令面板 | `复习卡片` → `/learn/review` | 删入口（保留 `/opening/cards`） | **可收敛** | 低：易与 opening 卡片混淆 |
| 命令面板 | `知识库` → `/library` | 删入口 | **可收敛** | 低：材料应走课程/连接 |
| 命令面板 | `新建笔记` → `/library/new` | 删入口 | **可收敛** | 低：旁路产品感 |
| 命令面板 | `导出与备份` | 删面板项；仅高级页链 | **可收敛** | 低 |
| Topbar | 「写笔记」→ `/library/new` | 删入口 | **可收敛** | 低 |
| Today | 「写笔记」 | 删入口 | **可收敛** | 低 |
| 高级 | Diagnostics 面板 | 二级「开发者」折叠 | **可收敛** | 极低 |
| 高级 | 演示数据重置 | 二级「危险操作」或删入口 | **可收敛** | 低；误触会搅数据（入口本身应藏） |
| `@aistudy/ui` WorkspaceNavigation Explore | Opening 壳不暴露；清理残留文案/类型 | **可收敛** | 极低：Opening 已自定义 nav |
| 路由 | `/explore` `/learn/*` marketplace exams | **不删后端**；确保无默认 UI 链；middleware 续重定向 | **可收敛** | 低：只去入口 |

## C. 需 Paula 确认（未批不改）

| 表面 | 项 | 争议点 | 标记 | 风险 |
|---|---|---|---|---|
| 设置主 | 钉钉连接 **整块嵌入**（主设置 vs 仅连接页） | 主设置减噪：只留「打开连接设置」；完整面板只在 connections | **需 Paula 确认** | 中：若习惯在 `/settings` 管钉钉，会多点一次；**连接能力本身保留** |
| 设置主 | 开学排程（学期设置 + 课表导入）体量大 | 默认折叠「展开排程」仍在主设置；或迁 advanced | **需 Paula 确认** | 中：排程支撑「按建议安排」；藏太深可能影响计划质量 |
| 高级 | 默认入口（含自由探索备选） | 删 UI / 更深折叠 / 去掉 explore 选项 | **需 Paula 确认** | 中：若有人依赖 explore 作首页会困惑；默认应永不推 explore |
| 高级 | 指导模式 / 计划自主权（含探索时段） | 留 advanced 顶层 vs 二级折叠 | **需 Paula 确认** | 低～中：探索相关；改折叠不影响闭环主路径 |
| 助理 | Vision soft tip（照片材料提示） | 默认助理页不常显；仅材料/视觉相关上下文或 advanced | **需 Paula 确认** | 低～中：弱化后首次用照片可能少提示；**不得升回硬阻断** |
| 命令面板 | 全局搜索 `/search` | 保留 vs 可收敛 | **需 Paula 确认** | 低：找闭环内容有用；非旁路产品 |
| 设置高级 | 自定义供应商 / 模型细节 | 已在 advanced；是否再折叠 | **需 Paula 确认** | 低：额度确认块必须保持可发现 |

## D. 明确不做（本轮）

- IMPLEMENT / commit / push / hermes / 标 verified  
- 删除 API、表、任务、练习/复测后端  
- 动 Q03、Docker  
- 从侧栏或 Today 去掉连接 / 卡片 / 课程 / 助理  

## E. 审完后的期望流程

1. Integrator 标同意/改标记  
2. 需 Paula 的项由 PM/Paula 拍板  
3. **PM 授权 IMPLEMENT** 后再改代码；Experience 交 Accept，不自推  

## 对照文件（现状）

- `apps/web/src/features/opening/shell/navigation.ts`  
- `apps/web/src/features/search/command-palette-model.ts`  
- `apps/web/src/features/opening/shell/opening-shell.tsx`（写笔记）  
- `apps/web/src/features/opening/planning/today-overview.tsx`  
- `apps/web/src/features/settings/settings-view.tsx` / `advanced-settings-view.tsx`  
- `apps/web/src/features/opening/assistant/ai-readiness.tsx`（vision soft）  
