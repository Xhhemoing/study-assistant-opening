# AIstudy 文档导航

> **从这里进入：**
> - 理念与原则唯一真源：[AI + 学习论（最终版）](product/LEARNING_THEORY.md)
> - 项目现状与易懂版计划：[项目现状与开发计划（易懂版）](roadmap/OVERVIEW.md)
> - 工程开发计划：[架构开发计划](roadmap/ARCHITECTURE_PLAN.md) · [算法开发计划](roadmap/ALGORITHM_PLAN.md)
> - 实时交付与待审批事项：[STATUS.md](STATUS.md)（唯一集成者维护）

## 目录总览

| 目录 / 文档 | 职责 |
|---|---|
| [product/LEARNING_THEORY.md](product/LEARNING_THEORY.md) | AI + 学习论（产品理念、学习原则、三入口平等、自由度契约、帮助与证据、AI 边界的唯一真源） |
| [product/PRD.md](product/PRD.md) | 产品需求 v1.0；配套 [场景预设](product/SCENARIOS.md)、[界面与 AI 规则](product/UX_AND_AI_POLICY.md)、[考前冲刺](product/exam-sprint.md) |
| [roadmap/OVERVIEW.md](roadmap/OVERVIEW.md) | 给项目所有者的易懂版：项目现状、在研板块盘点、R0–R4 路线图与待办事项 |
| [roadmap/ARCHITECTURE_PLAN.md](roadmap/ARCHITECTURE_PLAN.md) | 架构开发计划（工程版）：分段部署、三入口恢复、接线清单、双区域、i18n、PWA、未成年人、合规工程 |
| [roadmap/ALGORITHM_PLAN.md](roadmap/ALGORITHM_PLAN.md) | 算法开发计划（工程版）：26 项算法清单、权威路径注册表、统一证据投影、R0–R3 校准与晋升门 |
| [decisions/DECISIONS.md](decisions/DECISIONS.md) | 决策登记表（D1–D15、R1–R8、里程碑对照）与逐字保留的测量口径；另含各项 `ADR-*.md` |
| [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md) | 当前系统架构现状；配套 [数据模型与预测](architecture/DATA_MODEL_AND_PREDICTION.md)、[系统查询协议](architecture/STUDY_SYSTEM_QUERY.md) |
| [operations/agent-workflow.md](operations/agent-workflow.md) | 并行开发与集成门禁、CI（[ci.md](operations/ci.md)）、数据库迁移（[database-migrations.md](operations/database-migrations.md)）、功能开关（[feature-switch-inventory.md](operations/feature-switch-inventory.md)）、模型路由（[opening-model-routing.md](operations/opening-model-routing.md)）、发布与连接器手册 |
| [STATUS.md](STATUS.md) | 实时主干、线上版本、U 级待批事项、浏览器验收清单与使用反馈（[历史快照](status-archive/2026-11-03-full-status.md)） |
| [brainstorm/INDEX.md](brainstorm/INDEX.md) | 现役专题契约（[知识资产图 API](brainstorm/2026-11-18-knowledge-assets-api.md) 与测试样例 JSON）与新研究模板 |
| [design/DAILY-USE-UX-RESEARCH.md](design/DAILY-USE-UX-RESEARCH.md) | 日常使用体验研究、样板规范与 UI/UX 证据参考 |

## 路径保持稳定的历史目录（供 CI 与脚本读取）

以下目录包含被 `scripts/ci/checks.py`、`scripts/validate-opening-plan.mjs`、契约测试或历史证据引用的文件，路径保持稳定，**不代表当前产品方向**：

- `docs/superpowers/` — 早期自动化校验任务图与规格
- `docs/quality/` — 历史审计与评测参考
- `docs/archive/` — 历史证据归档（见 [archive/README.md](archive/README.md)）

> 2026-11-28 文档清理中移除的70 份已过时/已吸收历史计划、研究笔记与旧修复记录均完整保存在 Git 历史中，核心有效内容已并入 `LEARNING_THEORY.md`、`DECISIONS.md`、`roadmap/` 与 `operations/`。
