# 智学课 → Notion AI Meeting 自动转写流水线

> 适用：数学 I（智学北航）完整教师音频 → Notion **AI Meeting Notes** 自动转写/摘要
> 课次样例：`sub_id=6108854`（2026-09-15，约 99m15s）
> 更新：2026-09-21

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

- [ ] 音频时长 ≈ 全课（样例课 ~99 分钟），不是切片
- [ ] 通过 **Meeting Notes → Upload audio** 上传（不是普通文件块）
- [ ] Meeting 内出现 **Transcript**（或 API `status` 到就绪态）
- [ ] 不是「页面能播放附件但 Transcript 为空」

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

- 小文件：单段上传
- **> 20MB**：multipart 分片

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

> API 字段名可能随 Notion-Version 微调；以官方文档为准。大文件请改 multipart 分片流程。

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

## 6. 与本仓库的关系

本说明放在 `study-assistant-opening`，供 Opening / 学习助手流水线复用：

- 课次索引、Notion Mathematics I hub、Recordings DB 可链到 Meeting 页
- 自动化优先：本机脚本（第 3 节）或人工 Upload audio（第 2 节）
- 不要把「本机 Whisper 草稿贴进笔记」当成 Meeting 自动转写的完成态（可作离线备份）

---

## 7. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-09-21 | 初版：根据 6108854 全课音频实践整理；确认 MCP 附件 ≠ Meeting Upload audio |
