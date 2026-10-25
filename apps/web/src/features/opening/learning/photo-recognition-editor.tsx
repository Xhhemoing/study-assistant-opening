"use client";

import { useEffect, useState } from "react";
import type { PhotoQuestionRecognitionProposal, PhotoQuestionRecognitionResponse } from "@aistudy/contracts";
import { photoQuestionRecognition } from "./photo-practice-client";
import { ui } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";

const stateCopy = {
  queued: "正在排队识别题干；你也可以直接手动填写。",
  running: "正在识别题干；不会解题，也不会自动开始作答。",
  failed: "这次识别未完成，请对照原图手动填写。本次不会自动重新请求模型。",
  unknown: "识别请求的结果尚未确认，本次不会再次请求模型；请稍后重新读取或手动填写。",
  cancelled: "识别已取消，仍可对照原图手动填写。",
} as const;

/** Model output stays a candidate until the learner edits and confirms the parent form. */
export function PhotoRecognitionEditor({ sourceId, sourceVersion, disabled, onUse }: {
  sourceId: string; sourceVersion: number; disabled: boolean; onUse: (proposal: PhotoQuestionRecognitionProposal) => void;
}) {
  const [result, setResult] = useState<PhotoQuestionRecognitionResponse | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const value = await photoQuestionRecognition({ sourceId, sourceVersion });
        if (!active) return;
        setResult(value); setError("");
        if (value.status === "queued" || value.status === "running") timer = setTimeout(() => { void read(); }, 2000);
      } catch (reason) { if (active) setError(userFacingMessage(reason, "识别状态暂不可读取，仍可手动填写。")); }
    }
    void read();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [sourceId, sourceVersion, revision]);
  async function start() {
    if (busy || disabled || result?.status !== "idle") return;
    setBusy(true); setError("");
    try { setResult(await photoQuestionRecognition({ sourceId, sourceVersion }, true)); setRevision(value => value + 1); }
    catch (reason) { setError(userFacingMessage(reason, "请求结果尚未确认，请重新读取状态或手动填写。")); setResult(null); }
    finally { setBusy(false); }
  }
  return <section className="space-y-2 rounded-lg border border-line bg-surface-2 p-3" aria-label="题干识别">
    <p className="text-xs leading-6 text-text-2">可用视觉模型转录题干；不会提供解答。识别结果需要你对照原图编辑确认，不能作为评分真值。</p>
    {result?.status === "idle" ? <button type="button" className={ui.secondary} disabled={busy || disabled} onClick={() => void start()}>{busy ? "正在提交…" : "识别题干"}</button> : null}
    {result && result.status in stateCopy ? <p role="status" className="text-xs leading-6 text-text-2">{stateCopy[result.status as keyof typeof stateCopy]}</p> : null}
    {result?.status === "ready" && result.proposal ? <div className="space-y-2">
      <p className="whitespace-pre-wrap break-words text-sm leading-7 text-text">{result.proposal.stem || "未能完整识别题干，请手动填写。"}</p>
      {result.proposal.uncertainFragments.length ? <ul className="list-disc space-y-1 pl-4 text-xs leading-6 text-warn" aria-label="需要核对的片段">{result.proposal.uncertainFragments.map((item, index) => <li key={index}>{item.fragment}：{item.reason}</li>)}</ul> : null}
      <button type="button" className={ui.secondary} disabled={disabled || !result.proposal.stem.trim()} onClick={() => onUse(result.proposal!)}>使用识别题干，继续编辑</button>
      <p className="text-xs text-text-3">使用后会替换下方题干；确认前仍可修改，不会自动提交作答。</p>
    </div> : null}
    {error ? <p role="alert" className="text-xs leading-6 text-warn">{error}</p> : null}
    {error || result?.status === "unknown" || result?.status === "failed" ? <button type="button" className={ui.quiet} disabled={busy || disabled} onClick={() => setRevision(value => value + 1)}>重新读取识别状态</button> : null}
  </section>;
}
