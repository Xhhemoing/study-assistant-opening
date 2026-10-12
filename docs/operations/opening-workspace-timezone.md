# 工作区时区（planning_settings.timeZone）非法值处置

适用：PR-B（fix/local-day-bounds）之后。

## 行为

- 业务“今天”一律按工作区 `workspace_preferences.planning_settings.timeZone` 计算（缺省 `Asia/Shanghai`），使用 `resolveLocalDayBounds` 半开区间 `[dayStart, nextDayStart)`；不使用进程/浏览器时区，不做固定小时偏移。
- 非空但不是合法 IANA 时区的值，各调用方**显式失败**（`RangeError: invalid timeZone: <值>`），不会静默回落到默认时区：
  - 复习队列（cards-ops / review-service）、Today 页面：该请求报错。
  - worker 提醒（remind）：该任务以 `failed` 结束，结果里记录错误信息；同批其他 workspace 的任务照常执行。
  - 提醒入队（opening-reminders）：该请求报错，不影响其他 workspace。
  - AI 预算预留（opening-budget）：该次预留报错且不写入预留记录，不影响其他 workspace。
- 写入端：保存 planning settings 时校验时区，非法值返回 `VALIDATION`，不会再写入新的非法值。

## 存量非法值的处置（不改数据）

1. **不做自动修复或批量改写**，不重写历史数据。
2. 排查（只读）：

   ```sql
   SELECT workspace_id, planning_settings->>'timeZone' AS tz
   FROM workspace_preferences
   WHERE planning_settings ? 'timeZone';
   ```

   将结果中的 `tz` 与 `Intl.supportedValuesOf('timeZone')`（或 `pg_timezone_names`）比对，找出非法值。
3. 观测信号：worker 任务 `failed` 且错误含 `invalid timeZone:`；Web 请求日志同一报错。
4. 修复路径：由该 workspace 的用户在“规划设置”页重新选择合法时区并保存（写入端会校验）。运维不代改用户数据。
5. 修复后，失败的提醒需按既有流程重新入队；已确认的计划不受影响，未确认的自动草稿会在下次读取 Today 时按新时区重算。
