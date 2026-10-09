"use client";

import type { KnowledgeNode, KnowledgeSnapshot, TutorAction } from "@aistudy/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createOpeningApi, type OpeningApi, type ThinTutorActionView } from "../client/api";
import { LoadError, secondaryButtonClass } from "../design/ui";
import { KnowledgeEvidence } from "./knowledge-evidence";

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

  if (loading) {
    return <p className="text-xs text-zinc-500" role="status">正在读取课程知识…</p>;
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
        <h2 className="text-sm font-semibold text-zinc-800" id="course-knowledge-heading">课程知识</h2>
        <p className="text-xs leading-6 text-zinc-500">尚无知识节点。有材料后再构建；不会填充示例图。</p>
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-labelledby="course-knowledge-heading" id="course-knowledge">
      <div>
        <h2 className="text-sm font-semibold text-zinc-800" id="course-knowledge-heading">课程知识</h2>
        <p className="mt-1 text-xs leading-6 text-zinc-500">先看章节与下一步；知识关系按需展开。不显示掌握百分比。</p>
      </div>
      <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3">
        <h3 className="text-xs font-semibold text-zinc-800">章节</h3>
        <ul className="mt-2 space-y-1.5 text-xs leading-5 text-zinc-700" aria-label="课程章节">
          {(chapters.length ? chapters : ordered.slice(0, 5)).map((node) => (
            <li key={node.id}>
              <button
                type="button"
                className="text-left text-emerald-800 underline-offset-2 hover:underline"
                onClick={() => { setSelected(node); setGraphOpen(true); }}
              >
                {node.label}
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs leading-5 text-zinc-700" role="status">
          <span className="font-medium text-zinc-900">下一步：</span>
          {nextStepCopy(actions)}
        </p>
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
          <ul className="mt-3 space-y-2 text-xs leading-5 text-zinc-700" aria-label="知识关系">
            {ordered.map((node) => (
              <li key={node.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2">
                <button type="button" className="min-w-0 flex-1 text-left font-medium text-zinc-900" onClick={() => setSelected(node)}>
                  {node.label}
                  <span className="ml-2 font-normal text-zinc-500">{node.kind} · {node.status}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {selected ? <KnowledgeEvidence node={selected} onClose={() => setSelected(null)} /> : null}
    </section>
  );
}
