"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { ui } from "@aistudy/ui";
import { extractKeySteps, providers, type Provider } from "./markdown";

type Props = { courseId?: string | null; timeZone?: string };

export function ExternalAiCaptureCard({ courseId, timeZone }: Props) {
  const heading = useId();
  const [content, setContent] = useState("");
  const [summary, setSummary] = useState("");
  const [provider, setProvider] = useState<Provider>("other");
  const [schedule, setSchedule] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const pending = useRef(false);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const steps = content.trim() ? extractKeySteps(content, summary) : [];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !steps.length) return;
    pending.current = true;
    setBusy(true);
    setStatus("");
    setError("");
    try {
      const input = { content, keyStepSummary: summary || undefined, providerHint: provider, courseId, timeZone,
        scheduleNextDayRetell: schedule };
      const payload = JSON.stringify(input);
      if (attempt.current?.payload !== payload) {
        attempt.current = { payload, key: Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-") };
      }
      const response = await fetch("/api/opening/imports/text", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, clientKey: attempt.current.key }),
      });
      if (!response.ok) {
        if (response.status === 413) setError("内容过长，请缩短讲解后再保存。");
        else if (response.status === 401) setError("请登录后再保存讲解。");
        else if (response.status === 400) setError("请检查讲解内容和关键步骤后再保存。");
        else if (response.status === 404) setError("课程或资料已不可用，请重新打开后再试。");
        else setError("未能确认保存结果，可用当前内容重试。");
        return;
      }
      const result = await response.json();
      if (typeof result.sourceId !== "string" || (schedule && typeof result.taskId !== "string")) {
        throw new Error("Incomplete capture response");
      }
      setStatus(!schedule ? "讲解已存入资料库。" : result.deferredBehindActiveRetest
        ? "讲解已保存，复述已排在现有复测之后。" : "讲解已保存，明天可以闭卷复述。");
      attempt.current = null;
      setContent("");
      setSummary("");
    } catch {
      setError("未能确认保存结果，可用当前内容重试。");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <section aria-labelledby={heading} className={`${ui.panel} space-y-4 p-4`}>
    <h2 id={heading} className="text-lg font-semibold text-text-1">保存外部 AI 讲解</h2>
    <form onSubmit={submit} aria-busy={busy}>
      <fieldset disabled={busy} className="space-y-4">
        <label className="block space-y-1">讲解来自
          <select className={ui.input} value={provider} onChange={e => setProvider(e.target.value as Provider)}>
            {Object.entries(providers).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="block space-y-1">讲解内容
          <textarea className={`${ui.input} min-h-32 resize-y`} required value={content}
            placeholder="粘贴要保留的推导或解释" onChange={e => setContent(e.target.value)} />
        </label>
        <label className="block space-y-1">我的关键步骤（选填）
          <textarea className={`${ui.input} resize-y`} maxLength={8000} value={summary}
            placeholder="每行写一个想独立复述的步骤" onChange={e => setSummary(e.target.value)} />
        </label>
        {steps.length > 0 && <div>
          <h3 className="font-medium">复述要点预览</h3>
          <ol className="list-decimal space-y-1 break-words ps-5 text-sm text-text-2">
            {steps.map(step => <li key={step}>{step}</li>)}
          </ol>
        </div>}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={schedule} onChange={e => setSchedule(e.target.checked)} />
          安排明天闭卷复述
        </label>
        <button type="submit" className={ui.primary} disabled={!steps.length || busy}>
          {busy ? "正在保存…" : "保存讲解"}
        </button>
      </fieldset>
    </form>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <p role="status" className="text-sm text-text-2">{status}</p>
  </section>;
}
