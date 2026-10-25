# 2026-10-25 数据修复与卡住任务对账

## 1. 讲义标题回填（迁移 0099）

`0099_opening_teaching_unit_titles.sql` 把仍是占位名 `Teaching draft <activity id 前 8 位>` 的讲义文档（`library_documents.title` 与 `opening_teaching_units.title`）改为对应学习活动 `intent_summary` 的第一行（去首尾空白，≤120 字符，空则 `学习讲义`）。

- 只改完全等于占位名的行：学习者改过的标题不动；重复执行无变化。
- 活动解析：先经 `opening_teaching_activity_specs`，未发布的讲义按同一用户/工作区内唯一的活动 ID 前缀匹配；解析不到的保持原名。
- `library_revisions` 只追加，不改：历史修订仍是占位名，也是回滚依据（迁移文件末尾有手工回滚 SQL）。`updated_at` 不变。

随正常发布执行：`DATABASE_URL="$DATABASE_URL" npm run db:migrate`。执行前后可核对：

```sql
SELECT count(*) FROM library_documents d JOIN opening_teaching_units u ON u.document_id = d.id
WHERE d.title ~ '^Teaching draft [0-9a-f]{8}$';
```

执行后剩余行数应只包含无法解析到活动的讲义。

## 2. 已存储 LaTeX 控制字符修复

旧版 `JSON.parse` 把模型输出的单反斜杠 LaTeX 解成控制字符（`\times`→TAB+`imes`，`\frac`→FF+`rac`，`\beta`→BS+`eta`，`\neq`→LF+`eq`，`\right`→CR+`ight`）。

```bash
# 只读预演（默认）：打印每张表的 scanned/affected/repairs 与少量样例
DATABASE_URL="$DATABASE_URL" npx tsx scripts/opening-repair-latex-escapes.ts
# 样例含学习内容；只看计数：
DATABASE_URL="$DATABASE_URL" npx tsx scripts/opening-repair-latex-escapes.ts --no-samples
# 确认后写入（幂等，第二次 affected 应为 0）
DATABASE_URL="$DATABASE_URL" npx tsx scripts/opening-repair-latex-escapes.ts --apply
# 可选：--workspace <uuid> 只处理一个工作区
```

- 写入：讲义文档当前块 `library_blocks.content`、AI 批改 `opening_learning_observations.ai_evaluation`；按读到的旧值做比较写入，并发修改的行不覆盖。
- `library_revisions`（讲解实际固定读取的修订）只追加，脚本只计数；服务端在 client-init 与参考答案读取时做同样的修复。
- 规则保守：只修复“控制字符 + 已知 LaTeX 命令的其余字母”整词；`$…$` 外的换行/制表符不修 `\ne`、`\nu`、`\to`、`\tan`、`\top`、`\tag`、`\nmid` 这类可能是正文的短词。

## 3. 卡住的生成与回答任务

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `OPENING_TEACHING_GENERATE_STALE_MS` | 900000 | 讲解生成任务排队超时或运行中无心跳超过该值，标记失败，界面出现“重新生成”。任务缺失或已结束则立即对账。 |
| `OPENING_TUTOR_JOB_STALE_MS` | 600000 | 回答任务排队从未被领取超过该值，以 `TUTOR_JOB_STALE` 失败（未产生调用）；运行中无心跳记为 `outcome_unknown`，不自动重发。 |

Web 在读取恢复状态 / 回答任务时对单条做对账，Worker 每 60 秒批量兜底。无需手工操作。
