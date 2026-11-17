"use client";
import { useEffect, useRef, useState } from "react";
import { teachingExampleEstimateSchema, teachingExampleStatusSchema, teachingExampleRequestSchema, TEACHING_EXAMPLE_CONSENT_VERSION,
  type TeachingExampleTarget, type TeachingExampleEstimate, type TeachingExampleStatus, type TeachingExampleRequest } from "@aistudy/contracts";
import { ui } from "../design/ui";

const labels = { queued: "已排队", running: "正在生成", succeeded: "新例题已发布", failed: "未完成发布", cancelled: "已取消", outcome_unknown: "结果或费用待确认" };
async function json(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("暂时无法查看本次生成的进度，请保留页面，稍后再查看。");
  return response.json();
}

/** Mount/recovery is GET only. Persist identity BEFORE the single explicit paid POST. */
export function TeachingExampleControl({ target, onPublished }: { target: TeachingExampleTarget; onPublished: () => void | Promise<void> }) {
  const [estimate, setEstimate] = useState<TeachingExampleEstimate | null>(null), [status, setStatus] = useState<TeachingExampleStatus | null>(null);
  const [pending, setPending] = useState<TeachingExampleRequest | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [blocked, setBlocked] = useState(true), [consent, setConsent] = useState(false);
  const current = useRef(0), sending = useRef<{ epoch: number; clientKey: string } | null>(null);
  const binding = JSON.stringify(target), storageKey = `aistudy:teaching-example:${target.activityId}:${target.blockId}`;
  async function read(original: TeachingExampleRequest, epoch: number) {
    const result = await json(await fetch(`/api/opening/teaching/examples?clientKey=${encodeURIComponent(original.clientKey)}`, { cache: "no-store" }));
    const operation = (result as { operation?: unknown }).operation;
    if (epoch !== current.current) return;
    if (!operation) { setError("暂时查不到本次生成的进度。结果还未确认，不会自动重新生成；请保留此页，稍后再查看。"); return; }
    const parsed = teachingExampleStatusSchema.parse(operation);
    if (JSON.stringify(parsed.target) !== JSON.stringify(original.target) || parsed.clientKey !== original.clientKey) throw new Error("查到的生成记录与本次操作不符，未继续处理。");
    setStatus(parsed); setError("");
  }
  useEffect(() => {
    const epoch = ++current.current;
    setEstimate(null); setStatus(null); setPending(null); setConsent(false); setError(""); setBlocked(true); setBusy(false);
    try {
      const saved = localStorage.getItem(storageKey);
      if (!saved) { setBlocked(false); return; }
      const original = teachingExampleRequestSchema.parse(JSON.parse(saved));
      if (original.target.activityId !== target.activityId || original.target.blockId !== target.blockId) throw new Error("stored identity mismatch");
      setPending(original);
      void read(original, epoch).catch(() => { if (epoch === current.current) setError("原例题请求尚未确认，只能重新读取，不会自动重发。"); });
    } catch { setError("浏览器无法安全恢复本次生成的记录，暂不能再次付费生成。请保留页面并核对之前的操作。"); }
    return () => { current.current += 1; };
  }, [binding, storageKey]);
  async function quote() {
    if (busy || blocked || sending.current?.epoch === current.current) return;
    const epoch = current.current; setBusy(true); setError("");
    try {
      const query = new URLSearchParams(Object.entries(target).map(([key, value]) => [key, String(value)]));
      const lookup = await json(await fetch(`/api/opening/teaching/examples?${query}&lookup=target`, { cache: "no-store" })) as { operation?: unknown };
      if (epoch !== current.current) return;
      if (lookup.operation) {
        const existing = teachingExampleStatusSchema.parse(lookup.operation);
        const original: TeachingExampleRequest = { target: existing.target, clientKey: existing.clientKey, consentVersion: TEACHING_EXAMPLE_CONSENT_VERSION, acceptPaidGeneration: true };
        localStorage.setItem(storageKey, JSON.stringify(original));
        setPending(original); setStatus(existing); setBlocked(true); return;
      }
      const result = teachingExampleEstimateSchema.parse(await json(await fetch(`/api/opening/teaching/examples?${query}`, { cache: "no-store" })));
      if (epoch === current.current) setEstimate(result);
    } catch { if (epoch === current.current) setError("当前无法取得费用预估，未创建例题请求。"); }
    finally { if (epoch === current.current) setBusy(false); }
  }
  async function generate() {
    if (busy || blocked || pending || !consent || !estimate || sending.current?.epoch === current.current) return;
    const epoch = current.current;
    const request: TeachingExampleRequest = { target, clientKey: `example-${crypto.randomUUID()}`, consentVersion: TEACHING_EXAMPLE_CONSENT_VERSION, acceptPaidGeneration: true };
    try { localStorage.setItem(storageKey, JSON.stringify(request)); }
    catch { setError("浏览器无法保留请求身份，未发送付费请求。"); setBlocked(true); return; }
    const token = { epoch, clientKey: request.clientKey };
    sending.current = token; setPending(request); setBlocked(true); setBusy(true); setError("");
    try {
      const result = teachingExampleStatusSchema.parse(await json(await fetch("/api/opening/teaching/examples", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
      })));
      if (epoch === current.current) setStatus(result);
    } catch { if (epoch === current.current) setError("本次生成的结果还未确认。只能查看处理进度，不会再次发送或重新生成。"); }
    finally { if (sending.current === token) sending.current = null; if (epoch === current.current) setBusy(false); }
  }
  return <section className="space-y-3 rounded-lg border border-line p-3 text-sm" aria-label="同类新例题">
    <h4 className="font-medium">生成同类新例题与完整解答</h4>
    <p className="text-xs leading-6 text-text-2">保留原例题，追加同知识点的新题与分步解答。属于已揭示的教学辅助，不计为独立掌握；数学结果待你核对。</p>
    {pending ? <div className="space-y-2" role="status">
      <p>{status ? labels[status.state] : "本次生成待确认"}</p>
      {status ? <p className="text-xs text-text-2">原预估 {status.estimatedCents} 分（不是费用上限）。{status.costState === "unknown" || status.costState === "in_flight" ? "费用尚未确认；即使例题已发布也不会重发。" : "实际费用请查看费用记录。"}</p> : null}
      <button type="button" className={ui.secondary} disabled={busy} onClick={() => { const epoch = current.current; setBusy(true); void read(pending, epoch).catch(() => { if (epoch === current.current) setError("暂时无法查看处理进度，没有再次发送。"); }).finally(() => { if (epoch === current.current) setBusy(false); }); }}>刷新进度</button>
      {status?.publication ? <button type="button" className={ui.secondary} onClick={() => void onPublished()}>读取已发布的新例题</button> : null}
    </div> : <>
      <button type="button" className={ui.secondary} disabled={busy || blocked} onClick={() => void quote()}>先查看模型费用预估</button>
      {estimate ? <><p className="text-xs leading-6">预估 {estimate.estimatedCents} 分，不是费用上限。{estimate.consentText}</p>
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />我确认调用模型并按实际用量计费</label>
        <button type="button" className={ui.primary} disabled={busy || blocked || !consent} onClick={() => void generate()}>确认付费生成新例题</button></> : null}
    </>}
    {error ? <p role="alert" className="text-xs leading-6 text-danger">{error}</p> : null}
  </section>;
}
