"use client";

import type { WeekSession } from "@aistudy/contracts";
import { useCallback, useRef, useState, type ChangeEvent } from "react";
import { buttonClass, inputClass, secondaryButtonClass } from "../design/ui";
import { parseTimetableFile, type ParsedTimetable } from "./xlsx-reader";
import { userFacingMessage } from "../../../lib/user-facing-error";
import { defaultPutTimetable, readTimetable, sameTimetable } from "./timetable-client";

const WEEKDAY_LABELS = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;

export type TimetablePut = (sessions: WeekSession[]) => Promise<WeekSession[]>;

type Preview = { fileName: string; parsed: ParsedTimetable; revision: string };

export type TimetableImportState =
  | { phase: "idle" }
  | ({ phase: "preview" | "saving" } & Preview)
  | { phase: "saved"; count: number }
  | { phase: "error"; message: string; preview?: Preview; needsRead?: boolean };

/** Cancel discards preview only — never writes timetable. */
export function cancelTimetablePreview(): TimetableImportState {
  return { phase: "idle" };
}

/**
 * Writes sessions only when called. Preview/cancel paths must not call this.
 */
export async function confirmTimetableImport(
  sessions: WeekSession[],
  put: TimetablePut,
): Promise<{ ok: true; sessions: WeekSession[] } | { ok: false; message: string }> {
  try {
    const saved = await put(sessions);
    return { ok: true, sessions: saved };
  } catch (reason) {
    return { ok: false, message: userFacingMessage(reason, "课表保存失败，请重试。") };
  }
}

export function previewSessionRows(sessions: WeekSession[]): Array<{
  courseName: string;
  weekdayLabel: string;
  weeksLabel: string;
  periodLabel: string;
}> {
  return sessions.map((session) => ({
    courseName: session.courseName,
    weekdayLabel: WEEKDAY_LABELS[session.weekday] ?? `星期${session.weekday}`,
    weeksLabel: formatWeeks(session.weeks),
    periodLabel: session.startPeriod === session.endPeriod
      ? `第 ${session.startPeriod} 节`
      : `第 ${session.startPeriod}–${session.endPeriod} 节`,
  }));
}

function formatWeeks(weeks: number[]): string {
  if (!weeks.length) return "—";
  const sorted = [...weeks].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0]!;
  let prev = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const week = sorted[i]!;
    if (week === prev + 1) {
      prev = week;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = week;
    prev = week;
  }
  parts.push(start === prev ? `${start}` : `${start}-${prev}`);
  return `${parts.join(",")} 周`;
}

export function TimetableImport({ put = defaultPutTimetable }: { put?: typeof defaultPutTimetable }) {
  const [state, setState] = useState<TimetableImportState>({ phase: "idle" });
  const [busy, setBusy] = useState(false);

  const onFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setState({ phase: "idle" });
    let fallback = "无法读取课表文件，请选择有效的 xlsx。";
    try {
      const parsed = await parseTimetableFile(file);
      fallback = "暂时无法读取已保存的课表，请稍后重新选择文件。";
      const { revision } = await readTimetable();
      setState({ phase: "preview", fileName: file.name, parsed, revision });
    } catch (reason) {
      setState({
        phase: "error",
        message: userFacingMessage(reason, fallback),
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const preview = state.phase === "preview" || state.phase === "saving" ? state
    : state.phase === "error" ? state.preview : undefined;
  const saving = useRef(false);

  async function onConfirm() {
    if (!preview || busy || saving.current) return;
    saving.current = true;
    const { fileName, parsed, revision } = preview;
    setBusy(true);
    setState({ phase: "saving", fileName, parsed, revision });
    try {
      let retryMessage = "已核对课表，可以重新确认保存。";
      if (!(state.phase === "error" && state.needsRead)) {
        const result = await confirmTimetableImport(parsed.sessions, rows => put(rows, revision));
        if (result.ok) {
          setState({ phase: "saved", count: result.sessions.length });
          return;
        }
        retryMessage = result.message;
      }
      const current = await readTimetable();
      if (sameTimetable(current.sessions, parsed.sessions)) {
        setState({ phase: "saved", count: current.sessions.length });
      } else if (current.revision !== revision) {
        setState({ phase: "error", message: "课表已更新，请核对最新课表后重新选择文件。" });
      } else {
        setState({ phase: "error", message: retryMessage, preview });
      }
    } catch {
      setState({ phase: "error", message: "暂时无法核对保存结果，请稍后再核对。", preview, needsRead: true });
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  function onCancel() {
    if (busy) return;
    setState(cancelTimetablePreview());
  }

  return (
    <section className="space-y-3" aria-labelledby="timetable-import-heading">
      <div>
        <h3 className="text-sm font-medium text-text" id="timetable-import-heading">导入课表</h3>
        <p className="mt-1 text-xs leading-6 text-text-3">
          在本地读取 xlsx 并预览。确认后才保存到课表；原始文件不会上传到对象存储。
        </p>
      </div>
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-text-2">选择 xlsx 文件</span>
        <input
          aria-label="选择课表 xlsx 文件"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className={inputClass}
          disabled={busy}
          onChange={(event) => void onFile(event)}
          type="file"
        />
      </label>
      {state.phase === "error" ? (
        <p className="text-xs leading-5 text-danger" role="alert">{state.message}</p>
      ) : null}
      {state.phase === "saved" ? (
        <p className="text-xs leading-5 text-accent" role="status">已保存 {state.count} 条课表会话。</p>
      ) : null}
      {preview ? (
        <div className="space-y-3 rounded-lg border border-line bg-bg/80 p-3">
          <p className="text-xs text-text-2">
            预览：{preview.fileName} · {preview.parsed.sessions.length} 条课程
            {preview.parsed.warnings.length ? ` · ${preview.parsed.warnings.length} 条需核对` : ""}
          </p>
          {preview.parsed.sessions.length ? (
            <div className="max-h-48 overflow-y-auto">
              <table className="w-full text-left text-xs text-text-2">
                <thead>
                  <tr className="border-b border-line text-text-3">
                    <th className="py-1 pr-2 font-medium">课程</th>
                    <th className="py-1 pr-2 font-medium">星期</th>
                    <th className="py-1 pr-2 font-medium">周次</th>
                    <th className="py-1 font-medium">节次</th>
                  </tr>
                </thead>
                <tbody>
                  {previewSessionRows(preview.parsed.sessions).map((row, index) => (
                    <tr key={`${row.courseName}-${row.weekdayLabel}-${index}`} className="border-b border-line">
                      <td className="py-1.5 pr-2">{row.courseName}</td>
                      <td className="py-1.5 pr-2">{row.weekdayLabel}</td>
                      <td className="py-1.5 pr-2">{row.weeksLabel}</td>
                      <td className="py-1.5">{row.periodLabel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-warn">未能解析出有效课程行，请检查表格列（课程/星期/周次/节次）。</p>
          )}
          {preview.parsed.warnings.length ? (
            <details className="text-xs text-warn">
              <summary className="cursor-pointer py-1">解析警告 · {preview.parsed.warnings.length}</summary>
              <ul className="mt-1 max-h-24 space-y-1 overflow-y-auto">
                {preview.parsed.warnings.slice(0, 20).map((warning) => (
                  <li key={`${warning.sheet}-${warning.address}-${warning.raw}`}>
                    {warning.sheet}!{warning.address}: {warning.raw}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={busy || !preview.parsed.sessions.length}
              onClick={() => void onConfirm()}
            >
              {busy ? "正在处理…" : state.phase === "error" && state.needsRead ? "核对保存结果" : "确认加入课表"}
            </button>
            <button type="button" className={secondaryButtonClass} disabled={busy} onClick={onCancel}>
              取消预览
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
