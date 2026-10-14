# 学习闭环 L1：实际验收记录

日期：2026-10-14。基线：`8b500e6bd639488fddfc31d04713f8eecd6aec12`。
分支：`feat/learning-loop-hardening-20261014`。
已验证的产品代码提交：`67f4c31c397fb40a84df9d986512e51c307f87a0`。
实现、限制和后续 L2/L3/L4 标准见 `2026-10-14-learning-loop-hardening.md`。

## 已执行

GitHub Actions 隔离运行：`38499457389`，job `115642694292`，结论 success。
运行地址：https://github.com/Xhhemoing/study-assistant-opening/actions/runs/38499457389

| 检查 | 实际结果 |
|---|---|
| contracts/domain/database/ai/web/worker 类型检查 | 六包通过 |
| 客户端/服务端边界 | 133 个 client entry，0 violation |
| 定向单元测试 | 12 文件，113/113 通过 |
| SSH 部署安全测试 | 2/2 通过；模拟 SSH，不连接真实服务器 |
| 隔离 PostgreSQL 集成测试 | 15/15 通过 |
| 首次登录 handler 测试 | 4/4 通过 |
| 既有计划 handler 回归 | 11/11 通过 |
| 改动源码 ESLint、部署 shell 语法、git diff --check | 通过 |

总计 145 项定向测试通过；不是全仓所有测试，也不是浏览器或真实模型质量测试。数据库运行使用一次性 PostgreSQL 16 Alpine 和专用 aistudy_opening_test 数据库，验证了 additive 0061 迁移与相关事务。没有访问正式数据库、调用真实模型或部署应用。

该运行在补丁应用和上述检查全部成功后才提交产品代码。补丁 SHA256：`d47757c334174f4c369c76bdd04d4bc3bba13dcde9c6d0897a7a7404af3c1c59`。最终文档更新/临时文件清理不改变该次已验收的应用代码。一次性源码快照、补丁传输和验证工作流已从最终分支文件树移除；未改动既有 CI 或降低合并门禁。

## 可复现命令

```bash
npm ci --ignore-scripts --no-audit --no-fund
node scripts/check-learning-loop.mjs

# 仅对新建的隔离测试库执行；不要填写正式数据库地址。
OPENING_TEST_DB=1 \
OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
node scripts/check-learning-loop.mjs --database
```

## 待用户浏览器与真实模型验收

在测试环境应用 0061，并运行 web/worker；模型配置与额度仍由用户明确确认，不自动启用。

1. 运维创建新账户，保持正式版注册关闭。登录应进入三问首启；填写科目、日期和材料，保存后应有真实课程和起步任务。刷新不应重复创建。跳过时能进入资料库。
2. 不配置模型，检查材料/笔记入口仍可使用。“开始学习”应带真实任务主题；教学试跑关闭时不制造空教学活动。
3. 配置模型后，在保存型非练习聊天中使用规划入口。应展示真实任务和计划草稿；拒绝不改正式计划，确认只执行一次。过期、任务修改或隐私变化后的草稿不能强行接受。
4. 保存教练模式、分钟预算和保护时段，重新登录检查持久化；保护时段不应被规划占用。界面应明确自动重排尚未开放。
5. 单独开启教学试跑，使用真实课件生成首个小单元。核对意图、引用、公式/例题、练习提示、生成状态和模型账单。当前大纲提议不是完整课程编辑器；未提供独立答案不得声称已掌握。
6. 公共 health 只应返回轻量存活结果；运维深度检查走受控入口。SSH 认证或已核验主机指纹不匹配时必须立即失败，不自动改 sshd。

未合并、未部署、未同步用户电脑；本次仅修改功能分支和当前工作容器。自动重排/撤销、教学题目直接绑定独立作答证据、跨日复测闭环、多课程智能规划和便携备份协议升级仍属于后续切片。
