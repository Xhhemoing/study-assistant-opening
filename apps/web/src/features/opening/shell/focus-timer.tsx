"use client";

import { Pause, Play, RotateCcw, Timer } from "lucide-react";
import { useEffect, useState } from "react";
import { ui } from "../design/ui";
import { formatFocusTime, remainingFocusSeconds } from "./focus-timer-model";

/** A local UI clock; never writes learning records. */
export function FocusTimer() {
  const [minutes, setMinutes] = useState(25);
  const [remaining, setRemaining] = useState(25 * 60);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (deadline === null) return;
    const update = () => {
      const next = remainingFocusSeconds(deadline, Date.now());
      setRemaining(next);
      if (next === 0) setDeadline(null);
    };
    update();
    const interval = window.setInterval(update, 1000);
    document.addEventListener("visibilitychange", update);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", update); };
  }, [deadline]);
  function toggle() {
    if (deadline !== null) { setRemaining(remainingFocusSeconds(deadline, Date.now())); setDeadline(null); }
    else if (remaining > 0) setDeadline(Date.now() + remaining * 1000);
  }
  return <div className="relative">
    <button type="button" className={ui.quiet} aria-expanded={expanded} aria-controls="focus-timer-controls" onClick={() => setExpanded(value => !value)} title="专注计时，仅当前页面有效"><Timer size={14} aria-hidden="true" /><span className="tabular-nums">{formatFocusTime(remaining)}</span></button>
    {expanded ? <div id="focus-timer-controls" className="absolute right-0 top-11 z-30 w-56 rounded-md border border-zinc-200 bg-white p-3 shadow-lg shadow-zinc-900/10">
      <label className="flex items-center justify-between gap-2 text-xs text-zinc-600">专注时长<select className={`${ui.input} max-w-24`} aria-label="专注时长" disabled={deadline !== null} value={minutes} onChange={event => { const value = Number(event.target.value); setMinutes(value); setRemaining(value * 60); }}>
        {[15, 25, 45].map(value => <option key={value} value={value}>{value} 分钟</option>)}
      </select></label>
      <div className="mt-3 flex gap-2"><button type="button" className={ui.primary} onClick={toggle} disabled={remaining === 0}>{deadline === null ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}{deadline === null ? "开始" : "暂停"}</button><button type="button" className={ui.secondary} onClick={() => { setDeadline(null); setRemaining(minutes * 60); }}><RotateCcw size={13} aria-hidden="true" />重置</button></div>
      <p className="mt-3 text-xs leading-5 text-zinc-500">仅作计时，不计入学习记录。</p>
    </div> : null}
    {remaining === 0 ? <span className="sr-only" role="status">本次专注计时结束</span> : null}
  </div>;
}
