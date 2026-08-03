"use client";

import { ArrowLeft, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useStudyProvider } from "../../lib/data/react";
import { ReasonDrawer } from "../assessment/reason-drawer";
import { findPracticeResult, type PracticeResultData } from "./result-summary-model";
import { ResultSummary } from "./result-summary";

export function PracticeResult() {
  const provider = useStudyProvider();
  const searchParams = useSearchParams();
  const eventId = searchParams.get("event");
  const [data, setData] = useState<PracticeResultData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reasonOpen, setReasonOpen] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    if (!provider) return;
    if (!eventId) {
      setLoading(false);
      setError("找不到这次作答记录，请从练习入口重新开始。");
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    provider.getDiagnostics()
      .then((diagnostics) => {
        if (!active) return;
        const result = findPracticeResult(diagnostics, eventId);
        setData(result);
        if (!result) setError("这次作答记录暂时不可用，请返回今日计划重试。");
      })
      .catch(() => {
        if (active) setError("结果加载失败，请重试。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [eventId, provider, retryToken]);

  async function recordCorrection(note: string) {
    if (!provider || !data) return;
    await provider.recordStatusCorrection(data.event.syllabusPointId, note);
  }

  if (loading || !provider) return <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8"><p className="border-y border-line py-8 text-sm text-text-dim" role="status">正在整理作答结果...</p></main>;
  if (error || !data) return <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8"><Link className="inline-flex w-fit items-center gap-2 text-sm text-text-dim hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn"><ArrowLeft aria-hidden="true" size={16} />返回学习空间</Link><section className="space-y-4 border-y border-line py-8" role="alert"><p className="text-sm text-danger">{error || "找不到这次作答结果。"}</p><button className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setRetryToken((value) => value + 1)} type="button"><RefreshCw aria-hidden="true" size={16} />重试</button></section></main>;
  return <><ResultSummary data={data} nextHref="/learn" onOpenReason={() => setReasonOpen(true)} /><ReasonDrawer onClose={() => setReasonOpen(false)} onCorrection={recordCorrection} open={reasonOpen} status={data.status} /></>;
}
