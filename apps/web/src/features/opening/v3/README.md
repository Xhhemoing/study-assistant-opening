# Opening v3 视图组件

## 目录

| 位置 | 用途 |
| --- | --- |
| `motion/` | 页面过渡、展开收起、状态反馈与减少动效偏好 |
| `ui/` | 控件样式、表单字段、列表、抽屉和状态通知 |
| `shell/` | `AppShell`、页头、顶栏、导航项及图标、布局与外观偏好 |
| `workspace/split-view.tsx` | 课程学习工作区的主内容和工具面板。宽屏可调整分栏宽度，窄屏可切换面板。 |
| `start/start-composer.tsx` | 开始输入框，接收草稿、上下文和继续学习建议，通过回调提交。 |
| `learning/session-summary.tsx` | 展示调用方传入的学习计数、待巩固内容与复习安排。 |

## 页面接入

Opening 路由布局通过 `../shell/opening-shell-v3.tsx` 接入 `AppShell`。最近对话、待复习数、账户菜单和学习助手抽屉由这个壳层接入。`../courses/course-study-workspace.tsx` 直接使用 `SplitView` 和 `SplitControls` 管理学习工具。

迁移页面时，沿用所属功能模块的数据加载、校验和错误处理，把展示所需的数据和回调传给对应组件。
