"use client";

import { knowledgeSnapshotSchema, type ExamCourseBinding, type ExamSprintOverview, type KnowledgeNode } from "@aistudy/contracts";
import { useEffect, useState } from "react";
import { z } from "zod";
import { ui } from "../design/ui";
import type { ExamIntegrationIntent } from "./client";

/** Display candidates only; bind still checks live source/version/privacy authorization. */
export async function loadExamSkillNodes(courseId: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<KnowledgeNode[]> {
  const response = await fetcher(`/api/opening/courses/${encodeURIComponent(courseId)}/knowledge`, { signal, cache: "no-store" });
  if (!response.ok) throw new Error("课程考点读取失败，请重试。");
  const { snapshot } = z.object({ snapshot: knowledgeSnapshotSchema }).parse(await response.json());
  if (snapshot.courseId !== courseId) throw new Error("课程考点不匹配，请刷新后重试。");
  return snapshot.nodes.filter(node => node.courseId === courseId && node.kind !== "chapter"
    && node.status === "supported" && node.evidenceChunkIds.length > 0);
}

export function examSkillRebindingIntent(binding: ExamCourseBinding, packVersion: string, selected: Record<string, string>): ExamIntegrationIntent {
  return { action: "bind", input: { courseId: binding.courseId, milestoneId: binding.milestoneId, expectedPackVersion: packVersion,
    createKnowledgeNodes: false, materials: binding.materials,
    skills: binding.skills.flatMap(skill => selected[skill.skillId] && selected[skill.skillId] !== skill.nodeId
      ? [{ skillId: skill.skillId, nodeId: selected[skill.skillId]! }] : []),
  } };
}

export function SkillRebinding({ binding, overview, disabled, send }: {
  binding: ExamCourseBinding; overview: ExamSprintOverview; disabled: boolean; send: (intent: ExamIntegrationIntent) => void;
}) {
  const [revision, setRevision] = useState(0), [loading, setLoading] = useState(false);
  const [nodes, setNodes] = useState<KnowledgeNode[] | null>(null), [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!revision) return;
    const controller = new AbortController();
    setLoading(true); setError(null); setNodes(null); setSelected({});
    loadExamSkillNodes(binding.courseId, controller.signal)
      .then(next => { if (!controller.signal.aborted) setNodes(next); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "课程考点读取失败。"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [binding.courseId, revision]);
  const intent = examSkillRebindingIntent(binding, overview.pack.version, selected);
  const changed = intent.action === "bind" && intent.input.skills.length > 0;
  return <details className={`${ui.panel} p-4`}><summary className="min-h-11 cursor-pointer text-sm font-medium py-2">技能变更后重新关联</summary>
    <p className="mt-3 text-xs leading-6 text-text-3">原考点已失效、删除或拆分时，可明确选择有依据的新考点。旧答案和成绩保留在原技能下，新技能从新的学习记录开始；仍有效的原考点不能改贴成绩。</p>
    <button type="button" className={`${ui.quiet} mt-3`} disabled={disabled || loading} onClick={() => setRevision(value => value + 1)}>{loading ? "正在读取考点…" : "读取最新课程考点"}</button>
    {error ? <p role="alert" className="mt-2 text-sm text-danger">{error}</p> : null}
    {nodes ? <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); if (!disabled && changed) send(intent); }}>
      {binding.skills.map(skill => <label key={skill.skillId} className="block space-y-1"><span className={ui.label}>{overview.skills.find(item => item.skillId === skill.skillId)?.title ?? skill.skillId}</span>
        <select className={ui.input} disabled={disabled} value={selected[skill.skillId] ?? ""} onChange={event => setSelected(current => ({ ...current, [skill.skillId]: event.target.value }))}>
          <option value="">保留原关联</option>{nodes.filter(node => node.id !== skill.nodeId).map(node => <option key={node.id} value={node.id}>{node.label} · {node.evidenceChunkIds.length} 段依据</option>)}
        </select></label>)}
      {!nodes.length ? <p className="text-xs leading-6 text-text-3">尚无有依据的课程考点。请在课程页补齐材料并重建图谱后重新读取。</p> : null}
      <button type="submit" className={ui.secondary} disabled={disabled || !changed}>确认新技能关联，保留旧记录</button>
    </form> : null}
  </details>;
}
