# 智学课 → Notion AI Meeting 自动转写流水线

> 适用：数学 I（智学北航）完整教师音频 → Notion **AI Meeting Notes** 自动转写/摘要
> 课次样例：`sub_id=6108854`（2026-09-15，约 99m15s）
> 更新：2026-09-23

---

## 0. 一句话结论

**自动转写必须走 Meeting Notes 块的「Upload audio」。**
把音频当普通页面附件 / `<audio>` 块塞进去，**不会**触发 Notion AI Meeting 转写。

正确链路：

```
智学教师流 → 完整音频 (.m4a) → Notion「AI Meeting Notes」→ Upload audio → 自动转写 + 摘要
```

---

## 1. 目标与验收

### 目标

1. 拿到**整节课**教师音频（不可用 1 分钟试听片当交付）。
2. 用 Notion **Meeting Notes → Upload audio** 上传。
3. 等 Notion 自动生成 **Transcript**（及可选 Summary）。

### 验收清单

- [x] 音频时长 ≈ 全课（样例课 ~99 分钟），不是切片
- [x] 通过 **Meeting Notes → Upload audio** 上传（不是普通文件块）
- [x] Meeting 内出现可读的原生 **Transcript**
- [x] 不是「页面能播放附件但 Transcript 为空」

> **硬门槛：** 音频播放、Summary、排队中的任务、`NOTION_UPLOADED`、普通 File Upload 对象或本地 Whisper 文本都不算完成；必须选中 Meeting 的 Transcript tab，并读取到带时间戳的可读原生文本。

---

## 2. Notion 界面步骤（本地手操，最稳）

官方行为（Notion Help + 实测）：

1. 打开带 **Meeting Notes / AI Meeting Notes** 的页面
   - 新建：页面输入 `/meet` 或 `/meeting`
2. 点击该 Meeting Notes 块**顶部的设置 / 滑块图标**
   （不是页面右上角 ···）
3. 选择 **Upload audio**
4. 选择本地音频文件
5. 上传后 Notion 自动 **Transcribe**，并生成 summary（与现场录制相同）

### 格式

| 支持 | 不支持 |
|------|--------|
| AAC / M4A / MP3 / WAV | MOV / MP4 / Loom（视频勿直接丢） |

### 相关页面（样例）

- Meeting 页：`https://app.notion.com/p/3e2f3b2fe60f8106af39f48327cf2574`
- 试验页（普通 audio 块，**不会**自动转写，可删）：
  `https://app.notion.com/p/3e2f3b2fe60f811584f7ca5f7de9d7d6`

### 最短复刻（约 5 分钟）

1. 准备完整 `.m4a`（见第 4 节）
2. 打开 Meeting 页 → 块设置 → **Upload audio** → 选文件
3. 等转写中 / 完成
4. 在 Meeting 的 Transcript / Summary 查看结果

若网页上传失败：用 64–96 kbps AAC 压小再传（**时长仍须完整**，禁止切段当交付）。

---

## 3. Notion Public API（脚本可选）

需要：Integration Token（`secret_...` / `ntn_...`），且账号开通 AI Meeting Notes。

> Grok Bot 的 Notion **MCP** 可建页、传附件，但**未暴露** `blocks/meeting_notes`；MCP 塞的 audio 块 ≠ Upload audio。本地要用 Public API 或网页 Upload audio。

### 3.1 创建文件上传对象

```http
POST https://api.notion.com/v1/file_uploads
Authorization: Bearer <NOTION_TOKEN>
Notion-Version: 2026-03-11
Content-Type: application/json
```

- 普通 Public API File Upload 的实测边界为 `5 MiB / 5,242,880` bytes；该路径与浏览器 Meeting UI 不是同一个上传契约。
- 完整课音频的 Public API multipart / 分片 / `external_url` 方案尚未在有效授权下验证；不要把浏览器 UI 的 `26,214,400`-byte 通过结果外推到 API。

### 3.2 发送文件字节

```http
POST https://api.notion.com/v1/file_uploads/{file_upload_id}/send
Authorization: Bearer <NOTION_TOKEN>
Notion-Version: 2026-03-11
Content-Type: multipart/form-data
```

表单字段：`file` = 音频二进制。
`.m4a` 建议 Content-Type：`audio/mp4`。

等到 upload 对象 `status = uploaded`。

### 3.3 创建 Meeting Note 并启动处理

```http
POST https://api.notion.com/v1/blocks/meeting_notes
Authorization: Bearer <NOTION_TOKEN>
Notion-Version: 2026-03-11
Content-Type: application/json
```

```json
{
  "parent": {
    "type": "page_id",
    "page_id": "<目标页 UUID>"
  },
  "source": {
    "type": "file_upload",
    "file_upload_id": "<上一步 upload id>"
  },
  "title": "数学I · 2026-09-15 · 6108854",
  "language": "auto",
  "options": {
    "kickoff_summary": true
  }
}
```

文档：https://developers.notion.com/reference/create-a-meeting-note

### 3.4 轮询状态

```http
GET https://api.notion.com/v1/blocks/{meeting_note_block_id}
Authorization: Bearer <NOTION_TOKEN>
Notion-Version: 2026-03-11
```

关注 `meeting_notes.status`（例如转写中 → 就绪；具体枚举以当前 API 文档为准）。

### 3.5 curl 骨架（填 Token 与 page_id）

```bash
export NOTION_TOKEN='secret_xxx'
export PAGE_ID='xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
export AUDIO='./teacher_full.m4a'
export NOTION_VERSION='2026-03-11'

# 1) create file upload（字段名以当前 API 为准，可能需 mode/filename）
UPLOAD_JSON=$(curl -sS -X POST 'https://api.notion.com/v1/file_uploads' \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: $NOTION_VERSION" \
  -H 'Content-Type: application/json' \
  -d '{"filename":"teacher_full.m4a","content_type":"audio/mp4"}')
echo "$UPLOAD_JSON"
FILE_UPLOAD_ID=$(echo "$UPLOAD_JSON" | jq -r .id)

# 2) send bytes
curl -sS -X POST "https://api.notion.com/v1/file_uploads/${FILE_UPLOAD_ID}/send" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: $NOTION_VERSION" \
  -F "file=@${AUDIO};type=audio/mp4;filename=teacher_full.m4a"

# 3) create meeting note
curl -sS -X POST 'https://api.notion.com/v1/blocks/meeting_notes' \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: $NOTION_VERSION" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parent\": {\"type\": \"page_id\", \"page_id\": \"${PAGE_ID}\"},
    \"source\": {\"type\": \"file_upload\", \"file_upload_id\": \"${FILE_UPLOAD_ID}\"},
    \"title\": \"数学I · lecture\",
    \"language\": \"auto\",
    \"options\": {\"kickoff_summary\": true}
  }"
```

> API 字段名可能随 Notion-Version 微调；以官方文档为准。由于当前 token/plan 未能授权验证完整课的大文件 API 路径，本节 curl 仅是未验证骨架，不是本次验收路线。

---

## 4. 音频从哪来

### 样例课元数据

| 项 | 值 |
|----|-----|
| 平台 | 智学北航 / MSA classroom |
| `course_id` | `163730` |
| `sub_id` | `6108854` |
| 时长 | ≈ **99m15s**（~5955s） |
| CDN | `hzresource.msa.buaa.edu.cn` 教师 firm MP4（需登录后签名 URL） |

### 盒子上已有文件（若仍保留）

| 文件 | 说明 |
|------|------|
| `/workspace/msa_capture/full/6108854/teacher_full.m4a` | 完整 AAC，约 62MB |
| `/workspace/msa_capture/full/6108854/teacher_full_24k.m4a` 或 `meeting_upload.m4a` | ~17MB，24kbps，时长完整，更适合上传 |

### 本机从智学拉取（CDN 需本机网络可达）

1. 浏览器打开 livingroom，登录智学
2. DevTools → Network，抓教师
   `https://hzresource.msa.buaa.edu.cn/.../*.mp4?clientUUID=...&t=...`
3. **在能访问该 CDN 的机器上**用 Range 下完整 MP4
   （部分云主机 / 沙箱对 hzresource TLS 会断，不要假设到处都能下）
4. 抽音频：

```bash
ffmpeg -i teacher_full.mp4 -vn -c:a aac -b:a 128k teacher_full.m4a
# 或更小体积（仍保持完整时长）
ffmpeg -i teacher_full.mp4 -vn -c:a aac -b:a 64k teacher_full_64k.m4a
```

5. 将 `.m4a` 走第 2 节 Upload audio（或第 3 节 API）

---

## 5. 架构对照：什么行、什么不行

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│ 智学 CDN MP4    │────▶│ 完整 .m4a            │────▶│ Meeting Upload audio│
│ (签名 URL)      │     │ (本机或可达机器下载)   │     │ → 自动 Transcript    │
└─────────────────┘     └──────────────────────┘     └─────────────────────┘
                                      │
                                      │ 错误支路
                                      ▼
                            ┌──────────────────────┐
                            │ 普通页面附件 / audio │  ← 可播放，但不自动转写
                            │ MCP 塞文件块         │
                            └──────────────────────┘
```

| 能力 | MCP（当前 Bot） | 网页 Upload audio | Public API meeting_notes |
|------|-----------------|-------------------|---------------------------|
| 建页 / 写笔记 | ✅ | ✅ | ✅ |
| 上传为普通附件 | ✅ | ✅ | ✅ |
| **触发 AI Meeting 自动转写** | ❌（未暴露） | ✅ | ✅（需 Token） |

---

## 6. 已验证的完整源与可恢复 CLI

### 6.1 完整源与准备产物

本课使用的完整源是 `E:/Mathematics I/recordings/6108854/teacher_full.mp4`，不是试听片段、分段文件或截断文件：

| 项 | 实测值 |
|----|--------|
| 完整源字节数 | `1,573,588,400` |
| 完整源时长 | `5955.01s`（约 99m15s） |
| 准备命令 | `-map 0:a:0 -vn -ac 1 -ar 16000 -c:a aac -b:a 32k -movflags +faststart` |
| Meeting 输入 | `24,248,496` bytes，`5954.983s` |
| 音频 profile | AAC LC，16 kHz，mono，约 32 kbps |
| 准备产物 SHA-256 | `b2137e72cc4094997dfc271b98042b8af919e6f9c2b62ec90d5f5c53ccf97c4f` |

时长校验容差为 15 秒；准备产物必须保持 16 kHz mono AAC profile，且小于实测浏览器边界 `26,214,400` bytes（达到边界即拒绝）。浏览器 UI 边界与普通 Public API File Upload 的 `5 MiB / 5,242,880` bytes 边界是两个不同契约，不能互相推断。

### 6.2 CLI 边界与恢复语义

独立 CLI 位于 `scripts/notion-meeting-pipeline.mjs`，命令为 `prepare`、`upload`、`verify`、`run`、`status`。它使用版本化的 `manifest.json` 和独占 `pipeline.lock`：

- 先流式 hash、ffprobe 检查完整时长，再原子替换转换产物；复用产物前重新校验 hash、字节数、时长和音频 profile。
- 在文件选择前写入 upload intent；已记录 task 会轮询 `/api/v3/getTasks`，不会再次上传；任务失败必须显式 `--retry-failed`，且仍要求操作者先检查并干净重置 disposable Meeting。
- `enqueueTask` 的 HTTP 200 和 `getTasks: in_progress` 只是中间态；只有 task success 后再通过 Transcript tab、文本可读性和尾部时间戳覆盖校验，才进入 `verified`。
- 默认只允许 `Meeting-<32 hex>` disposable 页面；真实页面和 block 必须以精确 pair 且显式 override 才能操作。真实目标在本次 CLI 验证中未修改。
- `--dry-run` 只做本地 source/prepared 校验，不创建 manifest、不下载远程源、不打开浏览器、不产生 Notion mutation。

一次完整 CLI disposable 验证使用独立浏览器 profile 完成：

```bash
node scripts/notion-meeting-pipeline.mjs prepare ...
node scripts/notion-meeting-pipeline.mjs upload --no-wait ...
node scripts/notion-meeting-pipeline.mjs upload ...
node scripts/notion-meeting-pipeline.mjs verify ...
```

结果为 `stage=verified`、task `success`、原生 Transcript `140` 个时间戳、最后时间戳 `5779s`，相对 `5955.01s` 的尾部差约 `176s`，在 180 秒验收容差内。导出的本地 artifact 为 45,655 bytes，SHA-256 为 `277e28c0967a826c5d3cae78bb4f69430c805f6dd7bac1e23ee60459f8ff260b`；对应的脱敏 timeline 与 hash sidecar 保存在 `.tmp/notion-full-lecture-task-timeline.json`、`.tmp/notion-full-lecture-native-transcript.sha256`。这些文件仅作为本地证据，不回写 Notion 代替原生 Transcript。

### 6.3 当前外部边界与阻塞

- 当前 API Connection 位于另一 Notion workspace；目标 workspace 页面对该 bot 返回 `object_not_found`。
- 现有 API token 探针返回 HTTP 401 `API token is invalid.`，因此 Public API 的完整音频 multipart / `single_part`、`multi_part` 和 `external_url` 行为仍未被授权验证。
- 当前 plan 的直接 `POST /v1/blocks/meeting_notes` 返回 AI Meeting Notes 未启用；因此本实现选择已证明的浏览器 Upload audio 路径。
- ffmpeg/ffprobe 仍是 CLI 外部可配置 executable，不把二进制加入 npm 依赖；Worker/plugin、数据库 migration、通用 parser 和 web request lifecycle 尚未接入。

## 7. 与本仓库的关系

本说明放在 `study-assistant-opening`，供 Opening / 学习助手流水线复用：

- 课次索引、Notion Mathematics I hub、Recordings DB 可链到 Meeting 页
- 自动化优先：本机脚本（第 3 节）或人工 Upload audio（第 2 节）
- 不要把「本机 Whisper 草稿贴进笔记」当成 Meeting 自动转写的完成态（可作离线备份）

---

## 8. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-09-21 | 初版：根据 6108854 全课音频实践整理；确认 MCP 附件 ≠ Meeting Upload audio |
| 2026-09-23 | 完成 disposable CLI `prepare → upload → resume/poll → verify` 验证；原生 Transcript 作为唯一硬门槛 |
