"use client";

import type { OpeningAdaptivePrefs } from "@aistudy/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { OpeningApi } from "../client/api";
import { secondaryButtonClass } from "../design/ui";

/** Coach automation is a later slice; existing coach preferences remain readable. */
export function AutonomySwitcher({ api, onChanged }: {
  api: Pick<OpeningApi, "getAdaptivePrefs" | "patchAdaptivePrefs">;
  onChanged: () => void;
}) {
  const [prefs, setPrefs] = useState<OpeningAdaptivePrefs | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const saving = useRef(false);
  const read = useCallback(async () => {
    const request = ++epoch.current;
    setPending(true); setError("");
    try {
      const result = await api.getAdaptivePrefs();
      if (request !== epoch.current) return;
      setPrefs(result.prefs);
      if (result.invalidStoredPrefs) setError("原有安排偏好无法读取，当前显示默认设置；请选择后重新保存。");
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

  return <section className="space-y-2 border-b border-zinc-200 px-4 py-3" aria-label="安排方式">
    <p className="text-xs font-medium text-zinc-800">安排方式</p>
    <div className="flex gap-2" role="group" aria-label="选择安排方式">
      {(["manual", "copilot"] as const).map((autonomy) => <button key={autonomy} type="button" className={secondaryButtonClass} aria-pressed={prefs?.autonomy === autonomy} disabled={pending || !prefs} onClick={() => void change(autonomy)}>{autonomy === "manual" ? "手工" : "副驾驶"}</button>)}
    </div>
    <p className="text-[11px] leading-5 text-zinc-500">{prefs?.autonomy === "manual" ? "由你安排任务；仍可手动生成草案。" : prefs?.autonomy === "coach" ? "当前教练偏好仍需逐次确认安排。" : "系统给出草案，由你选择并确认。"}</p>
    {error ? <div><p className="text-xs text-red-700" role="alert">{error}</p><button type="button" className={`${secondaryButtonClass} mt-1`} disabled={pending} onClick={() => void read()}>重新读取安排偏好</button></div> : null}
  </section>;
}
