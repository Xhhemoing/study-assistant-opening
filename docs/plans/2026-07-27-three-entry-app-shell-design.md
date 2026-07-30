# AIstudy 三入口应用壳 UX 优化设计

> 日期：2026-07-27
> 范围：Phase 1 / Task 9 前端应用壳（不含块编辑器、双链、搜索、AI 对话等后续任务）
> 依据：PRD v0.2、UX_AND_AI_POLICY.md、2026-07-21-lifelong-learning-implementation.md
> 目标：把当前绿地前端变成可运行、以用户体验为优先的三入口应用壳。

## 一、要解决的 UX 问题

当前前端只有一句"脚手架已就绪"。用户进入产品后：
1. 不知道这是学习平台；
2. 没有登录/注册入口；
3. 没有三个入口（Learn/Explore/Library）的任何形态；
4. 没有空状态、响应式、默认入口、错误降级等基础体验；
5. 后端 API 已具备 auth/courses/documents，但 UI 完全未连接。

本次设计先把**应用壳**建好，让产品"能用、好懂、有统一导航"。

## 二、设计原则

1. **三入口平等**：`/learn`、`/explore`、`/library` 地位相同。用户可在 onboarding 选择默认入口；根路径 `/` 导航到默认入口，而不是强制 `/learn`。
2. **渐进披露**：未登录时只暴露"开始探索"和"登录/注册"；注册后仅要求选择默认入口；目标/课程/设置全部可跳过。
3. **默认首屏信息预算**：严格遵循 UX_AND_AI_POLICY：每个入口首屏只放状态/任务、关键数据、下一步、可展开入口。不堆仪表盘。
4. **响应式优先**：320/768/1440 三档。移动端底栏，桌面侧栏。
5. **空状态即引导**：每个入口没有内容时，给出具体下一步操作（不是"暂无数据"）。
6. **AI 失败不阻塞**：AI 区域挂掉时，主界面仍可继续手动操作。
7. **无障碍**：键盘可达、颜色不唯一传达状态、语义化标题。

## 三、信息架构

```text
/                    → 重定向到用户默认入口（首次访问为 onboarding）
/onboarding          → 选择默认入口（Learn/Explore/Library）
/today               → 可选聚合页（不在第一阶段实现，仅预留链接）
/learn               → 目标学习首页（今日任务、风险点、进度）
/explore             → 自由探索首页（AI 对话骨架 + 草稿沉淀入口）
/library             → 笔记与知识库首页（文档列表 + 新建入口）
/login               → 登录
/register            → 注册
/api/*               → 已有后端 API，保持不变
```

所有受保护页面进入 `(workspace)` 路由组，共享应用壳和导航。

## 四、应用壳布局

### 桌面端（≥1024px）

```text
+----------------------------------------+
|  Sidebar  |        Main Content         |
|  (nav)    |                             |
|           |                             |
|  Learn    |                             |
|  Explore  |                             |
|  Library  |                             |
|           |                             |
+----------------------------------------+
```

- 左侧固定侧栏，宽度 16rem（256px），可折叠为图标栏（64px）。
- 侧栏顶部显示 logo + 平台名，底部显示用户头像/退出。
- 主内容区最小宽度 320px，最大宽度 1200px，居中或左对齐根据内容类型决定。

### 平板/小桌面（768px–1023px）

- 侧栏变为可展开抽屉（汉堡菜单），主内容全宽。

### 移动端（<768px）

```text
+------------------+
|   Main Content   |
|                  |
+------------------+
| Learn | Explore  |
|  Library | 我    |
+------------------+
```

- 底部固定四栏导航：Learn、Explore、Library、Me（账户/退出）。
- 底部栏高度 4rem（64px），安全区适配。

## 五、导航组件

复用并增强 `packages/ui/src/workspace-navigation.tsx`：
- 增加 `placement="bottom"` 的完整实现（当前只有数据结构，没有视觉）。
- 增加当前入口高亮（aria-current="page" + 视觉高亮）。
- 增加图标和标签，而不是只有首字母。
- 增加可折叠状态（桌面侧栏）。

新增 `packages/ui/src/app-shell.tsx`：
- 组合 `WorkspaceNavigation` + 主内容区 + 底部栏。
- 接收 `activeEntry` prop。
- 处理响应式切换（CSS + media query，不使用 JS 判断宽度）。

## 六、登录/注册页

### 注册页 `/register`

字段：
- 用户名（必填，3-32 字符，字母数字下划线）
- 密码（必填，8-128 字符）
- 确认密码（前端校验一致性）

提交后：
1. 调用 `/api/auth/register`；
2. 成功即自动登录（后端 register 会创建会话），重定向到 `/onboarding`；
3. 失败显示后端返回的错误信息。

### 登录页 `/login`

字段：
- 用户名
- 密码

提交后：
1. 调用 `/api/auth/login`；
2. 成功重定向到默认入口（若已设置）或 `/onboarding`；
3. 失败显示错误信息。

### 视觉

- 居中单卡片，最大宽度 400px；
- 深色主题，与平台一致；
- 输入框聚焦环明显；
- 提供"已有账号？登录" / "没有账号？注册"切换链接。

## 七、Onboarding `/onboarding`

仅一页：
- 标题："选择你的默认入口"
- 三张大卡片：Learn / Explore / Library，每张带一句价值说明。
- 选择后立即保存到用户配置（先使用 localStorage，后续 Task 再迁移到后端配置）。
- 选择后进入对应入口。

说明：
- 只要求选择入口，不要求创建课程或目标。
- 选择可修改（在"我"页面中）。
- 未登录用户不能进入 onboarding；先登录/注册。

## 八、三入口首页（第一阶段占位版）

### `/learn`（目标学习）

首屏内容：
- 欢迎区："今日目标学习" + 一句状态摘要。
- 今日任务卡片（空状态："还没有今日任务，先创建一门课程或一次探索"）。
- 风险点区（空状态："暂无风险点，开始学习后会在这里显示"）。
- 主操作："创建课程"（链接到 courses API 暂未做的 UI，第一阶段只放一个按钮）。

严格遵循：
- 状态词预留位置，但不显示虚假数据；
- 每个卡片不超过 3 个补充字段；
- 原因抽屉预留结构，第一阶段用静态占位展示形态。

### `/explore`（自由探索）

首屏内容：
- 输入框："输入问题、主题或粘贴资料..."（第一阶段只做输入框，不连接 AI）。
- 空状态："提出一个问题，开始一次探索。"（下方显示示例 prompt）。
- 沉淀按钮占位："转笔记"、"转卡片"、"转题目"（视觉存在，但第一阶段 disabled 或提示"即将上线"）。

这保证了用户能进入 Explore 并理解它是什么，而不是空白。

### `/library`（笔记与知识库）

首屏内容：
- 搜索/新建栏。
- 文档列表（调用 `/api/documents` 读取真实数据）。
- 空状态："还没有笔记。创建第一篇笔记或从探索中沉淀。"
- 每个文档显示标题、更新时间、所属课程（若有）。

这是三入口中唯一一个第一阶段就连接真实数据的页面，因为它依赖的 API 已存在。

## 九、设计系统（第一阶段轻量）

颜色（沿用现有深色主题）：
- 背景：`#0b1020`
- 表面：`#121a2b`
- 文字主色：`#f5f7ff`
- 文字次色：`#94a3b8`
- 主色：`#6ea8fe`
- 成功：`#4ade80`
- 警告：`#facc15`
- 危险：`#f87171`

状态词颜色：
- 稳固：成功绿
- 可用：主色蓝
- 薄弱：警告黄
- 未测：文字次色

所有状态词必须配文字标签，不只用颜色。

间距：
- 4px 基础单位：4, 8, 12, 16, 24, 32, 48。
- 组件内部用 12/16，页面用 24/32。

字体：
- 系统无衬线栈（沿用现有）。
- 页面标题 1.5rem（24px），区块标题 1.125rem（18px），正文 1rem（16px），辅助 0.875rem（14px）。

## 十、测试策略

按 TDD：

1. 应用壳渲染测试：确认 `AppShell` 渲染导航和主内容。
2. 导航切换测试：确认点击 Learn/Explore/Library 跳转正确路径，aria-current 正确。
3. 响应式测试：确认桌面显示侧栏，移动端显示底部栏（使用 Testing Library + CSS 类断言，不直接测像素）。
4. 登录/注册表单测试：
   - 字段校验；
   - 提交成功重定向；
   - 提交失败显示错误。
5. Onboarding 测试：选择入口后保存并跳转。
6. Library 页面测试：空状态、有数据列表。
7. 无障碍测试：
   - 每个页面有唯一 h1；
   - 所有交互元素可 Tab 聚焦；
   - 颜色不唯一传达状态。

端到端测试（Playwright）：
- 注册 → onboarding → 选择入口 → 看到对应首页。
- 登录后从侧栏/底部栏切换三个入口。

## 十一、第一阶段不做的事（防止范围蔓延）

- 不实现真正的 AI 对话（Explore 第一阶段只保留输入框占位）。
- 不实现块编辑器（Library 只列文档标题，不编辑内容）。
- 不实现课程创建 UI（Learn 中按钮可 placeholder）。
- 不实现原因抽屉的数据驱动（只展示形态）。
- 不实现全局搜索/命令面板（Task 12 内容）。
- 不使用第三方 UI 库（如 shadcn、MUI），只用 React + Tailwind 或纯 CSS。
- 不引入全局状态库（Zustand/Redux），先用 React Context + localStorage。

## 十二、任务拆分（每步小且可提交）

任务 A：建 `(workspace)` 路由组 + AppShell + 导航接入
- 创建 `apps/web/src/app/(workspace)/layout.tsx`。
- 创建 `apps/web/src/app/(workspace)/learn/page.tsx`。
- 创建 `apps/web/src/app/(workspace)/explore/page.tsx`。
- 创建 `apps/web/src/app/(workspace)/library/page.tsx`。
- 增强 `packages/ui/src/workspace-navigation.tsx`。
- 创建 `packages/ui/src/app-shell.tsx`。
- 写测试：AppShell 渲染、导航切换、响应式类。
- 验证：lint/typecheck/test/build。
- 提交。

任务 B：登录/注册页面 + 会话状态
- 创建 `apps/web/src/app/login/page.tsx`。
- 创建 `apps/web/src/app/register/page.tsx`。
- 创建 `apps/web/src/features/auth/use-auth.ts`（读取 /api/auth/me，提供登录态）。
- 创建 `apps/web/src/lib/api-client.ts`（简单 fetch 封装）。
- 写测试：表单验证、成功/失败流程。
- 验证。
- 提交。

任务 C：Onboarding + 默认入口记忆
- 创建 `apps/web/src/app/onboarding/page.tsx`。
- 扩展 `use-auth` 支持保存/读取默认入口（先 localStorage，后续迁移）。
- 修改 `apps/web/src/app/page.tsx` 重定向逻辑。
- 创建"我"页面入口，允许修改默认入口。
- 写测试：onboarding 选择、默认入口跳转、修改入口。
- 验证。
- 提交。

任务 D：三入口空状态 + Library 真实数据 + 响应式细节
- 为 Learn/Explore/Library 写空状态组件。
- Library 连接 `/api/documents` 读取真实数据。
- 完善响应式：320/768/1440 视觉检查。
- 写 E2E 测试：注册 → onboarding → 切换入口。
- 验证。
- 提交。

## 十三、验收标准

- [ ] 用户访问 `/` 时，未登录 → `/login`；已登录无默认入口 → `/onboarding`；有默认入口 → 对应入口。
- [ ] 登录/注册页面可用，错误提示清晰。
- [ ] Onboarding 只需选择默认入口，不强制创建课程/目标。
- [ ] 桌面显示左侧导航，移动端显示底部导航。
- [ ] 三入口可互相切换，当前入口高亮正确。
- [ ] Library 显示真实文档列表；空状态有引导。
- [ ] Learn/Explore 显示有意义的空状态和下一步。
- [ ] 所有新增页面有唯一 h1，所有交互元素可键盘访问。
- [ ] `npm run lint && npm run typecheck && npm test && npm run build` 全部通过。

## 十四、风险与后续依赖

- 风险：用户配置持久化先用 localStorage，后续 Task 需要迁移到后端。 mitigration：封装在 `use-auth` 中，迁移时只改一处。
- 依赖：后续 Task 10/11/12 会填充块编辑器、双链、搜索、AI 对话。本阶段只建壳，不深入功能。
- 风险：响应式若只用 CSS 类，Next.js 服务端渲染可能 hydration 不匹配。 mitigration：避免在 JS 中判断窗口宽度，用 CSS media query + 数据属性，保持 SSR/CSR 一致。

---

设计完成。等待用户批准后开始按任务 A → B → C → D 执行。
