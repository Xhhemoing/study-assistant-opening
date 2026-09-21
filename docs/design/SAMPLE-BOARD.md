# UI/UX 组件与样例选型表

状态：研究 shortlist，尚未安装；2026-09-20 在线核对官方文档、registry 与 npm 元数据。对应 [日常使用设计](DAILY-USE-UX-RESEARCH.md)。

## 1. 选型结论

推荐基础：**保留 `@aistudy/ui` 为本项目组件出口，按需纳入 shadcn 源码组件与 Radix 行为原语，继续 Tailwind＋lucide＋BlockNote。**

选择理由：本项目需要可控制的样式、焦点、抽屉、菜单和编辑空间，已有业务组件应复用。shadcn 是组件源码分发方式，不是引入后自动解决所有设计问题的主题包。

Primary 参考：Linear 的导航、列表与渐进展开；密度放宽至适合中文学习内容。温和感来自可靠的保存、恢复和纠正行为。

兼容性事实：本地 lockfile 为 Next 15.5.21、React 19.1.9、Tailwind 4.3.3、BlockNote core/react 0.52.1。npm 元数据的 peer 支持不等于集成已经通过。

## 2. 六项 shortlist

评分为本轮主观契合度，不是性能实测：场景30＋栈20＋气质20＋维护15＋质量信号15。

| 编号／用途 | 官方来源与预览描述 | 建议／契合分 | 主要适配风险 |
|---|---|---|---|
| S1 全局工作台 | [sidebar-07 预览](https://ui.shadcn.com/view/new-york-v4/sidebar-07)、[源码 registry](https://ui.shadcn.com/r/styles/new-york/sidebar-07.json)：可折叠图标侧栏、分组、面包屑 | 首选结构参考，92/100；默认文字导航，仅主动收起时变图标 | 示例含多余项目、账户升级等内容；sidebar 组件含 `style`；Next 内部导航应使用 Link 适配 |
| S2 课程内部导航 | [sidebar-05 源码](https://ui.shadcn.com/r/styles/new-york/sidebar-05.json)、[侧栏目录](https://ui.shadcn.com/blocks/sidebar)：可折叠子菜单 | 备选，82/100；只借课程内部树结构，不另建第二全局侧栏 | 深嵌套会增加找内容负担；移动改列表／抽屉，避免双侧栏 |
| S3 原因／属性／记忆抽屉 | [Sheet](https://ui.shadcn.com/docs/components/sheet)、[源码](https://ui.shadcn.com/r/styles/new-york/sheet.json)：侧边面板，Radix Dialog 行为 | 首选，95/100；接入现有 Drawer 出口，保留本项目业务内容 | 焦点回归、背景滚动、嵌套编辑器、手机软键盘必须验证；当前只保留一个上下文面板 |
| S4 搜索与快捷操作 | [Command](https://ui.shadcn.com/docs/components/command)、[源码](https://ui.shadcn.com/r/styles/new-york/command.json)：cmdk 列表与键盘选择 | 87/100；复用现有搜索 API，命令主体首次打开时加载 | 不重造搜索后端；中文输入法、无结果、权限过滤、焦点和大结果集测试 |
| S5 材料／助理分栏 | [Resizable](https://ui.shadcn.com/docs/components/resizable)、[源码](https://ui.shadcn.com/r/styles/new-york/resizable.json)：基于 react-resizable-panels 的可调分栏 | 条件采用，86/100；桌面并排，窄屏变材料／对话切换 | 拖动内部使用动态布局，需核对仓库对第三方运行时样式的边界；先允许固定比例＋专注切换落地 |
| S6 块编辑器外观 | [BlockNote shadcn 接入](https://www.blocknotejs.org/docs/getting-started/shadcn)：复用既有块编辑器，替换周边控件 | 保留核心，适配包条件采用，89/100 | `@blocknote/shadcn@0.52.1` 为 MPL-2.0；需主题 token／Tailwind source 扫描，不能照抄文档新加全局 CSS |

S1 官方预览通过浏览器访问，HTTP 200，DOM 包含可折叠导航与面包屑；已截图留证。当前会话模型不支持读图，因此未声称完成截图像素级视觉评分。其余卡片以源码和官方说明为证据。

下列仅为选定后的安装参考，**本轮均未执行**。执行前在工作区配置组件路径、锁定 CLI／依赖版本、检查生成 diff。

```bash
npx shadcn@latest add sidebar-07
npx shadcn@latest add sidebar-05
npx shadcn@latest add sheet dialog tabs dropdown-menu tooltip
npx shadcn@latest add command
npx shadcn@latest add resizable
npm install -w @aistudy/web @blocknote/shadcn@0.52.1
```

本项目实际建议以结构移植＋按需基础件为主，不整块执行所有命令。新版 registry 同时存在不同 primitive／style 路线，须明确选 Radix 与 Tailwind 4，避免默认安装一条不同路线。

## 3. 基础库比较

| 方案 | 核查事实 | 本项目决定 |
|---|---|---|
| [shadcn](https://ui.shadcn.com/docs)＋[Radix](https://www.radix-ui.com/primitives/docs/overview/accessibility) | shadcn 为源码自持分发；官方源码许可 MIT。核查的 Radix Dialog 1.1.23 为 MIT，peer 范围含 React／ReactDOM 19；Radix 文档说明 WAI-ARIA 行为基础 | 推荐；Dialog/Sheet/Popover/Menu/Tabs 使用一套行为系统，由 `@aistudy/ui` 封装 |
| [Base UI](https://base-ui.com/react/overview/about) | 无样式可组合 React 组件；核查 `@base-ui/react@1.8.0` 为 MIT，peer 含 React19 | 有效替代，不与 Radix 同期覆盖同一控件；本项目 BlockNote shadcn 适配已有 Radix 依赖，优先减少重复 |
| [React Aria](https://react-spectrum.adobe.com/react-aria/) | 官方提供行为、适应性交互、无障碍和国际化基础件 | 当确有复杂日期／组合框缺口时专项评估，不默认再添第二套全局原语 |
| Mantine／Ant Design | 本轮未专项在线核查其发行版本，不作包体或许可证比较结论 | 不推荐整体替换：当前无需新建大规模管理后台，替换会增加主题和交互迁移范围；不能仅凭品牌断言“很慢” |

## 4. 数据、AI 与阅读能力

| 能力 | 推荐与条件 |
|---|---|
| 服务端状态 | [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview)列为首批小范围验证：当前已存在后台 job、刷新和失效需求。服务端鉴权与首屏数据仍由 Next 合理承担；缓存按用户／工作区隔离，退出清理 |
| 长列表 | [TanStack Virtual](https://tanstack.com/virtual/latest/docs/introduction)为无样式虚拟化工具；先分页、后用实际长列表验证。不能为短列表预装，也不能破坏长消息选择、引用定位和屏幕阅读 |
| 对话界面 | [assistant-ui ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)可接现有消息／运行状态；job 模式不是技术排除项。作为候选做一次边界验证，保持现有 Conversation/Turn/Job 权威数据模型 |
| assistant-ui 成本 | 核查 `@assistant-ui/react@0.15.21`：MIT，peer React18/19；依赖含 core/store、Zustand、Radix、assistant-stream、assistant-cloud 等。先测实际打包树与适配，不因为依赖名字推断必须用其云端服务 |
| [AI Elements](https://elements.ai-sdk.dev/docs) | 官方当前面向 React19＋Tailwind4，安装前提包括 AI SDK 与 shadcn。可借消息／引用展示，不为 UI 强制迁移现有后端到 AI SDK；与 assistant-ui 二选一验证，不叠两套消息框架 |
| 笔记 | 继续 BlockNote core/react 0.52.1，保留 Document/Block/Revision。本地 README 说明核心 MPL-2.0；XL 扩展有其他许可要求，不能笼统写全部 MIT |
| 公式、PDF、音视频 | 先盘点已装解析／阅读能力，再按真实公式和材料样本选择渲染件；本轮没有核验这些新包，不以未验证推荐作为采用结论。内容必须有页码／时间戳／来源，不能只给漂亮聊天气泡 |

需要产品自己实现的是上传／解析状态映射、来源权限、课程归属、学习证据、记忆生命周期、计划差异确认和跨端恢复；基础组件库不能替代这些。

## 5. 适配合同草案

- **保留：**导航结构、键盘交互、语义标记、焦点管理、基础组合能力。
- **替换：**示例品牌、工具型英文菜单、示例账户与项目、颜色／间距／字体；映射现有语义 token。
- **删除：**示例营销升级入口、假统计卡片、冗余侧栏和装饰动效。
- **项目约束：**应用新代码只用 Tailwind utilities；不新增 native CSS 或 inline `style`。官方 sidebar 固定宽度的 inline CSS 变量改为静态 utility；第三方内置动态样式需单独核对，不把它伪称为零样式方案。
- **拆分：**公共基础件归 `packages/ui/src`；领域面板归 `apps/web/src/features/opening`；每个新模块≤200行。
- **验证：**Next／React19 SSR 与 hydration、中文 IME、手机安全区、键盘／焦点返回、列表／抽屉滚动、主题一致、权限／缓存隔离、按路由资源量。

## 6. 官方证据与边界

已成功读取：shadcn 主文档／sidebar 文档／开放 registry、Radix accessibility、Base UI、React Aria、BlockNote shadcn、assistant-ui external-store、AI Elements、TanStack Query／Virtual，以及 npm 包元数据。

- [shadcn MIT](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md)
- [Radix Dialog 元数据](https://registry.npmjs.org/@radix-ui%2freact-dialog/1.1.23)
- [BlockNote shadcn 0.52.1 元数据](https://registry.npmjs.org/@blocknote%2fshadcn/0.52.1)
- [assistant-ui 0.15.21 元数据](https://registry.npmjs.org/@assistant-ui%2freact/0.15.21)
- [Base UI 1.8.0 元数据](https://registry.npmjs.org/@base-ui%2freact/1.8.0)

BlockNote 猜测的 `/docs/getting-started/license` 与仓库 `LICENSE`／`LICENSE.md` URL 返回404；本轮许可判断使用已安装包 `package.json`、`README.md`、`LICENSE` 和版本固定的 npm 元数据。旧 `view/new-york/sidebar-07` 预览返回404，通过官方 blocks 页发现正确地址为 `view/new-york-v4/sidebar-07`，浏览器复验200。

本轮没有配置或依赖迁移；采用时还需生成锁文件并运行相关 typecheck、组件与浏览器检查。先确定首个完整使用流程，再选择支持该流程的最小组件集合。
