# SenseWeave 安全测试版：开发与测试入口

本轮把 v2 计划的安全内核接到当前本地开发树，不以线上版本作为开发起点。不改批改、资料权限、数据库或 Worker；现有 A1 开发成果保留。

## 已接线

- 受控 vendor：已更新为上游安全版 `5953f0731cf39558df634385b6b800e1bf818b17`，58文件来源/本地双向校验通过。后续仍须先提交上游，再运行上游 `scripts/vendor.mjs packages/senseweave/vendor`；本库 `node scripts/check-senseweave-vendor.mjs` 在 CI 核对所有文件与 clean commit。
- SW1：回答完成后一次决策；纯元数据影子缓冲留在当前标签页，最多500条。同页稳定消息身份用于有界内存去重，不进入日志或导出；超过去重窗口的重访不构成全局去重保证。诊断模式可显式导出 JSON。无原文、问题、身份、消息ID、偏移、自由文本诊断、时间戳或网络发送。窗口/账号切换会清空，不是服务端集中遥测。
- SW2：`OPENING_CHAT_SENSEWEAVE` 默认 shadow；即使设 on，也只对 `OPENING_CHAT_SENSEWEAVE_BETA_USERS` 中的账号渲染，其余仍 shadow；匿名 off；关闭 prose 时 off。白名单不下发浏览器。
- 门控：`packages/config/src/public/senseweave-gates.v0.json` 是版本化初始表，通过 capabilities 下发并与 runtime 教学能力取交集；`OPENING_CHAT_SENSEWEAVE_GATES` 可覆盖，hint 绝不扩展到答案型组件。compare/derive 沿既有预设并额外受 explain 格子约束。
- 提示模式：保存 turn.mode、临时请求 mode 传到渲染，优先于问题关键词；旧学习历史缺 mode 时保守 hint，不把“没有提示关键词”当已允许完整增强。
- 明确反馈：改回文字仍可用，并记录本页展示/回退计数。localStorage v2 按经验证的账号+workspace+预设分区；不继承无归属旧v1键，迟到回调不能写到新账号。SSR不缓存其他用户答案。
- 完成后淡入、单块懒加载、错误回退原文；无流式提前增强、无额外模型调用。

## 内测准备与用户浏览器验收

先让目标提交通过非浏览器检查与CI，再由用户决定测试部署。**未修改线上环境或放开全员渲染。**

测试环境设置（真实ID只放私有环境配置，不进仓库）：

```dotenv
OPENING_CHAT_PROSE=1
OPENING_CHAT_SENSEWEAVE=shadow
# 启用渲染时设置 on，并列出内测账号：
# OPENING_CHAT_SENSEWEAVE_BETA_USERS=<internal-account-id>
```

入口 `/opening/assistant`：
1. shadow/off 对同一已完成回答应看到相同正文；打开诊断只多一行元数据和“导出本页匿名统计”。
2. 用白名单账号、on，提问后等待回答完整；TD/TB矩形普通箭头可增强，LR/圆/菱形/虚线保持原文。代码、HTML注释、引用内表格不得增强。
3. 点击“改回文字”，原片段与引用/选区偏移应保留；无额外模型请求或业务写入。
4. 练习的 hint 模式即使问题含“比较/数据”，也不得展示图表/完整步骤；同时注意**原始模型回答本身的泄题无法由组件白名单证明安全**。
5. 切换其他账号/workspace，偏好与本页日志不串用。非白名单账号的 capabilities 必须仍 shadow。
6. 导出 JSON，人工确认无题干/回答/姓名/账号/消息ID；缓冲最多500条，刷新后清空。

浏览器验收尚待用户，不以HTTP200或Node静态渲染代替。

## 真实数据与发布门禁

上游 `scripts/safety-corpus.mjs` 的五预设×150只是合成工程反例/正例，不是真实模型采样。不据此宣称“零泄题”或“风险≤2%”。

真实安全采样仍需：选定模型与预算 → 使用本项目真实 `openingProviderRequestBody` / tutor 提示模板 → 60题呈现集、各预设多次采样且每预设至少150回答 → 自动原文/数据检查 → 人工呈现保真和hint泄题核对。任何一例失败均阻断该格子并记录issue。**本轮不擅自触发未定预算的批量模型调用。**

离线盲评工具位于上游 `eval/`。目前导出器只评估真实 table 的静态语义HTML，不把它当AIstudy交互式图表/流程图评测；无真实评审标签。20/40/60产品判定线预先冻结；学习权重/P5/P6继续冻结。

目前只有显式“改回文字”方向指标；“没看懂”追问率/去做下一题比例还未形成可靠跨页面归因，不能上报不存在的数据。SW5为本浏览器持久化，不是跨设备服务端同步。

## 回滚

设置 `OPENING_CHAT_SENSEWEAVE=off`；或从门控JSON移除指定组件并变更gateVersion。没有迁移，不删除学习记录、材料或显式偏好。仅对授权内测账号试用，不因本地测试绿灯自动扩大灰度。
