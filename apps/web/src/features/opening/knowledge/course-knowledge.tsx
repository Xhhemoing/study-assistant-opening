"use client";

import type { KnowledgeNode, KnowledgeSnapshot, TutorAction } from "@aistudy/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createOpeningApi, type OpeningApi, type ThinTutorActionView } from "../client/api";
import { LoadError, secondaryButtonClass, ui } from "../design/ui";
import { TUTOR_ACTION_KIND_LABEL } from "../learning/tutor-action-intents";
import { KnowledgeEvidence, knowledgeKindLabel, knowledgeStatusLabel } from "./knowledge-evidence";

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

export function CourseKnowledge({
  courseId,
  api: supplied,
}: {
  courseId: string;
  api?: OpeningApi;
}) {
  const api = useMemo(() => supplied ?? createOpeningApi(), [supplied]);
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot | null>(null);
  const [actions, setActions] = useState<ThinTutorActionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [graphOpen, setGraphOpen] = useState(false);
  const [selected, setSelected] = useState<KnowledgeNode | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(""); setUnavailable(false);
    try {
      const knowledge = await api.getCourseKnowledge(courseId);
      setSnapshot(knowledge.snapshot);
      try {
        const tutor = await api.listTutorActions({
          courseId,
          skillLabel: knowledge.snapshot.nodes.find((n) => n.kind === "chapter")?.label
            ?? knowledge.snapshot.nodes[0]?.label
            ?? "课程",
        });
        setActions(tutor.slice(0, 3));
      } catch {
        setActions([]);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "课程知识暂时无法读取";
      if (/503|不可用|not configured|CONFIGURATION/i.test(message)) {
        setUnavailable(true);
        setSnapshot(null);
        setError("知识服务不可用，未展示示例内容。");
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, [api, courseId]);

  useEffect(() => { void load(); }, [load]);

  const ordered = useMemo(
    () => (snapshot ? chaptersFirst(snapshot.nodes) : []),
    [snapshot],
  );
  const chapters = ordered.filter((n) => n.kind === "chapter");
  const cta = nextStepCta(actions[0]);

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
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-labelledby="course-knowledge-heading" id="course-knowledge">
      <div>
        <h2 className="text-sm font-semibold text-text" id="course-knowledge-heading">课程知识</h2>
        <p className="mt-1 text-xs leading-6 text-text-3">选择章节查看材料依据，或继续下一步练习。</p>
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
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {selected ? <KnowledgeEvidence node={selected} onClose={() => setSelected(null)} courseMediaAvailable /> : null}
    </section>
  );
}
