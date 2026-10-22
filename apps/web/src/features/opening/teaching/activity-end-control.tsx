"use client";

import { useRef, useState } from "react";
import type { TeachingActivity } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { ui } from "../design/ui";
import { ActivitySummaryCard } from "./activity-summary-card";

/** Ending is separate from task completion. Only the summary's explicit action writes a task. */
export async function endTeachingActivity(api: Pick<OpeningApi, "getTeachingActivity" | "patchTeachingActivityStatus">, activityId: string) {
  const current = await api.getTeachingActivity(activityId);
  if (current.status === "completed") return current;
  return api.patchTeachingActivityStatus(activityId, { status: "completed", expectedUpdatedAt: current.updatedAt });
}

export function ActivityEndControl({ activity, api, onActivityUpdated }: {
  activity: TeachingActivity;
  api: OpeningApi;
  onActivityUpdated: (activity: TeachingActivity) => void;
}) {
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  async function end() {
    if (inFlight.current || uncertain) return;
    // Ending is final for this session; a new one can always be started afterwards.
    if (!window.confirm("结束后本节不能再作答，学习记录会保留；之后可以随时开始新的一节。确定结束？")) return;
    inFlight.current = true; setPending(true); setError("");
    try { onActivityUpdated(await endTeachingActivity(api, activity.id)); }
    catch (reason) { setUncertain(true); setError(reason instanceof Error ? reason.message : "结束状态尚未确认，请重新读取。"); }
    finally { inFlight.current = false; setPending(false); }
  }
  async function reread() {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true); setError("");
    try { onActivityUpdated(await api.getTeachingActivity(activity.id)); setUncertain(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取学习状态"); }
    finally { inFlight.current = false; setPending(false); }
  }
  if (activity.status === "completed") return <ActivitySummaryCard activityId={activity.id} api={api} />;
  return <div className="space-y-2 border-t border-line pt-4">
    <button type="button" className={ui.secondary} disabled={pending || uncertain} onClick={() => { void end(); }}>{pending ? "正在确认状态…" : "结束本次学习"}</button>
    {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
    {uncertain ? <button type="button" className={ui.quiet} disabled={pending} onClick={() => { void reread(); }}>重新读取学习状态</button> : null}
  </div>;
}
