# 项目状态

更新：2026-10-26。只记录当前事实；历史细节见各 PR 和 Git 历史。

| 项目 | 当前状态 |
| --- | --- |
| 开发主干 | `feat/opening-release` @ `4e37a1c5`；[该提交 push CI 通过](https://github.com/Xhhemoing/study-assistant-opening/actions/runs/40275247893) |
| 线上进程 | 2026-10-26 只读核实 Web / Worker 均运行 `189546c7`；health 为 ok 但未返回 commit / builtAt。默认模型已有配置，无限日额度尚未启用 |
| 最新候选 | [整合草稿 PR #134](https://github.com/Xhhemoing/study-assistant-opening/pull/134)，代码候选 `69ed75a8`；覆盖 WP0.3–WP2.3/2.5 及后续交互修复，尚未合并/部署 |
| 候选检查 | `7c38102b` 的 [集中 CI](https://github.com/Xhhemoing/study-assistant-opening/actions/runs/40360315734) 失败于固定颜色规则及 Worker 流程旧工具状态假设；本批已修复，待 #134 当前 head 重新验证。`69ed75a8` 的 41 项局部回归不替代完整 CI |
| 当前工作 | 编辑器/搜索统一现有主题变量；Worker E2E 仅在辅助区关闭时展开，并断言可见。依据 CI trace 修复，保留原流程断言与超时；并发工作流/图谱脚本修改未纳入本次提交 |

## 本轮开放 PR

| PR | 一句话说明 | 当前验证 |
| --- | --- | --- |
| [#134](https://github.com/Xhhemoing/study-assistant-opening/pull/134) | 学习、助理、设置、默认 AI 与遗留入口整改整合 | draft/open；当前 head 的 CI 与用户浏览器验收待完成 |

## 阻塞与下一步

- 始终最多 2 个开放功能 PR，当前仅 #134；被替代的 [#132](https://github.com/Xhhemoing/study-assistant-opening/pull/132)（`5b42fb03`）和 [#133](https://github.com/Xhhemoing/study-assistant-opening/pull/133)（`e8317cab`）可从原 PR/分支恢复。下列 9 项仅延期，不算完成。
- WP2.4 必须等待 WP0.2、WP0.5、WP1.2、WP1.3 合入；合并前仍需最新主干与 WP0.8 验证。
- [浏览器/视觉/E2E 由用户验收](quality/2026-10-06-opening-browser-acceptance-checklist.md)；真实模型一周 TTFT、SenseWeave 采样和学习效果尚未通过，不从单元/HTTP 测试推导。HTTP 仅用隔离配置，未验证完整依赖栈或正式发布版本。
- 测试期每日不限额已实现；服务器默认模型与密钥存在性已只读核实，部署后启用无限模式及真实调用仍待完成，尚未修改线上配置。
- 模型配置互斥限当前页面实例；普通保存结果未知时需确认服务器请求已结束后重新打开，不能从一次 GET 推断保存完成。跨标签页写入仍遵循现有服务器行为。
- 按用户最新要求跳过后续小阶段测试，连续开发后集中验证与 review；既有测试及 CI 不禁用。本批 41 项测试在该指令到达前已结束。
- [旧 API 观察](operations/legacy-api-observation.md)已实现但未部署，连续 30 天日志窗口尚未开始，不删除接口。
- [开关盘点](operations/feature-switch-inventory.md)控制输入 22→19；仅源代码变更，未修改线上配置。
- CI artifact 另有 PDF 预览失败字样，原件下载为 200，底层原因尚未核实；不是此次隐藏 OCR 标签超时的原因，不据此宣称 PDF 预览正常。

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
