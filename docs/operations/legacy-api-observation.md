# 旧 API 弃用观察

WP2.2 的日志只表示服务器收到请求，不表示鉴权通过、业务成功或接口已经可以删除。当前保留全部路由和原有响应行为。

## 首批路由

| 路由模板 | 范围 |
| --- | --- |
| `/api/explorations` | 当前请求 |
| `/api/explorations/[id]` | 当前请求 |
| `/api/explorations/[id]/blocks` | 当前请求 |
| `/api/explorations/[id]/branches` | 当前请求 |
| `/api/explorations/[id]/status` | 当前请求 |
| `/api/explorations/[id]/promotions` | 当前请求 |
| `/api/promotions/[id]/accept` | 当前请求 |
| `/api/promotions/[id]/reject` | 当前请求 |
| `/api/practice/[id]` | 当前请求 |
| `/api/practice/[id]/hint` | 当前请求 |
| `/api/practice/[id]/reveal` | 当前请求 |
| `/api/revision-proposals/[id]` | GET、HEAD |

`documents`、`courses`、修订的 `review/resolve`、cards、reviews、search、workspace preferences 仍供 Opening 使用，不在本批观察清单。旧 API 内部共享仓库和服务也不随路由清单删除。

## 日志口径

在原有 middleware 请求入口写标准输出 JSON，事件名为 `deprecated_api_request`。字段包括 `observedAt`、`route`、`method`、`caller`、`callerSource`、`build`。未配置有效发布提交时 `build` 为 null。

- `route` 只保留固定模板，不写资源 ID 或查询参数。
- 同源 Referer 只映射为编辑器、课程、建议等固定标签，不保存原值；无法归类时保留 unknown。
- 可选 `x-aistudy-caller` 仅接受 `opening.editor`、`opening.courses`、`opening.suggestions`、`script`；这些是未经身份认证的诊断提示，`callerSource=header_hint`，不得用于授权或排除调用统计。
- 不读取正文，不记录用户/工作区 ID、IP、Cookie、Token、User-Agent 或原始 Referer。记录包含被拒绝的请求；日志写入失败不替换原鉴权或 API 结果。

## 30 天窗口与删除条件

1. 按原有发布流程部署后，记录实际发布提交和日志开始收集时间；提交日期不算观察开始时间。
2. 确认实际运行的每个实例均收集标准输出，且轮转/保留能覆盖连续 30 天。缺失日志的日期不能作为零调用。
3. 按 `route + method + caller + callerSource` 汇总；保留 unknown、旧客户端和被拒绝请求。调用方标签不能证明调用来自可信客户端。
4. 有调用时先查明仍使用的页面、脚本或外部客户端，不删除对应 API。
5. 连续完整窗口无实际调用后，再逐项审查共享依赖并提交删除改动。该代码不会自动启动计时、删除路由或停止服务。

`check-api-contracts.mjs` 校验引用到的地址/方法和页面是否存在；它不是未使用分析器，也不是线上流量证据。当前尚未部署本轮日志，未建立有效的 30 天观察窗口。
