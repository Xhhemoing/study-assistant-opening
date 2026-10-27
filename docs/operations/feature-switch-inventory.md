# 配置控制项盘点与收敛

盘点基于 `5a1e7cfc`，线上只读快照为 2026-10-26 13:58 UTC；Web 与 Worker 均运行于 `189546c7` 命名的 release 目录。没有在本轮修改线上配置或重启服务。

整改前 registry 有 73 个 `OPENING_*` 环境项，其中 20 个是控制输入，53 个是模型、额度、连接、路径等普通参数。另有 2 个有效兼容别名，所以控制输入共 **22 个名称**。名单、JSON 灰度表、安全及测试控制均计入，没有通过改名或排除类型降低数量。

本次移除 3 个环境控制，保留 **19 个控制输入**；registry 环境项相应为 70 个。费用、密钥、上传额度和连接参数不属于试验开关，继续保留。

## 移除项与依据

| 控制输入 | 整改前默认与证据 | 当前处理 |
| --- | --- | --- |
| `OPENING_MATRIX_TRANSFORM_INTERACTIVE` | 默认 true 自 `9ecc3169`（2026-10-12 08:07:27 UTC）；线上匿名能力响应为 true，启动环境未覆盖 | 删除环境分支及无生产调用的旧 env helper；能力协议保持 true，静态回退、解析失败回退和减少动效保护保留 |
| `OPENING_TEACHING_LOOP_ROLLOUT_PERCENT` | 默认 100 同上，超过 14 天；Web/Worker 启动环境均为 100 | 移除百分比及用户分桶；保留登录要求和教学 API/UI 总开关，匿名用户仍不能启用教学循环 |
| `OPENING_PLAN_AGENT` | 默认 false；启动环境未覆盖，线上能力为 false；未发现 Web、Worker、AI 执行消费者 | 移除无效环境入口；保留既有能力协议字段为 false，不宣称已经实现模型重排 |

时间证据表示默认定义已稳定的时长；当前快照不证明过去每一时刻的线上值或教学收益。保留的 LOOP/WORKSPACE/COMPILER 默认开启仅始于 2026-10-21，尚不足两周；ANSWER_STYLE/CHAT_PROSE 始于 2026-10-13，也未达到本次时间条件。

## 保留的 19 个控制输入

`引用`为盘点时非测试 TS/JS 中直接 AST 名称位点数/文件数，排除 registry、模板和注释，不等于业务消费者数量。定义日期均为 2026 年，来自定义行的 Git 历史。启动环境的“未设”不等于实际关闭。

| 名称 | 默认 | 引用 | 定义日期 | 线上只读证据 |
| --- | --- | ---: | --- | --- |
| `OPENING_TEACHING_LOOP` | true | 8/4 | 10-21 | 两服务启动值 1；匿名 API 能力关闭是身份限制 |
| `OPENING_TEACHING_WORKSPACE` | 随 LOOP | 5/4 | 10-21 | 两服务启动值 1 |
| `OPENING_TEACHING_COMPILER_ENABLED` | true；主名优先于旧别名 | 1/1 | 10-21 | 两服务启动值 1 |
| `OPENING_TEACHING_VALIDATION_ENABLED` | false；兼容旧别名 | 1/1 | 10-12 | 两服务启动值 1，覆盖默认 |
| `OPENING_ANSWER_STYLE` | true | 1/1 | 10-13 | 两服务未设；未单独测有效值 |
| `OPENING_CHAT_ARTIFACTS` | false | 1/1 | 10-12 | 两服务未设；Web 匿名能力 false |
| `OPENING_CHAT_PROSE` | true | 1/1 | 10-13 | 两服务未设；Web 匿名能力 true |
| `OPENING_CHAT_SENSEWEAVE` | shadow | 1/1 | 10-25 | 两服务未设；匿名响应 off 受身份限制 |
| `OPENING_CHAT_SENSEWEAVE_BETA_USERS` | 空名单 | 1/1 | 10-25 | Web 启动环境未设；只核验 presence/count，不输出账号 |
| `OPENING_CHAT_SENSEWEAVE_GATES` | sw-gates-v0-20261024 | 1/1 | 10-25 | Web 未设；公开能力返回该默认版本 |
| `OPENING_ADAPTIVE_PLANNING` | false | 1/1 | 10-15 | 两服务未设；Web 匿名能力 false |
| `OPENING_SYSTEM_QUERY` | true | 1/1 | 10-21 | 两服务未设；匿名响应 false 受身份限制 |
| `OPENING_RELEASE` | production 时 true | 4/4 | 10-17 | 两服务启动值 0；公开注册能力 true |
| `OPENING_PROVIDER_ALLOW_LOCAL` | false；production 始终不允许 | 3/2 | 10-17 | 两服务未设；保留本地地址安全边界 |
| `OPENING_S3_FORCE_PATH_STYLE` | 继承 S3_FORCE_PATH_STYLE，均空则 true | 2/1 | 10-14 | 两服务未设；有效底层值未核验 |
| `OPENING_TEST_DB` | false；须显式 1 | 6/3 | 10-12 | 两服务未设；保留隔离测试保护 |
| `OPENING_E2E` | false；须显式 1 | 4/4 | 10-12 | 两服务未设；仍被测试构建使用 |
| `TEACHING_COMPILER_ENABLED` | 主名缺省时兼容读取 | 1/1 | 10-12 | 两服务未设 |
| `TEACHING_VALIDATION_ENABLED` | 主名缺省时兼容读取 | 1/1 | 10-12 | 两服务未设 |

Worker release 根目录 `.env.production` 中的控制项与上述六个显式启动值一致；Web 工作目录没有额外 `.env*` 文件。本次未读取或输出普通参数中的密钥，也没有把匿名能力当成所有登录用户的结果。

## 不纳入删除范围

53 个普通 registry 参数，以及 7 个未注册的测试/恢复参数，分别控制费用、模型、备份、上传、数据库及连接；不因名称含 `OPENING_` 而删除。`OPENING_MODEL_DAILY_QUOTA_MODE` 是明确的额度策略，也不借本次调整改变测试期不限额决定。

教学验证、聊天图示和自适应规划虽默认关闭，仍有实际 Worker/Web 消费者；SenseWeave 的 shadow、白名单和门控仍承担灰度任务。旧编译/验证别名继续兼容。历史验收记录保留当时事实，现行控制清单以本文与 registry 为准。

部署前按原发布流程同步环境模板。移除项不再控制行为；应用代码回退仍可读取旧控制名，既有生产配置和用户数据不在本次源代码清理中改写。
