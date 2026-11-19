"use client";

import { LoaderCircle, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { ui } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";
import {
  createKnowledgeRebuildClient,
  KnowledgeRebuildRequestError,
  publishCourseKnowledgeSync,
  type CourseKnowledgeRecord,
  type KnowledgeRebuildClient,
  type KnowledgeRebuildTerminalOutcome,
} from "./knowledge-rebuild-client";

export type { KnowledgeRebuildTerminalOutcome };

export const KNOWLEDGE_POLL_INTERVAL_MS = 3_000;
export const KNOWLEDGE_POLL_TIMEOUT_MS = 180_000;
const TERMINAL_READ_STATUSES = new Set([401, 403, 404]);
const FAILED_COPY = "整理请求没有完成，请稍后重试。";

type DoneOutcome =
  | "complete"
  | "pending_follow_up"
  | "needs_rebuild"
  | "needs_rebuild_blocked"
  | "zero_nodes_checked"
  | "partial_materials";

type RebuildState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "polling" }
  | {
      kind: "done";
      outcome: DoneOutcome;
      nodeCount: number;
      parsingSourceCount: number;
      unreadableSourceCount: number;
      hasEligibleSources: boolean;
    }
  | { kind: "timeout" }
  | { kind: "failed"; message: string };

type RebuildOperation = { controller: AbortController; deadline?: ReturnType<typeof setTimeout>; poll?: ReturnType<typeof setTimeout> };

function stopOperation(operation: MutableRefObject<RebuildOperation | null>, current: RebuildOperation) {
  current.controller.abort();
  clearTimeout(current.deadline);
  clearTimeout(current.poll);
  if (operation.current === current) operation.current = null;
}

function classifyDoneState(latest: CourseKnowledgeRecord): Extract<RebuildState, { kind: "done" }> {
  const sync = latest.sync;
  const nodeCount = latest.snapshot.nodes.length;
  const parsingSourceCount = sync?.parsingSourceCount ?? 0;
  const unreadableSourceCount = sync?.unreadableSourceCount ?? 0;
  const hasEligibleSources = Boolean(sync && Object.keys(sync.eligibleSourceVersions).length > 0);
  let outcome: DoneOutcome;
  if (sync?.status === "pending") {
    outcome = "pending_follow_up";
  } else if (sync?.status === "needs_rebuild") {
    outcome = sync.rebuildBlockedByMaterials === true ? "needs_rebuild_blocked" : "needs_rebuild";
  } else if (nodeCount === 0) {
    outcome = parsingSourceCount > 0 || unreadableSourceCount > 0 ? "partial_materials" : "zero_nodes_checked";
  } else if (parsingSourceCount > 0 || unreadableSourceCount > 0) {
    outcome = "partial_materials";
  } else {
    outcome = "complete";
  }
  return {
    kind: "done",
    outcome,
    nodeCount,
    parsingSourceCount,
    unreadableSourceCount,
    hasEligibleSources,
  };
}

function materialRemainderCopy(parsingSourceCount: number, unreadableSourceCount: number): string {
  const parts: string[] = [];
  if (parsingSourceCount > 0) parts.push(`${parsingSourceCount} 份资料仍在解析中`);
  if (unreadableSourceCount > 0) parts.push(`${unreadableSourceCount} 份资料无法读取文字`);
  return parts.join("、");
}

function statusText(state: RebuildState): string {
  if (state.kind === "requesting" || state.kind === "polling") {
    return "整理中：正在从已解析的资料里整理知识点，可能需要几分钟，可以留在本页等待。";
  }
  if (state.kind === "done") {
    const remainder = materialRemainderCopy(state.parsingSourceCount, state.unreadableSourceCount);
    if (state.outcome === "pending_follow_up") {
      const countPart = state.nodeCount ? `（共 ${state.nodeCount} 个知识点）` : "";
      const extra = remainder ? `；另有 ${remainder}` : "";
      return `本批完成${countPart}，下一批正在整理${extra}。`;
    }
    if (state.outcome === "needs_rebuild_blocked") {
      return "本批完成，材料又有变化；旧知识点已保留，请先前往资料页处理未就绪或无法读取的资料后再重新整理。";
    }
    if (state.outcome === "needs_rebuild") {
      const extra = remainder ? `（另有 ${remainder}）` : "";
      return `本批完成，材料又有变化${extra}，请点击“重新整理知识点”同步最新内容。`;
    }
    if (state.outcome === "zero_nodes_checked") {
      return state.hasEligibleSources
        ? "已检查可读资料，未提取到知识点。"
        : "已检查可读资料，未提取到知识点；请确认资料已解析完成且包含可读取文字。";
    }
    if (state.outcome === "partial_materials") {
      if (state.nodeCount === 0) {
        return `已检查可读资料，未提取到知识点；当前有 ${remainder}，请前往资料页查看处理后再整理。`;
      }
      return `已整理当前可读资料（共 ${state.nodeCount} 个知识点），但有 ${remainder}，尚未覆盖全部资料；请前往资料页处理后再整理。`;
    }
    return `已整理：共 ${state.nodeCount} 个知识点。刷新页面可查看新的知识图。`;
  }
  if (state.kind === "timeout") return "没有看到新的整理结果，可以稍后刷新再看。";
  return "";
}

function requestedJobFailureMessage(state: KnowledgeRebuildTerminalOutcome): string {
  if (state === "outcome_unknown") {
    return "本次整理结果暂未确认，以刷新后为准；请稍后刷新确认，无需立即重复提交。";
  }
  if (state === "cancelled") {
    return "本次整理已取消；如需更新知识点，请重新点击整理。";
  }
  return "本次整理未能完成，请稍后重试；若资料无法读取，请先在资料页检查。";
}

export function KnowledgeRebuildControl({ courseId, client: suppliedClient, organized = false, onRebuilt, onSyncUpdated }: {
  courseId: string;
  client?: KnowledgeRebuildClient;
  organized?: boolean;
  onRebuilt?: (record: CourseKnowledgeRecord) => void;
  onSyncUpdated?: (record: CourseKnowledgeRecord, outcome: KnowledgeRebuildTerminalOutcome) => void;
}) {
  const client = useMemo(() => suppliedClient ?? createKnowledgeRebuildClient(), [suppliedClient]);
  const [state, setState] = useState<RebuildState>({ kind: "idle" });
  const operation = useRef<RebuildOperation | null>(null);
  const notifyRebuilt = useRef(onRebuilt);
  const notifySyncUpdated = useRef(onSyncUpdated);
  useEffect(() => { notifyRebuilt.current = onRebuilt; }, [onRebuilt]);
  useEffect(() => { notifySyncUpdated.current = onSyncUpdated; }, [onSyncUpdated]);
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
      const initial = await client.read(courseId, { signal });
      if (!live()) return;
      const baseline = initial.version;
      const baselineBuilt = initial.sync?.lastBuiltVersion ?? null;
      const receipt = await client.rebuild(courseId, `knowledge-rebuild:${crypto.randomUUID()}`, signal);
      if (!live()) return;
      setState({ kind: "polling" });
      const tick = async () => {
        let latest: CourseKnowledgeRecord | null = null;
        try { latest = await client.read(courseId, { signal, jobId: receipt.jobId }); }
        catch (reason) {
          // Lost access or a missing course will not recover by waiting; other failures say nothing about the queued job.
          if (live() && reason instanceof KnowledgeRebuildRequestError && TERMINAL_READ_STATUSES.has(reason.status)) {
            stop(current);
            setState({ kind: "failed", message: userFacingMessage(reason, FAILED_COPY) });
            return;
          }
        }
        if (!live()) return;

        if (latest?.sync && "requestedJob" in latest.sync) {
          const requestedJob = latest.sync.requestedJob;
          if (requestedJob && requestedJob.jobId === receipt.jobId) {
            if (requestedJob.state === "failed" || requestedJob.state === "outcome_unknown" || requestedJob.state === "cancelled") {
              stop(current);
              setState({ kind: "failed", message: requestedJobFailureMessage(requestedJob.state) });
              publishCourseKnowledgeSync(courseId, latest, requestedJob.state);
              notifySyncUpdated.current?.(latest, requestedJob.state);
              return;
            }
            if (requestedJob.state === "succeeded") {
              stop(current);
              setState(classifyDoneState(latest));
              publishCourseKnowledgeSync(courseId, latest, "succeeded");
              notifyRebuilt.current?.(latest);
              return;
            }
          }
          current.poll = setTimeout(() => void tick(), KNOWLEDGE_POLL_INTERVAL_MS);
          return;
        }

        const completed = latest?.sync
          ? latest.sync.activeJobId !== receipt.jobId
            && (
              (latest.sync.lastBuiltVersion !== null
                && (baselineBuilt === null || latest.sync.lastBuiltVersion > baselineBuilt))
              || (!receipt.created && latest.sync.status === "up_to_date" && latest.sync.activeJobId === null)
            )
          : Boolean(latest && latest.version > baseline);
        if (latest && completed) {
          stop(current);
          setState(classifyDoneState(latest));
          publishCourseKnowledgeSync(courseId, latest, "succeeded");
          notifyRebuilt.current?.(latest);
        } else {
          current.poll = setTimeout(() => void tick(), KNOWLEDGE_POLL_INTERVAL_MS);
        }
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
