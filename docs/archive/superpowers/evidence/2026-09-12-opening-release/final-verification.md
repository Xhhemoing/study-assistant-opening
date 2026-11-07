# 最终计划/基线验证记录

本记录只覆盖本轮计划资产与基线修复，不覆盖未来五项产品功能。

## 实际检查

| 检查 | 命令/输出 | 状态 |
|---|---|---|
| 安装源回归 + 计划校验器单测 | `node --test tests/tooling/install-registry.test.mjs tests/tooling/opening-plan.test.mjs`；`tests 6 / pass 6 / fail 0` | 通过 |
| 任务图/文档引用 | `node scripts/validate-opening-plan.mjs`；`Plan structure: PASS (27 tasks, acyclic dependencies, plan/evidence files present)`；ready F01,F02 | 通过，仅结构检查 |
| 全量unit+contract | `bash scripts/run-heavy.sh node node_modules/vitest/vitest.mjs run --project unit --project contract`；`Test Files 114 passed (114)`，`Tests 515 passed (515)`，`Duration 81.55s` | 通过 |
| lint | `npm run lint`，退出0 | 通过 |
| 类型 | 显式Git Bash script-shell的`npm run typecheck`，退出0 | 通过 |
| 生产构建 | 显式Git Bash script-shell的`npm run build`；`Compiled successfully in 15.8s`，`Generating static pages (42/42)`，退出0 | 通过 |
| 补丁空白错误 | `git diff --check`无输出，退出0 | 通过 |
| 原工作区保护 | 原AIstudy status与建立隔离目录前一致 | 已检查 |
| graphify刷新 | `graphify update .`在90秒限时内未返回成功；日志显示950个文件AST扫描到100%，并提示SQL解析依赖缺失、6个配置文件未产出节点 | 未完成，不作为功能验证依据 |

## 不能据此宣称的事情

- 新上传、真实AI、记忆、协商计划等尚未实现，不能宣称产品已可用。
- 数据库/存储/Redis集成、手机真机、真实模型效果、推送、备份恢复尚未执行。
- 515个Vitest用例是现有代码及本轮边界回归，不是27个任务全部完成。
- 计划校验器不会判断教育有效性，也不会证明测试本身充分。
- 未调用项目的收费模型API；开发会话自身成本未在此统计。
- 安装和检查曾失败，根因、最小修复和复测见baseline.md；不抹去失败历史。

## 当前推进点

已验证并本地提交基线任务B00（fab0ee4）、B01（79dd89b）、B02（669708e）。下一可执行任务F01、F02；普通实施已获授权。涉及真实测试服务的任务需先通过测试库保护，缺少外部环境时只将相应验收记blocked，继续独立的契约、纯规则和离线适配测试。
