"use client";

import type { CourseKnowledgeSync, KnowledgeNode, KnowledgeSnapshot, TutorAction } from "@aistudy/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createOpeningApi, type OpeningApi, type ThinTutorActionView } from "../client/api";
import { LoadError, secondaryButtonClass, ui } from "../design/ui";
import { TUTOR_ACTION_KIND_LABEL } from "../learning/tutor-action-intents";
import { KnowledgeEvidence, knowledgeKindLabel, knowledgeStatusLabel } from "./knowledge-evidence";
import { createKnowledgeRebuildClient, subscribeCourseKnowledgeSync } from "./knowledge-rebuild-client";
import { userFacingMessage } from "../../../lib/user-facing-error";
import { ConfirmKnowledgeNode } from "./confirm-knowledge-node";

const KIND_ORDER: Record<KnowledgeNode["kind"], number> = {
  chapter: 0, concept: 1, procedure: 2, problem_type: 3,
};

export function chaptersFirst(nodes: readonly KnowledgeNode[]): KnowledgeNode[] {
  return [...nodes].sort((a, b) => {
    const kindDiff = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (kindDiff !== 0) return kindDiff;
    return a.label.localeCompare(b.label, "zh-CN");
  });
}

export function nextStepCopy(
  actions: ReadonlyArray<Pick<TutorAction, "reason"> | Pick<ThinTutorActionView, "reason">>,
): string {
  const first = actions[0];
  if (!first) return "先浏览章节材料，再展开知识关系核对依据。";
  return first.reason;
}

/** CT-05: first tutor action → clickable CTA; empty → honest empty (no fake buttons). */
export function nextStepCta(
  action: Pick<ThinTutorActionView, "kind" | "skillLabel" | "reason"> | null | undefined,
): { href: string; label: string; reason: string } | null {
  if (!action) return null;
  const label = TUTOR_ACTION_KIND_LABEL[action.kind] ?? "继续下一步";
  if (action.kind === "clarify") {
    return { href: "#course-assets", label, reason: action.reason };
  }
  const params = new URLSearchParams({ skillLabel: action.skillLabel });
  return { href: `?${params.toString()}#course-practice`, label, reason: action.reason };
}

type KnowledgeRecord = Awaited<ReturnType<OpeningApi["getCourseKnowledge"]>> & {
  sync?: CourseKnowledgeSync;
};

export function knowledgeSyncNotice(
  sync: CourseKnowledgeSync | null | undefined,
  hasNodes = false,
): string | null {
  if (!sync) return null;
  const parsingCount = sync.parsingSourceCount;
  const unreadableCount = sync.unreadableSourceCount ?? 0;

  if (sync.rebuildBlockedByMaterials === true) {
    const issues: string[] = [];
    if (parsingCount > 0) issues.push(`${parsingCount} 份资料仍在解析中`);
    if (unreadableCount > 0) issues.push(`${unreadableCount} 份资料无法读取文字`);
    const detail = issues.length ? `当前有 ${issues.join("、")}。` : "";
    return `旧知识点已保留，请先处理新版资料（若您只是移除了旧资料且课内另有未就绪资料，也请先处理）。${detail}请前往资料页等待解析完成，或重试解析、替换、移除无法读取的资料后再重新整理。`;
  }

  if (sync.status === "pending") {
    const notes: string[] = [];
    if (parsingCount > 0) notes.push(`另有 ${parsingCount} 份资料仍在解析中`);
    if (unreadableCount > 0) notes.push(`另有 ${unreadableCount} 份资料无法读取文字，本次整理不会包含它们`);
    if (notes.length) {
      return `后台正在按当前可读资料整理课程知识点；${notes.join("；")}。完成后可刷新查看。`;
    }
    return "后台正在按最新材料重新整理课程知识点，完成后可刷新查看。";
  }

  if (sync.lastFailedJob) {
    const lead = sync.lastFailedJob.state === "outcome_unknown"
      ? "上次整理知识点结果暂未确认"
      : "上次整理知识点未完成";
    const notes: string[] = [];
    if (parsingCount > 0) notes.push(`${parsingCount} 份资料仍在解析中`);
    if (unreadableCount > 0) notes.push(`${unreadableCount} 份资料无法读取文字`);
    const extra = notes.length ? `，当前另有 ${notes.join("、")}` : "";
    const nextStep = sync.status === "needs_rebuild"
      ? "；当前知识点尚未同步最新材料，请前往资料页检查或稍后重新整理。"
      : "；请稍后刷新查看或重试整理。";
    return `${lead}${extra}${nextStep}`;
  }

  if (unreadableCount > 0 && parsingCount > 0) {
    const drift = sync.status === "needs_rebuild" ? "，且其余已可用材料也尚未同步" : "";
    return `有 ${unreadableCount} 份资料无法读取文字，另有 ${parsingCount} 份资料仍在解析中${drift}。请前往资料页检查无法读取的资料，等待解析完成后再重新整理。`;
  }
  if (unreadableCount > 0) {
    const drift = sync.status === "needs_rebuild" ? "，且其余材料有更新" : "";
    return `有 ${unreadableCount} 份资料无法读取文字（如解析失败或仅含图片），当前知识点未包含这些资料${drift}。请前往资料页重试解析、替换含文字版本或移除后再重新整理。`;
  }
  if (parsingCount > 0) {
    const drift = sync.status === "needs_rebuild" ? "，且已有材料等待同步" : "";
    return `有 ${parsingCount} 份新材料仍在解析中，当前知识点尚未覆盖这些资料${drift}。请等待解析完成后刷新或重新整理。`;
  }
  if (sync.status === "needs_rebuild") {
    return "课程材料已更新，当前知识点尚未同步最新材料，请重新整理知识点。";
  }
  if (!hasNodes && sync.status === "up_to_date" && Object.keys(sync.eligibleSourceVersions).length > 0) {
    return "已检查可读资料，暂未提取到知识点。可以补充课程资料后再重新整理。";
  }
  return null;
}

/**
 * State after a server-confirmed node: the returned record replaces local graph state (so sibling
 * confirmations pin the new version), and an open evidence panel follows the same node id.
 */
export function confirmedKnowledgeState(next: KnowledgeRecord) {
  return {
    record: next,
    snapshot: next.snapshot,
    selected: (previous: KnowledgeNode | null) =>
      previous ? next.snapshot.nodes.find(item => item.id === previous.id) ?? null : null,
  };
}

export function CourseKnowledge({
  courseId,
  api: supplied,
  knowledgeRefreshToken = 0,
}: {
  courseId: string;
  api?: OpeningApi;
  knowledgeRefreshToken?: number;
}) {
  const api = useMemo(() => supplied ?? createOpeningApi(), [supplied]);
  const knowledgeClient = useMemo(
    () => (supplied ? null : createKnowledgeRebuildClient()),
    [supplied],
  );
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot | null>(null);
  const [record, setRecord] = useState<KnowledgeRecord | null>(null);
  const [actions, setActions] = useState<ThinTutorActionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [graphOpen, setGraphOpen] = useState(false);
  const [selected, setSelected] = useState<KnowledgeNode | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const mounted = useRef(true);
  const requestSeq = useRef(0);

  const loadActions = useCallback(async (knowledge: KnowledgeSnapshot, seq = requestSeq.current) => {
    try {
      const tutor = await api.listTutorActions({
        courseId,
        skillLabel: knowledge.nodes.find((n) => n.kind === "chapter")?.label
          ?? knowledge.nodes[0]?.label
          ?? "课程",
      });
      if (mounted.current && requestSeq.current === seq) {
        setActions(tutor.slice(0, 3));
      }
    } catch {
      if (mounted.current && requestSeq.current === seq) {
        setActions([]);
      }
    }
  }, [api, courseId]);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true); setError(""); setUnavailable(false);
    try {
      const knowledge: KnowledgeRecord = knowledgeClient
        ? await knowledgeClient.read(courseId)
        : await api.getCourseKnowledge(courseId);
      if (!mounted.current || requestSeq.current !== seq) return;
      setSnapshot(knowledge.snapshot);
      setRecord(knowledge);
      setSelected(null);
      await loadActions(knowledge.snapshot, seq);
    } catch (reason) {
      if (!mounted.current || requestSeq.current !== seq) return;
      const message = userFacingMessage(reason, "课程知识暂时无法读取");
      if (/503|不可用|not configured|CONFIGURATION/i.test(message)) {
        setUnavailable(true);
        setSnapshot(null);
        setError("知识服务不可用，未展示示例内容。");
      } else {
        setError(message);
      }
    } finally {
      if (mounted.current && requestSeq.current === seq) {
        setLoading(false);
      }
    }
  }, [api, courseId, knowledgeClient, loadActions]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      requestSeq.current += 1;
    };
  }, [load, knowledgeRefreshToken]);

  useEffect(() => subscribeCourseKnowledgeSync(courseId, (latest) => {
    if (!mounted.current) return;
    const seq = ++requestSeq.current;
    setLoading(false);
    setError("");
    setUnavailable(false);
    setSnapshot(latest.snapshot);
    setRecord(latest);
    setSelected((previous) =>
      previous ? latest.snapshot.nodes.find((item) => item.id === previous.id) ?? null : null,
    );
    void loadActions(latest.snapshot, seq);
  }), [courseId, loadActions]);

  const ordered = useMemo(
    () => (snapshot ? chaptersFirst(snapshot.nodes) : []),
    [snapshot],
  );
  const chapters = ordered.filter((n) => n.kind === "chapter");
  const cta = nextStepCta(actions[0]);
  const syncNotice = knowledgeSyncNotice(record?.sync, Boolean(snapshot && snapshot.nodes.length > 0));

  if (loading) {
    return <p className="text-xs text-text-3" role="status">正在读取课程知识…</p>;
  }
  if (unavailable) {
    return <LoadError message={error || "知识服务不可用"} onRetry={() => void load()} />;
  }
  if (error) {
    return <LoadError message={error} onRetry={() => void load()} />;
  }
  if (!snapshot || snapshot.nodes.length === 0) {
    return (
      <section className="space-y-2" aria-labelledby="course-knowledge-heading" id="course-knowledge">
        <h2 className="text-sm font-semibold text-text" id="course-knowledge-heading">课程知识</h2>
        <p className="text-xs leading-6 text-text-3">还没有整理出课程知识。添加材料后，可在这里查看章节和概念。</p>
        {syncNotice ? <p role="status" className="text-xs leading-6 text-text-2">{syncNotice}</p> : null}
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-labelledby="course-knowledge-heading" id="course-knowledge">
      <div>
        <h2 className="text-sm font-semibold text-text" id="course-knowledge-heading">课程知识</h2>
        <p className="mt-1 text-xs leading-6 text-text-3">选择章节查看材料依据，或继续下一步练习。</p>
        {syncNotice ? <p role="status" className="mt-1 text-xs leading-6 text-text-2">{syncNotice}</p> : null}
      </div>
      <div className="rounded-lg border border-line bg-surface-2 p-3">
        <h3 className="text-xs font-semibold text-text">章节</h3>
        <ul className="mt-2 space-y-1.5 text-xs leading-5 text-text-2" aria-label="课程章节">
          {(chapters.length ? chapters : ordered.slice(0, 5)).map((node) => (
            <li key={node.id}>
              <button
                type="button"
                className="min-h-11 py-2 text-left text-accent underline-offset-2 hover:underline"
                onClick={() => { setSelected(node); setGraphOpen(true); }}
              >
                {node.label}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-3 space-y-2">
          <p className="text-xs leading-5 text-text-2">
            <span className="font-medium text-text">下一步：</span>
            {cta ? cta.reason : "暂无服务器推荐的下一步。可先独立练习，或打开材料核对依据。"}
          </p>
          {cta ? (
            <a className={ui.primary} href={cta.href}>
              {cta.label}
            </a>
          ) : (
            <p className="text-xs leading-5 text-text-3">
              目前还没有下一步建议，可以先阅读本课材料。
            </p>
          )}
        </div>
      </div>
      <div>
        <button
          type="button"
          className={secondaryButtonClass}
          aria-expanded={graphOpen}
          onClick={() => setGraphOpen((v) => !v)}
        >
          {graphOpen ? "收起知识关系" : "展开知识关系"}
        </button>
        {graphOpen ? (
          <ul className="mt-3 space-y-2 text-xs leading-5 text-text-2" aria-label="知识关系">
            {ordered.map((node) => (
              <li key={node.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-2">
                <button type="button" className="min-h-11 min-w-0 flex-1 py-2 text-left font-medium text-text" onClick={() => setSelected(node)}>
                  {node.label}
                  <span className="ml-2 font-normal text-text-2">{knowledgeKindLabel[node.kind]} · {knowledgeStatusLabel[node.status]}</span>
                </button>
                {record ? <ConfirmKnowledgeNode node={node} record={record} api={api} onReload={() => void load()}
                  onConfirmed={next => {
                    const state = confirmedKnowledgeState({ ...next, sync: (next as KnowledgeRecord).sync ?? record.sync });
                    setRecord(state.record); setSnapshot(state.snapshot); setSelected(state.selected);
                    void loadActions(next.snapshot);
                  }} /> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {selected ? <KnowledgeEvidence node={selected} onClose={() => setSelected(null)} courseMediaAvailable /> : null}
    </section>
  );
}
