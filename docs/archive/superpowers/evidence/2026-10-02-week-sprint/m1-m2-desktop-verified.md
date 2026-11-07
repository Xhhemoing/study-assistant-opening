# 10/2–10/7 桌面端冲刺交付证据

状态：M1/M2 代码实现与非浏览器验证完成；浏览器端完整流程仍待用户按仓库约定验收。

## 已完成

- U02：桌面材料上传、真实字节进度、失败重试、状态持久化、解析结果查看和原件下载。
- U03：基础对话、模式选择、材料引用、保存与不保存本轮、记忆面板和课程学习状态连接。
- M01：记忆候选提案、确认/拒绝、更正、版本并发检查和幂等处理。
- M02：隐私删除墓碑、privacy epoch、来源文本选择删除和 worker 写回竞态防护。
- M03：不保存模式；临时对话不落正文、不生成记忆候选。
- L01–L03：学习观察、辅助曝光、可解释状态、重测建议、课程摘要读取和固定快照分页。

## 本次检查

```text
npm.cmd exec -- vitest run --project unit apps/web/src/features/opening/inbox/upload-state.test.ts apps/web/src/features/opening/inbox/source-viewer.test.ts apps/web/src/features/opening/assistant/memory-panel.test.ts apps/web/src/features/opening/learning/course-view.test.ts
Test Files  4 passed (4)
Tests       24 passed (24)

npm.cmd exec -- tsc -p apps/web/tsconfig.json --noEmit
Exit 0
```

仓库已有 M01–M03、L01–L03 的隔离 PostgreSQL、handler、integration、unit、contract 和定向 lint 证据，分别见同目录下对应证据文件。当前工作区的 `tasks.json` 已将 M01、M02、M03、L01、L02、L03 标记为 `verified`。

## 用户验收入口

桌面浏览器打开 `/opening/assistant`，准备一个已登录用户和可上传的 PDF：上传并刷新确认状态保持；发送带材料的问题确认回复和引用；确认记忆候选后刷新；在课程页提交一次提示后作答并查看学习状态；切换不保存本轮后发送并刷新确认历史清空。浏览器自动化、截图和录屏由用户执行，当前不能标记为已通过。

## 边界

本证据不代表移动端、真实付费模型、生产部署或后续 P02/Q01 验收完成。
