"use client";

import type { OpeningAdaptivePrefs } from "@aistudy/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { OpeningApi } from "../client/api";
import { inputClass, secondaryButtonClass } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";

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
      if (request === epoch.current) setError(userFacingMessage(reason, "安排偏好暂时无法读取，请重试。"));
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
      if (request === epoch.current) setError(userFacingMessage(reason, "安排偏好保存失败，请重试。"));
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
      if (request === epoch.current) setError(userFacingMessage(reason, "教练设置保存结果需要核对，请重新读取。"));
    } finally { saving.current = false; if (request === epoch.current) setPending(false); }
  }

  return <section className="space-y-2.5 border-b border-line/70 px-5 py-3.5" aria-label="安排方式">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs font-semibold text-text">安排方式</p>
      <div className="well-recessed inline-flex rounded-xl p-1" role="group" aria-label="选择安排方式">
        {(["manual", "copilot"] as const).map((autonomy) => <button key={autonomy} type="button" className={`min-h-8 rounded-lg px-3 text-xs font-medium transition-[color,background-color,box-shadow,transform] duration-150 ease-out-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 active:scale-[0.98] disabled:opacity-50 ${prefs?.autonomy === autonomy ? "bg-surface text-text shadow-card" : "text-text-2 hover:text-text"}`} aria-pressed={prefs?.autonomy === autonomy} disabled={pending || !prefs} onClick={() => void change(autonomy)}>{autonomy === "manual" ? "手工" : "副驾驶"}</button>)}
      </div>
    </div>
    <p className="text-xs leading-5 text-text-3">{prefs?.autonomy === "manual" ? "由你安排任务；仍可手动生成草案。" : prefs?.autonomy === "coach" ? prefs.coachAutoAcceptEnabled ? "在今日页确认后，教练按预算安排首份草案。已有安排可手动调整。" : "当前教练偏好仍需逐次确认安排。" : "系统给出草案，由你选择并确认。"}</p>
    <details className="group text-xs text-text-2"><summary className="flex min-h-10 cursor-pointer list-none items-center justify-between py-1.5 font-medium hover:text-text [&::-webkit-details-marker]:hidden"><span>教练预算安排</span><ChevronDown size={14} aria-hidden="true" className="text-text-3 transition-transform duration-200 ease-out-strong group-open:rotate-180" /></summary><div className="mt-2 space-y-2.5 rounded-xl border border-line bg-surface-2/60 p-3">
      <p className="leading-6">启用后，可在今日页确认预算内的首份草案。安排尚未开始且任务未改动时，可整批撤销。卡片复习仍由你确认。</p>
      <label className="flex flex-wrap items-center gap-2">每日时间预算（分钟）<input type="number" min={10} max={600} step={1} className={`${inputClass} w-24 tabular-nums`} value={budget} disabled={pending} onChange={event => setBudget(event.target.value)} /></label>
      <button type="button" className={secondaryButtonClass} disabled={pending || !prefs} onClick={() => void enableCoach()}>{prefs?.autonomy === "coach" && prefs.coachAutoAcceptEnabled ? "保存教练预算" : "启用教练"}</button>
    </div></details>
    {error ? <div><p className="text-xs text-danger" role="alert">{error}</p><button type="button" className={`${secondaryButtonClass} mt-1`} disabled={pending} onClick={() => void read()}>重新读取安排偏好</button></div> : null}
  </section>;
}
