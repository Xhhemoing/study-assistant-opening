# SenseWeave 0.5.0-rc.1 最小试点

该试点只在 `NEXT_PUBLIC_SENSEWEAVE_PILOT=1` 时显示，并且默认保持关闭。它挂在已有 assistant message 的正文之后，原有 `LearningProse`、Jingwei 图解、出处 chips 和选区映射不变。

## 接入边界

- **输入**：直接复用已完成的 `message.text`，不重新生成、不调用 Agent、不写入任务或学习数据。
- **输出**：SenseWeave 只拥有自己的预览节点；原正文仍是引用定位和笔记摘录的唯一来源。
- **生命周期**：点击打开后懒加载本地 `senseweave-runtime-0.5.0-rc.1.tgz`，挂载一次；组件卸载或消息离开列表时调用 `unmount()`。
- **降级**：包未安装、动态导入失败或 SDK 呈现异常时，保留同一份原文 `<pre>`，不影响回答。
- **权限**：未传入 sources/capabilities 之外的业务权限；SDK 不接管模型或 Agent。

## 本地验证

1. 在 SenseWeave 仓库执行 `npm pack`，得到 `senseweave-runtime-0.5.0-rc.1.tgz`。
2. 在学习助手仓库的 web workspace 安装该本地包：`npm install ./path/to/senseweave-runtime-0.5.0-rc.1.tgz`。
3. 以 `NEXT_PUBLIC_SENSEWEAVE_PILOT=1 npm run dev -w @aistudy/web` 启动。
4. 对同一条回答分别观察概念讲解、数学计算和表格比较：正文与预览必须使用相同字符串。
5. 检查出处链接仍打开原来源位置；在正文选区保存笔记；在预览中打开/关闭交互；切换路由后无残留 `data-senseweave-host`。

## 验收记录模板

| 维度 | 结果 |
|---|---|
| 额外模型请求 | 0（仅传入已有文本） |
| 原文保真 | 需浏览器验收：逐字符比较 |
| 引用定位 | 需浏览器验收：仍由原正文链接负责 |
| Markdown 选区 | 需浏览器验收：仍从原正文映射 |
| 组件交互 | 需浏览器验收：仅限预览节点 |
| 卸载清理 | 单元测试覆盖卸载调用；浏览器需复核 |
| 文本降级 | 单元测试/手工模拟未安装包 |
| 真实学生收益 | 尚无数据，需要后续受控试用 |

当前 PR 是可回滚的实验边界，不改变生产默认行为。
