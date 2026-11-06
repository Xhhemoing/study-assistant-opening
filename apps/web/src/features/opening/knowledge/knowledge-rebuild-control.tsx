"use client";

import { LoaderCircle, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ui } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";
import { createKnowledgeRebuildClient, type CourseKnowledgeRecord, type KnowledgeRebuildClient } from "./knowledge-rebuild-client";

export const KNOWLEDGE_POLL_INTERVAL_MS = 3_000;
export const KNOWLEDGE_POLL_TIMEOUT_MS = 180_000;

type RebuildState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "polling"; baseline: number; startedAt: number }
  | { kind: "done"; nodeCount: number }
  | { kind: "timeout" }
  | { kind: "failed"; message: string };

function statusText(state: RebuildState): string {
  if (state.kind === "requesting" || state.kind === "polling") return "整理中：正在从已解析的资料里整理知识点，可能需要几分钟，可以留在本页等待。";
  if (state.kind === "done") return state.nodeCount ? `已整理：共 ${state.nodeCount} 个知识点。刷新页面可查看新的知识图。` : "已整理，但当前资料里没有整理出知识点；请确认资料已解析完成。";
  if (state.kind === "timeout") return "没有看到新的整理结果，可以稍后刷新再看。";
  return "";
}

export function KnowledgeRebuildControl({ courseId, client: suppliedClient, organized = false, onRebuilt }: {
  courseId: string;
  client?: KnowledgeRebuildClient;
  organized?: boolean;
  onRebuilt?: (record: CourseKnowledgeRecord) => void;
}) {
  const client = useMemo(() => suppliedClient ?? createKnowledgeRebuildClient(), [suppliedClient]);
  const [state, setState] = useState<RebuildState>({ kind: "idle" });
  const running = useRef(false), active = useRef(true), notify = useRef(onRebuilt);
  useEffect(() => { notify.current = onRebuilt; }, [onRebuilt]);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const polling = state.kind === "polling" ? state : null;
  useEffect(() => {
    if (!polling) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The rebuild job has no status route; a finished rebuild always stores a newer knowledge version.
    const tick = async () => {
      // A failed read says nothing about the queued job, so the next tick reads again until the deadline.
      const latest = await client.read(courseId, controller.signal).catch(() => null);
      if (controller.signal.aborted) return;
      if (latest && latest.version > polling.baseline) {
        running.current = false;
        setState({ kind: "done", nodeCount: latest.snapshot.nodes.length });
        notify.current?.(latest);
      } else if (Date.now() - polling.startedAt >= KNOWLEDGE_POLL_TIMEOUT_MS) {
        running.current = false;
        setState({ kind: "timeout" });
      } else timer = setTimeout(() => void tick(), KNOWLEDGE_POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void tick(), KNOWLEDGE_POLL_INTERVAL_MS);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [client, courseId, polling]);

  async function start() {
    if (running.current) return;
    running.current = true;
    setState({ kind: "requesting" });
    try {
      const { version } = await client.read(courseId);
      await client.rebuild(courseId, `knowledge-rebuild:${crypto.randomUUID()}`);
      if (active.current) setState({ kind: "polling", baseline: version, startedAt: Date.now() });
    } catch (reason) {
      running.current = false;
      if (active.current) setState({ kind: "failed", message: userFacingMessage(reason, "整理请求没有完成，请稍后重试。") });
    }
  }

  const working = state.kind === "requesting" || state.kind === "polling";
  return <div className="space-y-1">
    <button type="button" className={organized ? ui.quiet : ui.secondary} disabled={working} onClick={() => void start()}>
      {working ? <LoaderCircle aria-hidden="true" size={14} className="animate-spin motion-reduce:animate-none" /> : <Sparkles aria-hidden="true" size={14} />}
      {working ? "整理中…" : organized ? "重新整理知识点" : "整理知识点"}
    </button>
    <p role="status" className="text-xs leading-5 text-text-2">{statusText(state)}</p>
    {state.kind === "failed" ? <p role="alert" className="text-xs leading-5 text-danger">{state.message}</p> : null}
  </div>;
}
