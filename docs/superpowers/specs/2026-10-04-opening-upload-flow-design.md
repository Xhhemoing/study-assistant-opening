# Opening 上传工作流设计

## 目标

让用户在 Opening 的 Today 材料区和 Assistant 参考资料面板中，用同一套交互完成文件选择、拖拽上传、批量排队、失败重试和解析状态确认。

## 范围

### 1. 统一上传交互

新增共享的 `UploadDropzone` 与上传队列控制逻辑。两个入口都支持：点击选择、键盘触发、拖拽进入高亮、拖拽释放、一次多文件、单文件失败后继续后续文件。文件在客户端校验失败时不创建材料，显示具体支持类型；队列中的文件保留原始 `File`，可重试。

上传状态分为：等待、上传中、已保存待解析、解析失败、完成、失败。字节百分比只表示对象上传进度，不伪装解析进度。状态消息使用 `role=status`，失败操作旁边放置恢复按钮。

### 2. 支持矩阵

客户端和 Contracts 使用同一组 MIME：PDF、PPT/PPTX、HTML、Markdown、PNG/JPEG/WEBP、MP3/M4A/WAV。音频允许先保存；解析器暂时不支持时显示“原件已保存，暂不能提取文字”。客户端不能通过改扩展名伪造类型。

### 3. 失败恢复

解析失败的来源提供“重新解析”。服务端以当前 source 版本和 workspace privacy epoch 创建新的 parse job，客户端刷新来源列表。上传 PUT 失败时保留同一个文件和 ticket，重试不创建第二份材料。

### 4. 隐私 epoch

上传完成创建 parse job 时读取当前 workspace privacy epoch。Worker 只按 workspace epoch 校验任务快照；source version 不再被当作 privacy epoch。隐私删除后的新上传能够正常解析，旧任务仍会被拒绝并落为可见失败状态。

### 5. Opening 内流程

材料管理入口统一指向 `/opening/library` 或 Assistant 的 context panel；课程创建、课程详情和学习动作保持在 Opening 路径，避免从 `/opening/courses` 跳回旧 `/learn` provider。顶栏 review 数量使用现有 review 数据源。

## 非目标

- 本轮不实现 IMAP、钉钉或其他外部连接器。
- 本轮不替换整体视觉主题，不新增原生 CSS，不运行浏览器自动化。
- 浏览器响应式和真机验收由用户执行。

## 数据流

1. `UploadDropzone` 接收一个或多个 `File`，交给队列。
2. 队列调用共享 `createUploadClient`：`beginUpload → private PUT → completeUpload`。
3. 每个文件独立更新状态；失败文件保留 `File` 和 ticket，队列继续。
4. `completeUpload` 创建 parse job；来源轮询刷新直到 `ready/failed/unsupported`。
5. `failed` 来源通过 retry API 使用同一 source 重新排队。

## 可访问性与错误处理

- 拖拽区必须有可聚焦按钮语义，Enter/Space 等价于打开文件选择器。
- 拖拽高亮不能作为唯一状态信号，需有可见文字。
- 处理中禁用重复提交，但允许查看已有材料。
- 网络失败显示原因和重试动作，保留用户选择的文件。
- 长文件名换行，不撑破列表；队列超过可视区域可滚动。

## 验证

- 单元测试覆盖 MIME 解析、多文件队列、拖拽状态、失败后继续、失败重试和隐私 epoch。
- 运行相关 Vitest、直接 TypeScript 检查和 ESLint。
- 浏览器验收重点是拖入多个文件、失败重试、音频、解析状态和 Opening 路由连续性。
