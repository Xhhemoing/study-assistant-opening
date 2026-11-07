"use client";

import { LoaderCircle, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { ui } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";
import { createKnowledgeRebuildClient, KnowledgeRebuildRequestError, type CourseKnowledgeRecord, type KnowledgeRebuildClient } from "./knowledge-rebuild-client";

export const KNOWLEDGE_POLL_INTERVAL_MS = 3_000;
export const KNOWLEDGE_POLL_TIMEOUT_MS = 180_000;
const TERMINAL_READ_STATUSES = new Set([401, 403, 404]);
const FAILED_COPY = "整理请求没有完成，请稍后重试。";

type RebuildState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "polling" }
  | { kind: "done"; nodeCount: number }
  | { kind: "timeout" }
  | { kind: "failed"; message: string };

type RebuildOperation = { controller: AbortController; deadline?: ReturnType<typeof setTimeout>; poll?: ReturnType<typeof setTimeout> };

function stopOperation(operation: MutableRefObject<RebuildOperation | null>, current: RebuildOperation) {
  current.controller.abort();
  clearTimeout(current.deadline);
  clearTimeout(current.poll);
  if (operation.current === current) operation.current = null;
}

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
  const operation = useRef<RebuildOperation | null>(null), notify = useRef(onRebuilt);
  useEffect(() => { notify.current = onRebuilt; }, [onRebuilt]);
  useEffect(() => () => { if (operation.current) stopOperation(operation, operation.current); }, []);
  const stop = (current: RebuildOperation) => stopOperation(operation, current);

  // Aborting only stops this page from waiting; a rebuild the server already queued keeps running.
  async function start() {
    if (operation.current) return;
    const current: RebuildOperation = { controller: new AbortController() };
    const { signal } = current.controller;
    const live = () => operation.current === current;
    operation.current = current;
    current.deadline = setTimeout(() => {
      if (!live()) return;
      stop(current);
      setState({ kind: "timeout" });
    }, KNOWLEDGE_POLL_TIMEOUT_MS);
    setState({ kind: "requesting" });
    try {
      const { version: baseline } = await client.read(courseId, signal);
      if (!live()) return;
      await client.rebuild(courseId, `knowledge-rebuild:${crypto.randomUUID()}`, signal);
      if (!live()) return;
      setState({ kind: "polling" });
      // The rebuild job has no status route; a finished rebuild always stores a newer knowledge version.
      const tick = async () => {
        let latest: CourseKnowledgeRecord | null = null;
        try { latest = await client.read(courseId, signal); }
        catch (reason) {
          // Lost access or a missing course will not recover by waiting; other failures say nothing about the queued job.
          if (live() && reason instanceof KnowledgeRebuildRequestError && TERMINAL_READ_STATUSES.has(reason.status)) {
            stop(current);
            setState({ kind: "failed", message: userFacingMessage(reason, FAILED_COPY) });
            return;
          }
        }
        if (!live()) return;
        if (latest && latest.version > baseline) {
          stop(current);
          setState({ kind: "done", nodeCount: latest.snapshot.nodes.length });
          notify.current?.(latest);
        } else current.poll = setTimeout(() => void tick(), KNOWLEDGE_POLL_INTERVAL_MS);
      };
      current.poll = setTimeout(() => void tick(), KNOWLEDGE_POLL_INTERVAL_MS);
    } catch (reason) {
      if (!live()) return;
      stop(current);
      setState({ kind: "failed", message: userFacingMessage(reason, FAILED_COPY) });
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
