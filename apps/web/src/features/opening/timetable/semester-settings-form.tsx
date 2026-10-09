"use client";

import {
  DEFAULT_OPENING_PLANNING_SETTINGS,
  openingPlanningSettingsResponseSchema,
  openingPlanningSettingsSchema,
  type OpeningPlanningSettings,
  type OpeningPlanningSettingsResponse,
} from "@aistudy/contracts";
import { LoaderCircle, RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { buttonClass, inputClass, secondaryButtonClass, ui } from "../design/ui";

/** Common 45-minute period template (editable after apply). */
export const PERIOD_45MIN_TEMPLATE: OpeningPlanningSettings["periodTimes"] = {
  "1": { start: "08:00", end: "08:45" },
  "2": { start: "08:55", end: "09:40" },
  "3": { start: "10:00", end: "10:45" },
  "4": { start: "10:55", end: "11:40" },
  "5": { start: "14:00", end: "14:45" },
  "6": { start: "14:55", end: "15:40" },
  "7": { start: "16:00", end: "16:45" },
  "8": { start: "16:55", end: "17:40" },
  "9": { start: "19:00", end: "19:45" },
  "10": { start: "19:55", end: "20:40" },
};

export function blankSemesterDraft(timeZone = "Asia/Shanghai"): OpeningPlanningSettings {
  return {
    ...DEFAULT_OPENING_PLANNING_SETTINGS,
    weekOneMonday: "",
    periodTimes: { ...PERIOD_45MIN_TEMPLATE },
    timeZone,
  };
}

export function applyPeriodTemplate(draft: OpeningPlanningSettings): OpeningPlanningSettings {
  return { ...draft, periodTimes: { ...PERIOD_45MIN_TEMPLATE } };
}

export function periodEntries(periodTimes: OpeningPlanningSettings["periodTimes"]): Array<{
  period: string;
  start: string;
  end: string;
}> {
  return Object.keys(periodTimes)
    .sort((a, b) => Number(a) - Number(b))
    .map((period) => ({
      period,
      start: periodTimes[period]!.start,
      end: periodTimes[period]!.end,
    }));
}

export function validateSemesterDraft(draft: OpeningPlanningSettings): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.weekOneMonday)) {
    return "请填写学期第一周的周一日期（YYYY-MM-DD）。";
  }
  const utc = new Date(`${draft.weekOneMonday}T00:00:00Z`);
  if (Number.isNaN(utc.getTime()) || utc.getUTCDay() !== 1) {
    return "第一周周一必须是星期一。";
  }
  if (!Object.keys(draft.periodTimes).length) {
    return "请至少配置一节课的时间。";
  }
  const parsed = openingPlanningSettingsSchema.safeParse(draft);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return first?.message ?? "学期设置校验失败。";
  }
  return null;
}

export async function loadPlanningSettings(signal?: AbortSignal): Promise<OpeningPlanningSettingsResponse> {
  const response = await fetch("/api/opening/planning-settings", { cache: "no-store", signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof (body as { error?: { message?: string } }).error?.message === "string"
      ? (body as { error: { message: string } }).error.message
      : "学期设置暂时无法读取，请重试。";
    throw new Error(message);
  }
  return openingPlanningSettingsResponseSchema.parse(body);
}

export async function savePlanningSettings(
  settings: OpeningPlanningSettings | null,
): Promise<OpeningPlanningSettingsResponse> {
  const response = await fetch("/api/opening/planning-settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof (body as { error?: { message?: string } }).error?.message === "string"
      ? (body as { error: { message: string } }).error.message
      : "学期设置保存失败，请重试。";
    throw new Error(message);
  }
  return openingPlanningSettingsResponseSchema.parse(body);
}

function RangeFields({
  label,
  start,
  end,
  disabled,
  onChange,
}: {
  label: string;
  start: string;
  end: string;
  disabled: boolean;
  onChange: (next: { start: string; end: string }) => void;
}) {
  return (
    <fieldset className="grid gap-2 sm:grid-cols-[6rem_1fr_1fr]" disabled={disabled}>
      <legend className="sr-only">{label}</legend>
      <span className="flex items-center text-xs text-zinc-600">{label}</span>
      <label className="block space-y-1">
        <span className={ui.label}>开始</span>
        <input
          aria-label={`${label}开始`}
          className={inputClass}
          type="time"
          value={start}
          onChange={(event) => onChange({ start: event.target.value, end })}
        />
      </label>
      <label className="block space-y-1">
        <span className={ui.label}>结束</span>
        <input
          aria-label={`${label}结束`}
          className={inputClass}
          type="time"
          value={end}
          onChange={(event) => onChange({ start, end: event.target.value })}
        />
      </label>
    </fieldset>
  );
}

export function SemesterSettingsForm() {
  const [data, setData] = useState<OpeningPlanningSettingsResponse | null>(null);
  const [draft, setDraft] = useState<OpeningPlanningSettings>(() => blankSemesterDraft());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const receive = useCallback((next: OpeningPlanningSettingsResponse) => {
    setData(next);
    setDraft(next.settings ?? blankSemesterDraft());
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      receive(await loadPlanningSettings(signal));
    } catch (failure) {
      if (!signal?.aborted) {
        setError(failure instanceof Error ? failure.message : "学期设置暂时无法读取，请重试。");
      }
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }, [receive]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function onSave() {
    if (busy) return;
    const validation = validateSemesterDraft(draft);
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const parsed = openingPlanningSettingsSchema.parse(draft);
      receive(await savePlanningSettings(parsed));
      setNotice("学期设置已保存（跨端一致，不使用本地缓存）。");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "学期设置保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  async function onClear() {
    if (busy) return;
    if (!window.confirm("确定清除学期设置？清除后需重新配置才能按课表空档排程。")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      receive(await savePlanningSettings(null));
      setNotice("学期设置已清除。");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "清除失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  const entries = periodEntries(draft.periodTimes);

  return (
    <div className="space-y-4" aria-labelledby="semester-settings-heading">
      <div>
        <h3 className="text-sm font-medium text-zinc-900" id="semester-settings-heading">学期与可用时间</h3>
        <p className="mt-1 text-xs leading-6 text-zinc-500">
          第一周周一、节次时间与每日窗口保存在服务端，供按建议排程推导空闲时间。默认每日 07:30–22:30，午餐 12:00–13:00，晚餐 17:30–18:30，睡眠 23:00–07:00。
        </p>
      </div>
      {data?.invalidStoredSettings ? (
        <p className="text-sm text-amber-800" role="alert">已保存的学期设置无效，请重新填写后保存。</p>
      ) : null}
      {error ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-3" role="alert">
          <p className="text-sm text-red-700">{error}</p>
          <button className={secondaryButtonClass} onClick={() => void load()} type="button" disabled={busy}>
            <RefreshCw aria-hidden size={14} />重新读取
          </button>
        </div>
      ) : null}
      <fieldset disabled={busy} className="space-y-4">
        <label className="block space-y-1.5">
          <span className={ui.label}>学期第一周周一</span>
          <input
            aria-label="学期第一周周一"
            className={inputClass}
            type="date"
            value={draft.weekOneMonday}
            onChange={(event) => setDraft({ ...draft, weekOneMonday: event.target.value })}
          />
        </label>
        <label className="block space-y-1.5">
          <span className={ui.label}>时区</span>
          <input
            aria-label="时区"
            className={inputClass}
            value={draft.timeZone}
            onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })}
          />
        </label>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-medium text-zinc-800">节次时间（45 分钟模板可编辑）</h4>
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => setDraft(applyPeriodTemplate(draft))}
            >
              套用 45 分钟模板
            </button>
          </div>
          <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-zinc-200 p-2">
            {entries.map(({ period, start, end }) => (
              <div key={period} className="grid grid-cols-[3rem_1fr_1fr_auto] items-end gap-2">
                <span className="pb-2 text-xs text-zinc-500">第{period}节</span>
                <label className="block space-y-1">
                  <span className="sr-only">第{period}节开始</span>
                  <input
                    aria-label={`第${period}节开始`}
                    className={inputClass}
                    type="time"
                    value={start}
                    onChange={(event) => setDraft({
                      ...draft,
                      periodTimes: {
                        ...draft.periodTimes,
                        [period]: { start: event.target.value, end },
                      },
                    })}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="sr-only">第{period}节结束</span>
                  <input
                    aria-label={`第${period}节结束`}
                    className={inputClass}
                    type="time"
                    value={end}
                    onChange={(event) => setDraft({
                      ...draft,
                      periodTimes: {
                        ...draft.periodTimes,
                        [period]: { start, end: event.target.value },
                      },
                    })}
                  />
                </label>
                <button
                  type="button"
                  className={ui.quiet}
                  aria-label={`删除第${period}节`}
                  onClick={() => {
                    const next = { ...draft.periodTimes };
                    delete next[period];
                    setDraft({ ...draft, periodTimes: next });
                  }}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => {
              const nextPeriod = String(
                Math.max(0, ...Object.keys(draft.periodTimes).map(Number)) + 1,
              );
              setDraft({
                ...draft,
                periodTimes: {
                  ...draft.periodTimes,
                  [nextPeriod]: { start: "08:00", end: "08:45" },
                },
              });
            }}
          >
            添加节次
          </button>
        </div>
        <RangeFields
          label="每日可用窗口"
          start={draft.dailyWindow.start}
          end={draft.dailyWindow.end}
          disabled={busy}
          onChange={(dailyWindow) => setDraft({ ...draft, dailyWindow })}
        />
        <RangeFields
          label="午餐"
          start={draft.lunch.start}
          end={draft.lunch.end}
          disabled={busy}
          onChange={(lunch) => setDraft({ ...draft, lunch })}
        />
        <RangeFields
          label="晚餐"
          start={draft.dinner.start}
          end={draft.dinner.end}
          disabled={busy}
          onChange={(dinner) => setDraft({ ...draft, dinner })}
        />
        <RangeFields
          label="睡眠（可跨午夜）"
          start={draft.sleep.start}
          end={draft.sleep.end}
          disabled={busy}
          onChange={(sleep) => setDraft({ ...draft, sleep })}
        />
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void onSave()}>
          {busy ? <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" size={14} /> : <Save aria-hidden size={14} />}
          保存学期设置
        </button>
        <button type="button" className={secondaryButtonClass} disabled={busy || !data?.saved} onClick={() => void onClear()}>
          清除设置
        </button>
      </div>
      {notice ? <p className="text-sm text-emerald-700" role="status">{notice}</p> : null}
    </div>
  );
}
