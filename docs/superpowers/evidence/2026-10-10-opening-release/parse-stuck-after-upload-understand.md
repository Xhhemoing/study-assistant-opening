# Understand：上传成功后卡在「原件已保存，正在解析」（只读）

**Date:** 2026-10-10 ~22:16 CST (Asia/Shanghai)  
**Owner:** Pipeline (AIstudy) — authorized by Projects Manager  
**Branch:** `feat/opening-release` @ `7dd1ef8`  
**Status:** UNDERSTAND ONLY — 未改产品代码；未 commit/push；未对 hermes 做 live SSH  
**Paula 现象:** staging PUT 修复后，上传能完成，但 UI 长时间停在「原件已保存，正在解析」  
**对照:** `upload-parse-gaps-understand.md`；`upload-parse-p0-*`（whisper error）；`hermes-deployment.md`；`stuck-pending-upload-understand.md`（**不同症状**：pending 从未 complete）

---

## 结论（先读）

| 项 | 判断 |
|---|---|
| UI 文案含义 | `uploadState=uploaded` 且 `parseState ∈ {not_started, queued, running}`（或未知兜底）→ **「原件已保存，正在解析」** |
| complete→enqueue 是否仍正确 | **是。** `completeWithParseJob` 仍原子写 `parse_state=queued` + `opening_jobs` + `opening_outbox`；staging PUT / upload-parse P0 **未改**这条入队路径 |
| 最可能根因（未 live 验 hermes） | **#1 `aistudy-worker` 未启用 / 未在跑** — 部署脚本只安装 unit 且 **default disabled**；`deploy`/`restart` **只 restart web**，从不 `enable --now` worker。无 worker → outbox 永不 `dispatchPending` → source 永久 `queued` → UI 永久「正在解析」 |
| whisper `blocked_not_configured` | P0（`32be749`）已写 `failed` + 中文 + `retryable:false`。**若 worker 已跑到该分支，UI 应是失败文案，不是「正在解析」。** 仍显示「正在解析」→ 更像 **job 从未被消费**，不是 P0 文案漏改 |
| 代码热修？ | **否（本轮不做）。** 首选 ops：enable/start worker。次要代码缺口见下（`failOpeningJob` 不投影 `parse-media`）— 文档候选，非本轮 implement |
| 下一 Plan owner | **Data/ops** 先验 hermes worker + DB 积压；若 worker 已跑仍卡 → **Pipeline** 修 `failOpeningJob` / 解析 handler |

---

## 1. UI 路径地图

| 表面 | 文件 | 何时显示「原件已保存，正在解析」 |
|---|---|---|
| Inbox / 材料行标签 | `apps/web/src/features/opening/inbox/upload-state.ts` → `sourceStatusLabel` | `uploadState === "uploaded"` 且 `parseState` 为 `not_started` \| `queued` \| `running`（L53–56）；未知 parseState 也兜底同文案 |
| 轮询 | `source-refresh.ts` → `shouldRefreshSources` | 同上三态时每 ~2s 刷新；**不会**因超时自动改 failed |
| 会话上传条（完成前） | `inbox-panel.tsx` / `upload-strip.tsx` | 客户端队列态 `saved` → **「已保存，正在解析」**（措辞略短；complete 后改看 `sourceStatusLabel`） |
| 对比：上传未完成 | 同 `sourceStatusLabel` | `uploadState !== "uploaded"` → **「上传未完成」**（stuck-pending 另一类问题） |
| 对比：解析失败 | 同文件 | `parseState=failed` → `error.message` 或「原件已保存，解析失败」 |
| 对比：不支持 | 同文件 | `parseState=unsupported` →「原件已保存，暂不能提取文字」 |

**DB ↔ UI**

| DB `opening_sources` | 典型何时写入 | UI |
|---|---|---|
| `upload_state=pending`, `parse_state=not_started` | `create` / begin | 「上传未完成」 |
| `upload_state=uploaded`, `parse_state=queued` | **`completeWithParseJob`** | **「原件已保存，正在解析」** ← Paula 当前最可能 |
| `parse_state=running` | schema 允许；**代码侧未见对 source 写 `running`**（仅 `opening_jobs.state=running`） | 同「正在解析」（若历史/手工有） |
| `parse_state=ready` | `replaceChunks` | 「可以用于提问」 |
| `parse_state=failed` | `markParseState` / `failOpeningJob`（仅 kind=`parse`） | 失败文案 |
| `parse_state=unsupported` | `parse-source` / `parse-media` MIME 分支 | 「暂不能提取文字」 |

配套 job 表：`opening_jobs`（`kind`=`parse`\|`parse-media`，`state` queued→running→succeeded/failed…）；`opening_outbox`（`topic=opening.job.enqueue`，`state` pending→published\|failed）。

---

## 2. 端到端追踪（completeUpload → markParseState）

```
beginUpload (uploadUrl → same-origin /staging @ 7dd1ef8)
  → PUT staging
  → POST complete
       source-service.completeUpload
         head/magic/digest → validateStoredUpload
         sources.completeWithParseJob  ← 单事务
           upload_state=uploaded, parse_state=queued
           INSERT opening_jobs (kind = parse | parse-media by mime)
           INSERT opening_outbox (opening.job.enqueue)
         copyStagingToFinal + delete staging
  → [仅 worker 进程] dispatchPending (1s tick)
       outbox pending → BullMQ queue `opening-{kind}`
  → Worker claim(job) → opening_jobs.state=running
  → handler:
       parse        → parse-source.ts (Docling / md/html / image key / unsupported)
       parse-media  → parse-media.ts (ffprobe + optional whisper)
  → 成功: chunks.replaceChunks → parse_state=ready
  → 显式失败/不支持: sources.markParseState(failed|unsupported, error?)
  → handler throw: repository.finish → failOpeningJob
       **仅 kind==="parse" 时** 把 source 投影为 failed
```

关键文件：

| 步骤 | 路径 |
|---|---|
| complete API | `apps/web/src/app/api/opening/sources/[id]/complete/route.ts` |
| 服务 | `apps/web/src/features/opening/sources/source-service.ts` L89–96 |
| 入队事务 | `packages/database/src/repositories/opening-sources.ts` `completeWithParseJob` L162–189；`parseJobKindForMime` L88–90 |
| Outbox→Redis | `apps/worker/src/runtime/dispatch.ts`；`opening-jobs.ts` `dispatchPending` |
| Claim / finish | `opening-jobs.ts` `claim` / `finish`；`apps/worker/src/runtime/run-job.ts` |
| 文档解析 | `apps/worker/src/jobs/parse-source.ts` |
| 媒体解析 | `apps/worker/src/jobs/parse-media.ts`（P0：`BLOCKED_NOT_CONFIGURED_ERROR` retryable:false） |
| Job 失败投影 | `packages/database/src/repositories/opening-job-failure.ts` L21：`if (job.kind !== "parse" \|\| …) return true` |
| Worker 入口 | `apps/worker/src/index.ts`（queues: parse, parse-media, …；**无** web 进程内 dispatch） |
| Hermes unit | `infra/deploy/aistudy-worker.service`；`deploy-hermes.sh` `restart_services` |

**upload-parse P0 / staging PUT 与 enqueue：**  
- P0（`32be749`）只改 `parse-media` 失败载荷 + UI retry 门闩 + dropzone 诚实文案。  
- Staging PUT（`3c8cca8` / tip 文档 `7dd1ef8`）改 begin `uploadUrl` 同域；**`completeWithParseJob` 未 diff。**  
→ 「上传成功但卡解析」**不是** complete 漏入队；是 **queued 之后无人消费**（或消费失败未回写 source）。

---

## 3. 卡住原因排名（上传已成功之后）

| 秩 | 原因 | 证据 | 预期 DB 形态 | 置信 |
|---|---|---|---|---|
| **1** | **hermes worker 未 enable / 未运行** | `hermes-deployment.md`：Worker「默认 disabled」；`deploy-hermes.sh` 首次安装后 echo `systemctl enable --now`；`restart` **只** `systemctl restart aistudy-web`；web **无** outbox dispatcher | `opening_sources.parse_state=queued`；`opening_jobs.state=queued`；`opening_outbox.state=pending`（久） | **高**（与「所有类型上传后都卡正在解析」最吻合；未 live confirm） |
| **2** | Worker 曾跑但崩溃/停后未启；outbox 已 published 进 Redis 无人消费，或 pending 堆积 | 同 unit；readiness `/api/opening/ai-readiness` 看 stale outbox/queued | outbox `published` 或 `pending`；jobs `queued`；sources `queued` | 中高 |
| **3** | **`failOpeningJob` 不投影 `parse-media`** | L21 仅 `kind === "parse"`；`parse-media` throw → job=`failed`，**source 仍 queued** → UI 仍「正在解析」 | job `failed` + source `queued`（音频/视频） | 中（仅媒体 crash 路径；P0 blocked 路径会 `markParseState(failed)` 故不卡此文案） |
| **4** | Job 进程被杀 / OOM，claim 后 5min 内无人 takeover；source 仍 queued | `claim` 仅 jobs 表；source 无 running 心跳 | job `running` 陈旧；source `queued` | 中（需 worker 曾启动） |
| **5** | Redis/queue 配置错误导致 enqueue 失败 | outbox 行 `state=failed` + payload.error；readiness `failed_outbox` | outbox failed；source 仍 queued | 低–中 |
| **6** | whisper/OCR `blocked_not_configured` 导致 UI 假「正在解析」 | P0 后应 `failed` + 中文；**与当前文案不符** | source `failed` + error.code | **低（排反）** — 若仍见「正在解析」，优先 #1 |
| **7** | Docling/parser 子进程挂死 | 需 worker 日志；parse 并发=1 | job `running`；source `queued` | 低–中（单文件慢 vs 永久卡） |

**与 stuck-pending 的区分：** pending+not_started = 从未 complete（PUT/中断）；本票 = **已 uploaded + queued**，属 worker/消费侧。

---

## 4. Hot-fix 候选（风险；本轮不实施）

| 候选 | 类型 | 动作 | 风险 | 谁做 |
|---|---|---|---|---|
| **A. 启用并启动 worker** | ops | hermes: `systemctl status aistudy-worker`；若 inactive：`systemctl enable --now aistudy-worker`；`journalctl -u aistudy-worker -n 100` | **低–中**：需 `.env.production` 含 `DATABASE_URL`/`REDIS_URL`/S3；首次启可能瞬间消化积压、CPU/内存升高（unit MemoryMax=1024M） | **Data/ops** |
| **B. 确认积压后观察自愈** | ops | 启 worker 后看 outbox pending↓、sources → ready/failed | 低；不手改行 | Data/ops |
| **C. 一行级代码：`failOpeningJob` 含 `parse-media`** | code | `kind !== "parse"` → 允许 `parse \|\| parse-media`（并补测） | 中：改变失败投影语义；需测隐私/version fence；**不解决 worker 未跑** | Pipeline（另 Plan） |
| **D. 手工 SQL 清/改 parse_state** | ops/data | 不推荐作热修；易与 job/outbox 不一致 | **高** | 仅 PM 授权清库 |
| **E. 改 UI 超时变 failed** | code | 掩盖根因 | 高（假失败） | 不做 |

**一票否决「只改 UI / 只改 P0 文案」：** 根因是消费链，不是标签字符串。

**可选一行候选（文档 only，未改仓库）：**  
`opening-job-failure.ts` L21 将 `job.kind !== "parse"` 扩为同时接受 `"parse-media"`。这是次要热修；**不能**替代 enable worker。

---

## 5. Hermes / 箱内如何排查（只读指引；本轮未 SSH）

文档与脚本已有：

```bash
# 本机（有 hermes SSH 密钥时）
bash infra/deploy/deploy-hermes.sh status   # 现只看 aistudy-web + /api/health
ssh root@23.251.32.22 'systemctl status aistudy-worker --no-pager -l | head -20'
ssh root@23.251.32.22 'journalctl -u aistudy-worker -n 80 --no-pager'

# DB（在 hermes，用 .env.production 的库）
# 卡住样本：
SELECT id, name, mime, upload_state, parse_state, error, updated_at
  FROM opening_sources
 WHERE upload_state='uploaded' AND parse_state IN ('queued','running','not_started')
 ORDER BY updated_at DESC LIMIT 30;

SELECT j.id, j.kind, j.state, j.created_at, j.updated_at, j.payload
  FROM opening_jobs j
 WHERE j.kind IN ('parse','parse-media') AND j.state IN ('queued','running')
 ORDER BY j.created_at DESC LIMIT 30;

SELECT id, state, created_at, payload FROM opening_outbox
 WHERE state IN ('pending','failed') ORDER BY created_at DESC LIMIT 30;
```

产品侧：登录后看 **AI readiness**（`apps/web/.../ai-readiness/route.ts`）是否报「超时 outbox / 超时 queued / 失败 outbox」。

箱内：`infra/docker/compose*.yml`、`Dockerfile.opening-worker` 可用于本地对照；**不等价** hermes systemd 是否 enabled。本 Understand **未**要求、也未执行 hermes SSH。

`deploy-hermes.sh logs` 默认只跟 `aistudy-web`；查 parse 必须显式跟 `aistudy-worker`。

---

## 6. 所有权

| 面 | Owner | 职责 |
|---|---|---|
| hermes worker enable/start、Redis、`.env.production`、积压 SQL、是否重启 worker | **Data / ops** | 验证秩 #1/#2；启服务；报告 readiness |
| `completeWithParseJob` / outbox / `failOpeningJob` / parse handlers / queue 注册 | **Pipeline** | 确认 enqueue；修 parse-media 失败投影；parser/whisper 配置文档 |
| Inbox 文案 / 轮询 / retry 按钮 | **Experience**（本票非主因） | 仅在 parse_state 正确后调文案；勿用超时假 failed 掩盖 |
| 是否允许 enable worker、清库 | **PM** | 拍板 ops 热修；授权任何 destructive SQL |

---

## 7. 明确非缺口 / 已正确

- `completeWithParseJob` 后 `parseState=queued`（非 not_started）— RP5 / source-service 测。  
- Staging same-origin PUT 修复的是 **上传到达 MinIO**，不是 parse worker。  
- P0 whisper：`blocked_not_configured` → `failed` + 中文 + 无「重新解析」— **若跑到该代码**不会长期「正在解析」。  
- `parseJobKindForMime`：audio/video → `parse-media`；其余 → `parse`；两队列均在 `createQueues` 中。  
- （旁注，非本票）`extract-study-actions` 在 handlers 中但 **未**进 `createQueues` — 另缺口；不影响 parse/parse-media。

---

## 8. 建议下一步（不实施）

1. **Data/ops（立即）：** hermes `systemctl status aistudy-worker` + 上表 SQL + ai-readiness；若 inactive → PM 批准后 `enable --now`，观察积压消化。  
2. **若 worker active 仍卡：** 按 mime 分流 — 文档看 Docling/parser 日志；媒体看是否 job=`failed` 且 source 仍 `queued`（确认缺口 #3）→ Pipeline Plan 扩 `failOpeningJob`。  
3. **Pipeline Plan（可选）：** `failOpeningJob` 覆盖 `parse-media` + 测；deploy 文档写明 worker 为 Opening 解析硬依赖（status/logs 带上 worker）。  
4. **不做：** 本 Understand 不改代码、不 commit/push、不清库、不假 UI 超时。


---

## Addendum — live hermes（PM，2026-10-10 ~22:18 CST）

**Verdict override:** `#1 worker 未启用` **已推翻**。

- `aistudy-worker` **active**
- 积压主因：**Docling 慢** + **MemoryMax=1G** 限流/重启压力
- PM 抬 worker 内存观察消化
- 可选后续（Pipeline，未授权）：job 领取时 source `parse_state=running` / 进度文案；`failOpeningJob` 投影 `parse-media`
