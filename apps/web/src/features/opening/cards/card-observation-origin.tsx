"use client";
import { useEffect, useState } from "react";
import type { LearningObservation } from "@aistudy/contracts";
import { createOpeningLearningClient } from "../client/learning-client";
import { ObservationRevisionCard } from "../learning/observation-revision-card";
import { currentHistoryRecord } from "../learning/observation-revision-model";
import { ui } from "../design/ui";

/** Reopen the exact saved answer, with the existing correction and history controls. */
export function CardObservationOrigin({ observationId, onChanged }: { observationId: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<LearningObservation | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    if (!open) return;
    setRecord(null); setError("");
    void createOpeningLearningClient().getObservationHistory(observationId).then(history => {
      if (active) setRecord(currentHistoryRecord(history));
    }, () => { if (active) setError("原作答暂时无法读取，请稍后再试。"); });
    return () => { active = false; };
  }, [open, observationId]);
  return <div className="space-y-2">
    <button type="button" className={ui.quiet} aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "收起原作答" : "查看原作答与批改"}</button>
    {open ? error ? <p role="alert" className="text-xs text-warn">{error}</p>
      : record ? <ObservationRevisionCard record={record} onChanged={onChanged} />
        : <p role="status" className="text-xs text-text-3">正在读取原作答…</p> : null}
  </div>;
}
