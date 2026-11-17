"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, FileLock2, LoaderCircle } from "lucide-react";
import {
  fetchMaterialAuthorReview, MaterialAuthorReviewError,
  type MaterialAuthorReviewFailure, type MaterialAuthorSelector,
} from "./material-author-review-client";

export type MaterialAuthorContainerProps = {
  /** Non-null only after explicit host selection; not an authorization grant. */
  selector: MaterialAuthorSelector | null;
  fetch: typeof fetch;
};

type State = { status: "loading" } | { status: "unavailable" }
  | { status: "error"; code: MaterialAuthorReviewFailure };
const messages: Record<MaterialAuthorReviewFailure, string> = {
  invalid_selection: "资料选择无效，请重新选择。",
  session: "会话已失效，请恢复登录后重新选择资料。",
  not_found: "找不到资料或无权访问，请重新选择。",
  stale: "资料选择已失效，请重新选择或重试读取。",
  unavailable: "资料作者审阅暂不可用，请稍后重试。",
  invalid_response: "无法安全读取资料作者审阅，请稍后重试。",
  network: "资料作者审阅读取失败，请稍后重试。",
};

export function MaterialAuthorContainer({ selector, fetch: transport }: MaterialAuthorContainerProps) {
  // Key the entire request owner, not just its data. Scope changes synchronously
  // discard visible state and unmount/abort the old owner, including A→B→A.
  const key = selector === null ? null : JSON.stringify([
    selector.actorKey, selector.courseId, selector.sourceId, selector.version, selector.accessEpoch,
  ]);
  return (
    <section aria-label="资料作者审阅" className="space-y-3 rounded-xl border border-border bg-card p-4 text-card-foreground">
      <h2 className="flex items-center gap-2 text-base font-semibold"><FileLock2 aria-hidden="true" className="h-4 w-4" />资料作者审阅</h2>
      {selector === null ? <p role="status" className="text-sm text-muted-foreground">请选择一项资料后读取作者审阅。</p>
        : <SelectedReview key={key} selector={selector} fetch={transport} />}
      <p className="text-sm">人工草稿不可编辑：缺少获准资料信息；尚未保存或发布</p>
      <p className="text-sm text-muted-foreground">未绑定，无法打开来源。PDF 字节与来源真实性尚未验证。</p>
      <p className="text-xs text-muted-foreground">MODULE_PENDING · not_ready · 已执行题目：0。不是首答界面；未记录帮助或接触。</p>
    </section>
  );
}

function SelectedReview({ selector, fetch: transport }: { selector: MaterialAuthorSelector; fetch: typeof fetch }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const { actorKey, courseId, sourceId, version, accessEpoch } = selector;
  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    setState({ status: "loading" });
    void fetchMaterialAuthorReview({ actorKey, courseId, sourceId, version, accessEpoch }, {
      fetch: transport, signal: controller.signal,
    }).then(() => {
      if (!controller.signal.aborted && generation.current === current) setState({ status: "unavailable" });
    }, error => {
      if (!controller.signal.aborted && generation.current === current) {
        setState({ status: "error", code: error instanceof MaterialAuthorReviewError ? error.code : "unavailable" });
      }
    });
    return () => { controller.abort(); ++generation.current; };
  }, [actorKey, courseId, sourceId, version, accessEpoch, transport, attempt]);

  if (state.status === "loading") return <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />正在读取资料作者审阅…</p>;
  if (state.status === "unavailable") return <p role="status" className="text-sm text-muted-foreground">资料作者审阅暂不可用，尚未接入资料读取。</p>;
  const retryable = state.code !== "session" && state.code !== "not_found" && state.code !== "invalid_selection";
  return <div className="space-y-2">
    <p role="alert" className="flex items-center gap-2 text-sm"><AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0" />{messages[state.code]}</p>
    {retryable && <button type="button" className="rounded-md border border-border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => {
      setState({ status: "loading" }); setAttempt(value => value + 1);
    }}>重试读取</button>}
  </div>;
}
