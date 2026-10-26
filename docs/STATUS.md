# 项目状态

更新：2026-10-26。只记录当前事实；历史细节见各 PR 和 Git 历史。

| 项目 | 当前状态 |
| --- | --- |
| 开发主干 | `feat/opening-release` @ `4e37a1c5`；[该提交 push CI 通过](https://github.com/Xhhemoing/study-assistant-opening/actions/runs/40275247893) |
| 线上进程 | 2026-10-26 本轮只读 health 为 ok；仍未返回 commit / builtAt，实际运行提交未核实，不等于发布验收 |
| 最新候选 | [WP1.3 旧分支单元导航修复](https://github.com/Xhhemoing/study-assistant-opening/tree/fix/wp1.3-mainline-return)（本文件所属提交），基于 [设置锚点 f9c72c7d](https://github.com/Xhhemoing/study-assistant-opening/tree/f9c72c7dd376e724f2a17aea098e10de0a0e14fc)，包含此前 WP1.1 / WP1.5；尚未合并/部署 |
| 候选检查 | 当前整合候选相关回归 37 项、Web 类型、改动 lint、边界/契约/文案检查通过，独立只读复审无阻断；未跑本轮完整构建或真实数据库。设置回归 13 项见 f9c72c7d，此前构建见 d32b6419，旧 HTTP 证据仅适用于 c91c865c |
| 当前工作 | 旧分支导航先逐层确认回主线，再保存新单元；部分成功后失败保留已确认位置，失败不伪选中新目标。设置书签修复已整合 |

## 本轮开放 PR

| PR | 一句话说明 | 当前验证 |
| --- | --- | --- |
| [#132](https://github.com/Xhhemoing/study-assistant-opening/pull/132) | 助理工作区聚焦与原题续接 | draft/open；`5b42fb03` [CI 通过](https://github.com/Xhhemoing/study-assistant-opening/actions/runs/40317094216)，浏览器待用户 |
| [#133](https://github.com/Xhhemoing/study-assistant-opening/pull/133) | 学习者文案与折叠诊断设置 | draft/open；`e8317cab` [CI 通过](https://github.com/Xhhemoing/study-assistant-opening/actions/runs/40317099243)，浏览器待用户 |

## 阻塞与下一步

- 始终最多 2 个开放功能 PR；#119 已由主干覆盖而关闭，已合并的 `release/opening-final-20261025` 已删除，其提交仍在主干。下列 9 项仅延期，保留分支及原 PR，不算完成。
- WP2.4 必须等待 WP0.2、WP0.5、WP1.2、WP1.3 合入；合并前仍需最新主干与 WP0.8 验证。
- [浏览器/视觉/E2E 由用户验收](quality/2026-10-06-opening-browser-acceptance-checklist.md)；真实模型一周 TTFT、SenseWeave 采样和学习效果尚未通过，不从单元/HTTP 测试推导。HTTP 仅用隔离配置，未验证完整依赖栈或正式发布版本。
- 测试期每日不限额已实现；运行环境启用及真实模型调用待验证，尚未修改线上配置。
- 模型配置互斥限当前页面实例；普通保存结果未知时需确认服务器请求已结束后重新打开，不能从一次 GET 推断保存完成。跨标签页写入仍遵循现有服务器行为。
- WP1.2/1.3 仍待：选中文字保存，以及仍可进入的 span/matrix 课程控件统一；不把主生成讲义的实现推导成所有课程已完成。
- [旧 API 观察](operations/legacy-api-observation.md)已实现但未部署，连续 30 天日志窗口尚未开始，不删除接口。
- [开关盘点](operations/feature-switch-inventory.md)控制输入 22→19；仅源代码变更，未修改线上配置。

<details>
<summary>延期 PR 与恢复入口（9 项，均关闭但未合并）</summary>

重开原 PR 前，重新核对最新主干、依赖、差异和 CI。提交链接固定归档位置，分支保留；未知项不视为已覆盖。

| 原 PR | 保留分支 / 提交 | 未决项 |
| --- | --- | --- |
| [#123](https://github.com/Xhhemoing/study-assistant-opening/pull/123) | [docs/study-status-20261025 @ 395684d4](https://github.com/Xhhemoing/study-assistant-opening/tree/395684d4dd508a7603bdb1f53623de0644345265) | 状态查询脚本与工具测试未合入；本次仅收敛看板 |
| [#122](https://github.com/Xhhemoing/study-assistant-opening/pull/122) | [feat/sprint-c-explore-preview-20261024 @ 9e233e01](https://github.com/Xhhemoing/study-assistant-opening/tree/9e233e01fda4908a35aff49f53609709b31347cd) | Explore 预览未合入，依赖 #116，仍按默认关闭保留 |
| [#121](https://github.com/Xhhemoing/study-assistant-opening/pull/121) | [perf/typecheck-projects-20261024 @ 934d0b28](https://github.com/Xhhemoing/study-assistant-opening/tree/934d0b2804f4d64a6fa48e5bef8c4e24a59b1a1d) | 测试分层类型检查及缓存回归未合入 |
| [#120](https://github.com/Xhhemoing/study-assistant-opening/pull/120) | [perf/sprint-a2-parser-ranges-20261024 @ e1af5db3](https://github.com/Xhhemoing/study-assistant-opening/tree/e1af5db39087abe6e270aee01df5009ee7c0d36d) | A1 就绪已覆盖；A2 多范围解析与流式回归未合入 |
| [#116](https://github.com/Xhhemoing/study-assistant-opening/pull/116) | [feat/sprint-b-answer-isolation-20261024 @ f2043303](https://github.com/Xhhemoing/study-assistant-opening/tree/f2043303bf25dcbc275eb555511e4beddf7fa4af) | 0097 迁移已有；答案隔离契约、仓库、API 及测试仍未合入 |
| [#103](https://github.com/Xhhemoing/study-assistant-opening/pull/103) | [codex/study-runtime-recovery-20261021 @ 64e9f4c3](https://github.com/Xhhemoing/study-assistant-opening/tree/64e9f4c39bb15fa2934f4d57dfb199682fb04eae) | 候选已有 host 保留；进程崩溃恢复验收及 CI 未合入 |
| [#78](https://github.com/Xhhemoing/study-assistant-opening/pull/78) | [codex/sprint-lesson-r2-20261020 @ cd078431](https://github.com/Xhhemoing/study-assistant-opening/tree/cd078431ce3ac5b2eeddc27e99a37e81d5996aba) | PR 仅恢复文档；39 文件源码及部分答案曝光修复状态未知 |
| [#63](https://github.com/Xhhemoing/study-assistant-opening/pull/63) | [codex/project-architecture-recovery @ f86e8c5a](https://github.com/Xhhemoing/study-assistant-opening/tree/f86e8c5a7640b07bb56be66e1a557e8b50e36c45) | 学习测试请求恢复实现与回归未合入 |
| [#51](https://github.com/Xhhemoing/study-assistant-opening/pull/51) | [codex/senseweave-0.5.0-rc1-pilot @ 7f9b7ae6](https://github.com/Xhhemoing/study-assistant-opening/tree/7f9b7ae669a649d1046760136fe8952799a647a3) | 旧 SenseWeave pilot 未合入；与 SW0 不同，保留待退役判断 |

</details>

[收敛前的完整状态记录](https://github.com/Xhhemoing/study-assistant-opening/blob/fd157787ab74a307fa41a34b61359920ed98eab1/docs/STATUS.md)保留在 Git 历史，不能当作当前调度清单。
