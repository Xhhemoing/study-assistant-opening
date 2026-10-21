"use client";

import type { OpeningAdaptivePrefs } from "@aistudy/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { OpeningApi } from "../client/api";
import { inputClass, secondaryButtonClass } from "../design/ui";

/** Historical coach preferences stay advisory until this explicit opt-in. */
export function AutonomySwitcher({ api, onChanged }: {
  api: Pick<OpeningApi, "getAdaptivePrefs" | "patchAdaptivePrefs">;
  onChanged: () => void;
}) {
  const [prefs, setPrefs] = useState<OpeningAdaptivePrefs | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [budget, setBudget] = useState("60");
  const epoch = useRef(0);
  const saving = useRef(false);
  const read = useCallback(async () => {
    const request = ++epoch.current;
    setPending(true); setError("");
    try {
      const result = await api.getAdaptivePrefs();
      if (request !== epoch.current) return;
      setPrefs(result.prefs);
      setBudget(String(result.prefs.coachBudgetMinutes));
      if (result.invalidStoredPrefs) setError("原有安排偏好无法读取；原数据已保留，请恢复后继续。");
    } catch (reason) {
      if (request === epoch.current) setError(reason instanceof Error ? reason.message : "安排偏好暂时无法读取，请重试。");
    } finally { if (request === epoch.current) setPending(false); }
  }, [api]);
  useEffect(() => { void read(); return () => { epoch.current += 1; }; }, [read]);

  async function change(autonomy: "manual" | "copilot") {
    if (!prefs || pending || saving.current || autonomy === prefs.autonomy) return;
    saving.current = true;
    const request = ++epoch.current;
    setPending(true); setError("");
    try {
      const result = await api.patchAdaptivePrefs({ autonomy });
      if (request !== epoch.current) return;
      setPrefs(result.prefs); onChanged();
    } catch (reason) {
      if (request === epoch.current) setError(reason instanceof Error ? reason.message : "安排偏好保存失败，请重试。");
    } finally { saving.current = false; if (request === epoch.current) setPending(false); }
  }

  async function enableCoach() {
    if (!prefs || pending || saving.current) return;
    const minutes = Number(budget);
    if (!Number.isInteger(minutes) || minutes < 10 || minutes > 600) { setError("教练每日预算须为10–600分钟的整数。"); return; }
    saving.current = true;
    const request = ++epoch.current;
    setPending(true); setError("");
    try {
      const result = await api.patchAdaptivePrefs({ autonomy: "coach", coachBudgetMinutes: minutes, coachAutoAcceptEnabled: true });
      if (request !== epoch.current) return;
      setPrefs(result.prefs); onChanged();
    } catch (reason) {
      if (request === epoch.current) setError(reason instanceof Error ? reason.message : "教练设置保存结果需要核对，请重新读取。");
    } finally { saving.current = false; if (request === epoch.current) setPending(false); }
  }

  return <section className="space-y-2 border-b border-line px-4 py-3" aria-label="安排方式">
    <p className="text-xs font-medium text-text">安排方式</p>
    <div className="flex gap-2" role="group" aria-label="选择安排方式">
      {(["manual", "copilot"] as const).map((autonomy) => <button key={autonomy} type="button" className={secondaryButtonClass} aria-pressed={prefs?.autonomy === autonomy} disabled={pending || !prefs} onClick={() => void change(autonomy)}>{autonomy === "manual" ? "手工" : "副驾驶"}</button>)}
    </div>
    <p className="text-xs leading-5 text-text-3">{prefs?.autonomy === "manual" ? "由你安排任务；仍可手动生成草案。" : prefs?.autonomy === "coach" ? prefs.coachAutoAcceptEnabled ? "教练可在预算内确认今日首份自动草案；已有确认安排仍由你调整。" : "当前教练偏好仍需逐次确认安排。" : "系统给出草案，由你选择并确认。"}</p>
    <details className="text-xs text-text-2"><summary className="min-h-11 cursor-pointer py-2">教练自动安排</summary><div className="mt-2 space-y-2">
      <p className="leading-6">启用后，可自动确认预算内的今日首份规则草案。不会替换已确认计划；安排未开始且任务未改动时可整批撤销。卡片复习仍需确认。切到手工或副驾驶即停止自动确认。</p>
      <label className="flex flex-wrap items-center gap-2">每日时间预算（分钟）<input type="number" min={10} max={600} step={1} className={`${inputClass} w-24`} value={budget} disabled={pending} onChange={event => setBudget(event.target.value)} /></label>
      <button type="button" className={secondaryButtonClass} disabled={pending || !prefs} onClick={() => void enableCoach()}>{prefs?.autonomy === "coach" && prefs.coachAutoAcceptEnabled ? "保存教练预算" : "启用教练"}</button>
    </div></details>
    {error ? <div><p className="text-xs text-danger" role="alert">{error}</p><button type="button" className={`${secondaryButtonClass} mt-1`} disabled={pending} onClick={() => void read()}>重新读取安排偏好</button></div> : null}
  </section>;
}
