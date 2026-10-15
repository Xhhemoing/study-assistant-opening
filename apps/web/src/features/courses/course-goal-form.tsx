"use client";

import { useEffect, useMemo, useState } from "react";
import type { CourseGoal, OpeningAdaptivePrefsPatch } from "@aistudy/contracts";
import { createOpeningApi, type OpeningApi } from "../opening/client/api";
import { useOpeningCapabilities } from "../opening/capabilities/capabilities-provider";
import { ui } from "../opening/design/ui";

const WEEKLY_MIN = 0;
const WEEKLY_MAX = 3000;

/** Local calendar YYYY-MM-DD (box/user zone). */
export function todayLocalDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Parse weekly minutes; rejects non-integers and values outside 0–3000. */
export function parseWeeklyMinutes(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, error: "请填写每周投入分钟（0–3000）。" };
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: "每周投入分钟须为整数。" };
  }
  if (n < WEEKLY_MIN || n > WEEKLY_MAX) {
    return { ok: false, error: `每周投入分钟须在 ${WEEKLY_MIN}–${WEEKLY_MAX} 之间。` };
  }
  return { ok: true, value: n };
}

export function buildCourseGoalPatch(
  courseId: string,
  goal: CourseGoal | null,
): OpeningAdaptivePrefsPatch {
  return { courseGoal: { courseId, goal } };
}

export function CourseGoalForm({
  courseId,
  api: suppliedApi,
}: {
  courseId: string;
  api?: OpeningApi;
}) {
  const { adaptivePlanning } = useOpeningCapabilities();
  const api = useMemo(() => suppliedApi ?? createOpeningApi(), [suppliedApi]);

  const [targetDate, setTargetDate] = useState("");
  const [weeklyMinutes, setWeeklyMinutes] = useState("120");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [hasGoal, setHasGoal] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!adaptivePlanning) return;
    let active = true;
    setLoading(true);
    setError("");
    api
      .getAdaptivePrefs()
      .then((res) => {
        if (!active) return;
        const existing = res.prefs.courseGoals[courseId];
        if (existing) {
          setTargetDate(existing.targetDate ?? "");
          setWeeklyMinutes(String(existing.weeklyMinutes));
          setHasGoal(true);
        } else {
          setTargetDate("");
          setWeeklyMinutes("120");
          setHasGoal(false);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "课程目标读取失败，请重试。");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [adaptivePlanning, api, courseId, reloadToken]);

  if (!adaptivePlanning) return null;

  const datePast =
    Boolean(targetDate) && /^\d{4}-\d{2}-\d{2}$/.test(targetDate) && targetDate < todayLocalDate();

  async function save() {
    if (busy) return;
    setError("");
    setMessage("");
    const parsed = parseWeeklyMinutes(weeklyMinutes);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const date = targetDate.trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError("请填写有效的目标日期，或留空。");
      return;
    }
    const goal: CourseGoal = {
      targetDate: date || null,
      weeklyMinutes: parsed.value,
    };
    setBusy(true);
    try {
      await api.patchAdaptivePrefs(buildCourseGoalPatch(courseId, goal));
      setHasGoal(true);
      setMessage("课程目标已保存。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "课程目标保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  async function clearGoal() {
    if (busy) return;
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await api.patchAdaptivePrefs(buildCourseGoalPatch(courseId, null));
      setTargetDate("");
      setWeeklyMinutes("120");
      setHasGoal(false);
      setMessage("已清除课程目标。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "清除课程目标失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="border-t border-zinc-200 pt-5"
      aria-labelledby="course-goal-heading"
      data-testid="course-goal-form"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="course-goal-heading" className="text-sm font-semibold text-zinc-800">
          课程目标
        </h2>
        <p className="text-xs text-zinc-500">{hasGoal ? "已设置" : "未设置"}</p>
      </div>
      <p className="mt-1 text-xs leading-6 text-zinc-500">
        目标日期与每周投入用于次日草案的进度建议；留空日期表示无固定截止日期。
      </p>
      {loading ? (
        <p className="mt-3 text-xs text-zinc-500" role="status">
          正在读取课程目标…
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="block min-w-[10rem] flex-1 space-y-1">
              <span className={ui.label}>目标日期（可选）</span>
              <div className="flex gap-2">
                <input
                  id="course-goal-target-date"
                  type="date"
                  className={ui.input}
                  value={targetDate}
                  disabled={busy}
                  onChange={(event) => {
                    setTargetDate(event.target.value);
                    setMessage("");
                  }}
                />
                {targetDate ? (
                  <button
                    type="button"
                    className={ui.quiet}
                    disabled={busy}
                    onClick={() => {
                      setTargetDate("");
                      setMessage("");
                    }}
                  >
                    清除日期
                  </button>
                ) : null}
              </div>
            </label>
            <label className="block min-w-[8rem] space-y-1">
              <span className={ui.label}>每周投入分钟</span>
              <input
                id="course-goal-weekly-minutes"
                type="number"
                inputMode="numeric"
                min={WEEKLY_MIN}
                max={WEEKLY_MAX}
                step={1}
                className={ui.input}
                value={weeklyMinutes}
                disabled={busy}
                onChange={(event) => {
                  setWeeklyMinutes(event.target.value);
                  setMessage("");
                }}
              />
            </label>
          </div>
          {datePast ? (
            <p className="text-xs leading-6 text-amber-800" role="status">
              目标日期早于今天；仍可保存，但草案可能不再按该截止日期推进。
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={ui.secondary}
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              className={ui.quiet}
              disabled={busy}
              onClick={() => void clearGoal()}
            >
              清除目标
            </button>
          </div>
        </div>
      )}
      {error ? (
        <p className="mt-2 text-xs leading-5 text-red-700" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="mt-2 text-xs leading-6 text-zinc-600" role="status">
          {message}
        </p>
      ) : null}
      {error && !loading ? (
        <button
          type="button"
          className={`${ui.quiet} mt-1`}
          onClick={() => setReloadToken((v) => v + 1)}
        >
          重试读取
        </button>
      ) : null}
    </section>
  );
}
