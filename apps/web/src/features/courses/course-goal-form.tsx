"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CourseGoal, CourseGoalUpdate, GoalLearningMode, OpeningAdaptivePrefsPatch } from "@aistudy/contracts";
import { createOpeningApi, type OpeningApi } from "../opening/client/api";
import { ui } from "../opening/design/ui";
import { CourseMilestones } from "./course-milestones";
import { userFacingMessage } from "../../lib/user-facing-error";

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
  goal: CourseGoalUpdate | null,
  expectedRevision?: number,
): OpeningAdaptivePrefsPatch {
  return { courseGoal: { courseId, goal, ...(expectedRevision === undefined ? {} : { expectedRevision }) } };
}

export function CourseGoalForm({
  courseId,
  api: suppliedApi,
}: {
  courseId: string;
  api?: OpeningApi;
}) {
  const api = useMemo(() => suppliedApi ?? createOpeningApi(), [suppliedApi]);

  const [targetDate, setTargetDate] = useState("");
  const [weeklyMinutes, setWeeklyMinutes] = useState("120");
  const [learningMode, setLearningMode] = useState<GoalLearningMode>("auto");
  const [priority, setPriority] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [hasGoal, setHasGoal] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [storedGoal, setStoredGoal] = useState<CourseGoal | null>(null);
  const [baseRevision, setBaseRevision] = useState(0);
  const [mustReload, setMustReload] = useState(false);
  const scopeRef = useRef(courseId);
  scopeRef.current = courseId;
  const saving = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setLoadFailed(false);
    api
      .getAdaptivePrefs()
      .then((res) => {
        if (!active) return;
        if (res.invalidStoredPrefs) throw new Error("已保存的课程目标暂时无法读取，请重试。");
        setLoadFailed(false);
        const existing = res.prefs.courseGoals[courseId];
        setStoredGoal(existing ?? null);
        setBaseRevision(res.prefs.courseGoalRevisions?.[courseId] ?? existing?.revision ?? 0);
        setMustReload(false);
        if (existing) {
          setTargetDate(existing.targetDate ?? "");
          setWeeklyMinutes(String(existing.weeklyMinutes));
          setLearningMode(existing.learningMode ?? "auto");
          setPriority(existing.priority ?? 0);
          setHasGoal(true);
        } else {
          setTargetDate("");
          setWeeklyMinutes("120");
          setLearningMode("auto");
          setPriority(0);
          setHasGoal(false);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setLoadFailed(true);
          setError(userFacingMessage(reason, "课程目标读取失败，请重试。"));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, courseId, reloadToken]);

  const datePast =
    Boolean(targetDate) && /^\d{4}-\d{2}-\d{2}$/.test(targetDate) && targetDate < todayLocalDate();

  async function save() {
    if (busy || saving.current || mustReload) return;
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
      learningMode,
      priority,
    };
    setBusy(true);
    saving.current = true;
    try {
      const result = await api.patchAdaptivePrefs(buildCourseGoalPatch(courseId, goal, baseRevision));
      if (scopeRef.current !== courseId) return;
      const fresh = result.prefs.courseGoals[courseId] ?? null;
      setStoredGoal(fresh);
      setBaseRevision(result.prefs.courseGoalRevisions?.[courseId] ?? fresh?.revision ?? 0);
      setHasGoal(true);
      setMessage("课程目标已保存。");
    } catch (reason) {
      if (scopeRef.current !== courseId) return;
      setMustReload(true);
      setError(userFacingMessage(reason, "课程目标保存失败，请重试。"));
    } finally {
      saving.current = false;
      if (scopeRef.current === courseId) setBusy(false);
    }
  }

  async function clearGoal() {
    if (busy || saving.current || mustReload) return;
    setError("");
    setMessage("");
    setBusy(true);
    saving.current = true;
    try {
      const result = await api.patchAdaptivePrefs(buildCourseGoalPatch(courseId, null, baseRevision));
      if (scopeRef.current !== courseId) return;
      setStoredGoal(null);
      setBaseRevision(result.prefs.courseGoalRevisions?.[courseId] ?? 0);
      setTargetDate("");
      setWeeklyMinutes("120");
      setLearningMode("auto");
      setPriority(0);
      setHasGoal(false);
      setMessage("已清除课程目标。");
    } catch (reason) {
      if (scopeRef.current !== courseId) return;
      setMustReload(true);
      setError(userFacingMessage(reason, "清除课程目标失败，请重试。"));
    } finally {
      saving.current = false;
      if (scopeRef.current === courseId) setBusy(false);
    }
  }

  function syncMilestones(fresh: CourseGoal) {
    // Unsaved base fields retain their original OCC baseline. A child reload must
    // never bless old input values with a newer version read in another panel.
    const baseIsClean = targetDate === (storedGoal?.targetDate ?? "")
      && weeklyMinutes === String(storedGoal?.weeklyMinutes ?? 120)
      && learningMode === (storedGoal?.learningMode ?? "auto")
      && priority === (storedGoal?.priority ?? 0);
    setStoredGoal(fresh);
    if (baseIsClean) {
      setTargetDate(fresh.targetDate ?? "");
      setWeeklyMinutes(String(fresh.weeklyMinutes));
      setLearningMode(fresh.learningMode ?? "auto");
      setPriority(fresh.priority ?? 0);
      setBaseRevision(fresh.revision ?? 0);
    }
  }

  return (
    <section
      className="border-t border-line pt-5"
      aria-labelledby="course-goal-heading"
      data-testid="course-goal-form"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="course-goal-heading" className="text-sm font-semibold text-text">
          课程目标
        </h2>
        <p className="text-xs text-text-3">{loading ? "读取中" : loadFailed ? "暂不可读取" : hasGoal ? "已设置" : "未设置"}</p>
      </div>
      <p className="mt-1 text-xs leading-6 text-text-3">
        先选择目标日期与讲练方式；日期留空支持长期学习。未设置目标也可以直接开始。
      </p>
      {loading ? (
        <p className="mt-3 text-xs text-text-3" role="status">
          正在读取课程目标…
        </p>
      ) : loadFailed ? (
        <div className="mt-3 space-y-2">
          {error ? (
            <p className="text-xs leading-5 text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            className={ui.quiet}
            onClick={() => setReloadToken((v) => v + 1)}
          >
            重试
          </button>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="block min-w-0 flex-1 basis-52 space-y-1">
              <span className={ui.label}>目标日期（可选）</span>
              <div className="flex gap-2">
                <input
                  id="course-goal-target-date"
                  type="date"
                  className={`${ui.input} min-w-0`}
                  value={targetDate}
                  disabled={busy || mustReload}
                  onChange={(event) => {
                    setTargetDate(event.target.value);
                    setMessage("");
                  }}
                />
                {targetDate ? (
                  <button
                    type="button"
                    className={ui.quiet}
                    disabled={busy || mustReload}
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
            <label className="block min-w-0 flex-1 basis-48 space-y-1">
              <span className={ui.label}>学习安排</span>
              <select id="course-goal-learning-mode" className={ui.input} value={learningMode} disabled={busy || mustReload}
                onChange={event => { setLearningMode(event.target.value as GoalLearningMode); setMessage(""); }}>
                <option value="auto">随目标调整</option>
                <option value="understand">理解与迁移</option>
                <option value="exam">应试练习</option>
              </select>
            </label>
          </div>
          <p className="text-xs leading-6 text-text-3">
            {learningMode === "auto" ? "目标或未完成阶段成果进入最后7天时，优先短讲解和练习；其他时间侧重理解与迁移。"
              : learningMode === "exam" ? "优先练习与必要补课，减少无关扩展；仍保留独立作答与复测记录。"
                : "侧重理解、方法解释与迁移；遇到阻塞时先补必要前置，再回到原任务。"}
          </p>
          {datePast ? (
            <p className="text-xs leading-6 text-warn" role="status">
              目标日期早于今天；仍可保存，但草案可能不再按该截止日期推进。
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={ui.secondary}
              disabled={busy || mustReload}
              onClick={() => void save()}
            >
              {busy ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              className={ui.quiet}
              disabled={busy || mustReload}
              onClick={() => void clearGoal()}
            >
              清除目标
            </button>
          </div>
          {error ? (
            <p className="text-xs leading-5 text-danger" role="alert">
              {error}
            </p>
          ) : null}
          {message ? (
            <p className="text-xs leading-6 text-text-2" role="status">
              {message}
            </p>
          ) : null}
          {mustReload ? <button type="button" className={ui.secondary} disabled={busy} onClick={() => setReloadToken(value => value + 1)}>重新读取课程目标</button> : null}
          <fieldset className="border-t border-line pt-3">
            <legend className="py-1 pr-3 text-sm font-medium text-text">投入时间、优先级与阶段成果</legend>
            <div className="mt-3 space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <label className="block min-w-0 flex-1 basis-40 space-y-1">
                  <span className={ui.label}>每周投入分钟</span>
                  <input id="course-goal-weekly-minutes" type="number" inputMode="numeric" min={WEEKLY_MIN} max={WEEKLY_MAX} step={1}
                    className={ui.input} value={weeklyMinutes} disabled={busy || mustReload}
                    onChange={event => { setWeeklyMinutes(event.target.value); setMessage(""); }} />
                </label>
                <label className="block min-w-0 flex-1 basis-40 space-y-1">
                  <span className={ui.label}>相对其他课程</span>
                  <select id="course-goal-priority" className={ui.input} value={priority} disabled={busy || mustReload}
                    onChange={event => { setPriority(Number(event.target.value)); setMessage(""); }}>
                    {(["常规", "略优先", "较优先", "优先", "重点", "首要"] as const).map((label, value) =>
                      <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
              </div>
              <p className="text-xs leading-6 text-text-3">时间与优先级调整后，使用上方“保存”确认。{priority > 0 ? "本课程可排在其他课程的普通积压任务之前，当天截止事项仍优先。" : ""}</p>
              {storedGoal ? <CourseMilestones key={courseId} courseId={courseId} goal={storedGoal} api={api}
                onSaved={syncMilestones} disabled={busy || mustReload} /> : <p className="text-xs text-text-3">保存课程目标后，可添加阶段成果与成功标准。</p>}
            </div>
          </fieldset>
        </div>
      )}
    </section>
  );
}
