# 项目状态

更新：2026-10-26。只记录当前事实；历史细节见各 PR 和 Git 历史。

| 项目 | 当前状态 |
| --- | --- |
| 开发主干 | `feat/opening-release` @ `4bd1e8b7`，PR #134 已合入；[该提交 push CI](https://github.com/Xhhemoing/study-assistant-opening/actions/runs/40433699299) 运行中 |
| 线上进程 | 2026-10-26 只读核实 Web / Worker 均运行 `189546c7`；health 为 ok 但未返回 commit / builtAt。默认模型已有配置，无限日额度尚未启用 |
| 最新候选 | [整合 PR #134](https://github.com/Xhhemoing/study-assistant-opening/pull/134) 已合入 `4bd1e8b7`；尚未部署 |
| 候选检查 | `5aa2572b` [完整 CI 通过](https://github.com/Xhhemoing/study-assistant-opening/actions/runs/40384100343)：综合检查（浏览器 95 通过/3 跳过、构建通过）及 Worker/PDF 成功；用户新账户五步与真实模型验收仍待完成 |
| 当前工作 | 合并提交 push CI 运行中；正式发布前仍须核对备份恢复、对象存储及配置备份，WP0.8 用户浏览器验收和真实模型验收未完成。WP2.4 和 P3 的其他前置仍待核对，整体计划未完成 |

## 开发效率优化（2026-10-26）

- 已同步当前工作区的连续开发、集中评审、有效检查复用及按需图谱规则；历史逐片 ACCEPT 规则只解释旧任务。普通开发不等待图谱刷新，陈旧图仅导航；安全、发布与现有 CI 保留。根目录入口已指向本看板。
- 已实测结构刷新实验：总450.17秒，其中 AST/跨文件处理422.01秒、清理导出26.93秒；与历史完整刷新446–496秒相比无明确提速，未采纳新增脚本。实验与原始图备份仅留私有位置；原图已恢复并标待更新，SQL解析依赖仍缺失。
- 实验5项小图回归通过、独立只读核验无阻断；最终交付为规则/入口调整，文档一致性、链接、UTF-8及差异检查按本轮核对。不据此宣称产品、浏览器或持续开发吞吐已验收；未改 CI、依赖或线上，无本轮提交/推送。
## 三任务并行开发（2026-10-26）

- 按用户要求，项目允许最多 3 个并行子 Agent，可同时承担 3 个独立实现任务；调查、实现和评审共用名额，主线程负责依赖、共享协议、集成和最终交付。任务不足或存在语义依赖时按实际并行度安排。
- 本轮同步项目指令和协作流程，并固定项目 Codex 并发与子 Agent 默认模型。保留最多 3 个活跃 worktree、单文件单写者、共享数据库与重检查串行、复杂结果独立评审及用户浏览器验收。
- 项目配置 TOML 解析、CLI 配置加载检查、指令/流程副本一致性及 diff 空白检查通过；定向独立文本核验无阻断。CLI 未展示字段来源及合并后值，未验证本会话热加载；三任务开发的端到端提速和产品质量尚未实测。本轮不涉及产品源码、依赖、CI 或线上配置，不提交或推送。
## 本轮整合 PR

| PR | 一句话说明 | 当前验证 |
| --- | --- | --- |
| [#134](https://github.com/Xhhemoing/study-assistant-opening/pull/134) | 学习、助理、设置、默认 AI 与遗留入口整改整合 | 已合入 `4bd1e8b7`；合并提交 push CI 运行中，待用户浏览器验收与部署 |

## 阻塞与下一步

- 始终最多 2 个开放功能 PR，当前无开放功能 PR；被替代的 [#132](https://github.com/Xhhemoing/study-assistant-opening/pull/132)（`5b42fb03`）和 [#133](https://github.com/Xhhemoing/study-assistant-opening/pull/133)（`e8317cab`）可从原 PR/分支恢复。下列 9 项仅延期，不算完成。
- WP2.4 必须等待 WP0.2、WP0.5、WP1.2、WP1.3 合入；相关整改已合入，仍需核对最新主干与 WP0.8 验证。
- [浏览器/视觉/E2E 由用户验收](quality/2026-10-06-opening-browser-acceptance-checklist.md)；真实模型一周 TTFT、SenseWeave 采样和学习效果尚未通过，不从单元/HTTP 测试推导。HTTP 仅用隔离配置，未验证完整依赖栈或正式发布版本。
- 测试期每日不限额已实现；服务器默认模型与密钥存在性已只读核实，部署后启用无限模式及真实调用仍待完成，尚未修改线上配置。
- 模型配置互斥限当前页面实例；普通保存结果未知时需确认服务器请求已结束后重新打开，不能从一次 GET 推断保存完成。跨标签页写入仍遵循现有服务器行为。
- 按用户最新要求跳过后续小阶段测试，连续开发后集中验证与 review；既有测试及 CI 不禁用。本批 41 项测试在该指令到达前已结束。
- [旧 API 观察](operations/legacy-api-observation.md)已实现但未部署，连续 30 天日志窗口尚未开始，不删除接口。
- [开关盘点](operations/feature-switch-inventory.md)控制输入 22→19；仅源代码变更，未修改线上配置。
- 原 CI 的 PDF 预览失败是否源于该竞态尚未证实；当前只确认并修复独立的 worker 复用生命周期缺陷，真实显示结果待整合验证。

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
