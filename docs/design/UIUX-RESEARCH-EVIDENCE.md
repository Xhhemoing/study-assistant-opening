# UI/UX 调研证据与边界

研究日期：2026-09-20
范围：日常使用流程、信息架构、视觉方向、组件库和前端性能风险。
状态：研究记录，不是实现完成证明，也不是最终 Design Contract。

## 1. 调研方法

本轮将同一份任务说明和同一份源码／产品文档摘要分别交给四个模型独立阅读，要求只读、引用文件、区分现状与提案、不给出未经测量的性能结论：

| 模型 | 路由／结果 | 备注 |
|---|---|---|
| `gpt-5.6-sol` | `tokenfree-sol/gpt-5.6-sol` 成功 | 初次 `agentrouter` 路由返回预算池耗尽，换已配置路由重试 |
| `kimi-k3` | `lant/kimi-k3` 成功 | 无代码修改 |
| `gpt-6-astra` | `tokenfree-astra/gpt-6-astra` 成功 | 无代码修改 |
| `glm-5.3` | `lant/glm-5.3` 成功 | 首次大包连接失败，缩小同一证据包后重试 |

四份完整原始报告保存在本机忽略目录 `.pi/uiux-research/`，该目录不进入提交。最终结论只采用模型报告与本地源码／文档／公开来源交叉后仍成立的内容。

本轮还执行了：

- `graphify query`：确认 Opening shell、assistant、today、courses、contracts 和现有 workspace 节点关系。
- 官方公开页面与 registry 读取：shadcn、Radix、Base UI、React Aria、BlockNote、assistant-ui、AI Elements、TanStack Query／Virtual。
- Playwright 浏览器检查：本地 Opening 页面与官方 shadcn sidebar 预览。

没有执行：真实用户访谈、真机测试、生产构建性能测试、Lighthouse、数据库／学校邮箱／钉钉／真实模型链路测试。

## 2. 四模型共识

| 主题 | 共识 |
|---|---|
| 入口 | 当前开学版应保留“今天／助理／课程”三个主入口；不能把 7 月终身学习版的 Learn／Explore／Library 直接覆盖到当前 Opening 分支 |
| 资源 | 上传／收件箱必须是全局可见工具，并区分原件已接收、解析中、可用和失败；笔记与资料不能只藏在 AI 对话或搜索里 |
| 日常恢复 | 首页首先帮助用户继续上次具体问题、材料页位和草稿，再给不超过三项今日行动；不做掌握率仪表盘或打卡压力 |
| 助理 | 材料和对话在桌面并排、手机切换；上下文 chip、页码／时间戳和来源引用要靠近当前对话；自由交流不能被课程前置条件阻断 |
| 笔记 | 编辑正文应是视觉中心；属性、关系、回链、版本和 AI 放到单一互斥检查器／抽屉，不把多块高级面板堆在正文下方 |
| 温和感 | 来自可恢复、可跳过、可纠正、拒绝后不重复施压和不丢草稿，而不是装饰性插画、渐变或激励徽章 |
| 性能 | 当前是代码推导风险，不能声称“实测慢”：认证／数据加载瀑布、job 提交后只刷新一次、编辑器每次变更序列化草稿、大列表全量渲染都应建立基线再优化 |
| 组件 | 保留项目自己的 `@aistudy/ui`、Tailwind、lucide、BlockNote；按需采用 shadcn 源码组件＋一套行为原语，不整体引入 Mantine／Ant Design，也不同时混用 Radix 与 Base UI |

## 3. 模型间的有效分歧

1. **资料库是否成为第四主导航。**
   - 三个模型建议本阶段将“资料与笔记”作为固定可见工具入口，移动端仍保持三项底栏。
   - 一个模型认为长期写作／查资料的频率可能足以成为第四项。
   - 综合建议：现在固定可见、不隐藏、不要求先聊天；把升级条件交给真实使用数据，例如独立笔记／资料成为主要到访目的，或用户频繁绕路找内容。该决定可逆。

2. **是否马上采用 assistant-ui／AI Elements。**
   - 部分模型认为 `assistant-ui` 的 ExternalStoreRuntime 可以接现有 job／消息状态；另一些建议暂缓以避免对现有契约造成耦合。
   - 综合建议：先做一次小型边界验证，比较自有消息列表和一个外部 store 适配的 bundle、引用、中文输入法、错误恢复和可访问性；未完成比较前不迁移。

3. **明暗主题默认值。**
   - 多数报告偏向中性浅色工作台，但没有用户明确批准默认主题。
   - 综合建议：先统一语义 token 和主题边界，再让用户决定默认浅／深色；不能把模型偏好当产品决定。

## 4. 权威事实与源码证据

### 产品与信息架构

- 当前批准的 Opening 主导航是今天、助理、课程；收件箱作为全局上传入口与待确认计数；助理允许无课程交流；电脑材料与辅导并排、手机切换。见 [开学版设计](../superpowers/specs/2026-09-12-opening-release-design.md:27)。
- 9 月扩展已将学校邮箱、钉钉、音视频、课程知识结构和针对性辅导纳入范围；不能用早期“暂缓”描述排除这些能力。见 [能力扩展](../superpowers/specs/2026-09-14-learning-capability-expansion.md:3)。
- Opening release 开启时，`/learn`、`/explore` 和 `/preview*` 会重定向到 `/opening/today`；这是代码明确的分支策略，不应把旧 workspace 页面当作当前 Opening 首屏。见 [middleware.ts](../../apps/web/src/middleware.ts:7)。
- 首页在 Opening release 下重定向到 `/opening/today`。见 [app/page.tsx](../../apps/web/src/app/page.tsx:5)。

### 当前实现的具体断点

- 助理加载顺序为材料、会话、会话恢复和轮次；见 [assistant-view.tsx](../../apps/web/src/features/opening/assistant/assistant-view.tsx:57)。这支持“可能有加载瀑布”的风险判断，但没有测量数据。
- 当前提交后只调用一次 `refreshConversation`，pending 文案提示用户稍后刷新；见 [assistant-view.tsx](../../apps/web/src/features/opening/assistant/assistant-view.tsx:37)。持续轮询／订阅是提案，不是现状。
- 当前没有材料时会直接阻止发送；见 [assistant-view.tsx](../../apps/web/src/features/opening/assistant/assistant-view.tsx:100)。这与批准设计中的“允许无课程交流”不一致，是薄聊天 UI 的范围断点，不等于后端不存在。
- 模式下拉直接展示 `hint`、`explain`、`listen`、`think_together`；见 [composer.tsx](../../apps/web/src/features/opening/assistant/composer.tsx:7)。这是可见文案问题，不是协议本身错误。
- Opening shell 桌面和移动分别渲染导航，上传 CTA 在桌面侧栏和页头各出现一次；课程路径直接把 URL 片段显示为课程名；见 [opening-shell.tsx](../../apps/web/src/features/opening/shell/opening-shell.tsx:13)。
- 编辑器每次 BlockNote 变更都会转换 block、更新父组件状态并同步写 localStorage；见 [document-editor.tsx](../../apps/web/src/features/editor/document-editor.tsx:87)。这是需要 profiling 的性能风险。
- 编辑器冲突态的“重新加载最新版本”会先删除本地草稿；见 [document-editor.tsx](../../apps/web/src/features/editor/document-editor.tsx:150)。这是可静态确认的恢复风险，应先保留／导出本地内容再给放弃选项。
- 根样式强制 `color-scheme: dark` 并全局引入 BlockNote CSS；Opening shell 使用 `zinc` 浅色；编辑器固定 `theme="dark"`。见 [globals.css](../../apps/web/src/app/globals.css:1)、[opening-shell.tsx](../../apps/web/src/features/opening/shell/opening-shell.tsx:15)、[document-editor.tsx](../../apps/web/src/features/editor/document-editor.tsx:217)。这是主题分裂的源码事实。
- 当前 `apps/web` 未在自身 `package.json` 声明 `lucide-react`，但应用源码直接导入它，UI 包声明了该依赖。是否依赖 workspace hoisting 可用，应由构建检查确认；不能仅凭源码称为运行时故障。见 [web package](../../apps/web/package.json:13) 与 [UI package](../../packages/ui/package.json:17)。

### 产品约束

- 默认结果层只显示状态词、少量结果、下一步和展开入口；状态词固定为稳固、可用、薄弱、未测；不显示“95%掌握”。见 [UX policy](../product/UX_AND_AI_POLICY.md:5)。
- 模型失败要明确降级，不能用负罪感或虚假紧迫文案；见 [UX policy](../product/UX_AND_AI_POLICY.md:141)。
- 计划接受须检查版本与幂等，多端旧页面不能覆盖新计划；见 [开学版设计](../superpowers/specs/2026-09-12-opening-release-design.md:70)。

## 5. 公开组件核验结果

本轮以 2026-09-20 可访问的官方页面、官方 registry 和 npm 元数据为依据；版本会变化，采用前仍需重新锁定。

| 项目 | 本轮核验到的事实 | 设计决定 |
|---|---|---|
| shadcn | 官方文档明确其是源码自持／复制式构建方式；官方 sidebar registry 可读，`sidebar-07` 包含可折叠侧栏结构；源码许可页面为 MIT | 借结构并放进 `@aistudy/ui`，不照搬示例内容；官方 v4 sidebar 源码包含 `style`，需改为项目允许的 Tailwind 形式 |
| Radix Dialog | npm 元数据核到 `@radix-ui/react-dialog` 1.1.23、MIT、peer 范围包含 React／ReactDOM 19；官方文档强调可访问性模式 | 与 shadcn 作为首选行为原语；一次只采用一套全局 primitive |
| Base UI | 官方说明为无样式、可组合 React 组件；npm 元数据核到 `@base-ui/react` 1.8.0、MIT、peer 含 React 19 | 作为 Radix 的替代，不并行覆盖同类控件 |
| React Aria | 官方说明提供行为、适应性交互、可访问性和国际化组件 | 只有复杂日期／组合框等明确缺口才单点引入 |
| BlockNote | 本地安装 core/react 为 0.52.1、MPL-2.0；本地 README 说明核心许可范围，XL 包另有 GPL-3.0 注意事项；官方 shadcn 接入文档可读 | 保留编辑核心；先改外围布局，不重写块模型；不笼统宣称所有扩展同一许可 |
| assistant-ui | npm 元数据核到 `@assistant-ui/react` 0.15.21、MIT、peer React 18/19；官方 ExternalStore 文档展示自定义消息状态接入 | 可做小范围适配实验；不让它取代本项目会话、来源、学习证据和 job 权威模型 |
| AI Elements | 官方文档当前面向 React 19、Tailwind 4、shadcn，并以源码组件方式安装 | 只作消息／引用展示候选；不为它强制迁移后端到 AI SDK |
| TanStack Query／Virtual | 官方文档分别定位服务端状态管理和无样式虚拟列表 | Query 在后台 job／缓存需求明确后小范围验证；Virtual 只在长列表实测后引入 |

已成功访问的代表性链接记录在 [组件选型表](SAMPLE-BOARD.md)。本轮没有安装任何组件或依赖。

## 6. 动态检查结果

### 本地项目

Playwright 访问：

- `http://localhost:3000/opening/today`：HTTP 500
- `http://localhost:3000/opening/assistant`：HTTP 500

返回错误为：

```text
ModuleBuildError: UnhandledSchemeError: Reading from "node:crypto" is not handled by plugins
```

因此本轮没有可靠的本地截图、DOM 体验或性能测量。错误发生在开发服务当前构建阶段；已观察到 `node:crypto` 出现在服务端领域模块（例如 `packages/domain/src/opening/retest-policy.ts`），但本轮没有把完整 import trace 定位到单一根因，也没有擅自修改代码。应另开系统调试任务处理“服务端模块被错误纳入当前构建边界”的问题，并在修复后重跑浏览器检查。

### 官方参考页面

- `https://ui.shadcn.com/blocks/sidebar`：Playwright HTTP 200，页面存在 sidebar block 列表与预览。
- `https://ui.shadcn.com/view/new-york-v4/sidebar-07`：Playwright HTTP 200，DOM 可读到分组导航、项目和账户区；已保存本地截图作为研究证据，但本会话模型不支持图像输入，因此不作像素级评价。

## 7. 下一步验收与停止条件

开始实现前应先确认：

1. 选择“资料与笔记”是固定工具入口还是第四主导航，以及升级触发数据。
2. 选择浅色／深色默认策略，或先只统一语义主题不设默认偏好。
3. 确定首个完整切片：推荐“材料上传／处理状态 → 当前页提问 → 来源引用 → 次日恢复”。
4. 确认无材料自由交流和“这次不保存”的服务端契约与隐私边界。
5. 单独修复并验证本地 `node:crypto` 构建阻断，再做任何视觉性能结论。

本轮研究的停止条件已经满足：四模型独立报告、官方组件核验、源码事实、动态失败边界和落地优先级均已记录。下一轮可以在你确认首个切片后，写最小 Design Contract 和实现计划；在确认前不应安装远程组件或大改壳层。
