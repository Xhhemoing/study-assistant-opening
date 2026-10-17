import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ExamCourseBinding, ExamSprintOverview, KnowledgeNode } from "@aistudy/contracts";
import { examSkillRebindingIntent, loadExamSkillNodes, SkillRebinding } from "./skill-rebinding";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const binding: ExamCourseBinding = { courseId: id(1), milestoneId: null, packSourceId: id(2), boundAt: "2026-10-17T00:00:00Z",
  skills: [{ skillId: "limits", nodeId: id(3), requirementKey: `exam-skill:${id(3)}` }], materials: [] };
const node: KnowledgeNode = { id: id(4), courseId: id(1), label: "Limit laws", kind: "concept", status: "supported", evidenceChunkIds: [id(5)] };

describe("explicit exam skill recovery", () => {
  it("offers only supported course skills with evidence, leaving live authority to the server", async () => {
    const fetcher = vi.fn(async () => Response.json({ snapshot: { courseId: id(1), version: 3, edges: [], nodes: [node,
      { ...node, id: id(6), kind: "chapter" }, { ...node, id: id(7), status: "needs_check" },
      { ...node, id: id(8), status: "suggested" }, { ...node, id: id(9), evidenceChunkIds: [] },
      { ...node, id: id(10), courseId: id(99) },
    ] } }));
    const signal = new AbortController().signal;
    expect(await loadExamSkillNodes(id(1), signal, fetcher)).toEqual([node]);
    expect(fetcher).toHaveBeenCalledWith(`/api/opening/courses/${id(1)}/knowledge`, { signal, cache: "no-store" });
  });
  it("does not accept failed, malformed or different-course graph reads", async () => {
    const signal = new AbortController().signal;
    await expect(loadExamSkillNodes(id(1), signal, async () => new Response(null, { status: 503 }))).rejects.toThrow("读取失败");
    await expect(loadExamSkillNodes(id(1), signal, async () => Response.json({ snapshot: {} }))).rejects.toThrow();
    await expect(loadExamSkillNodes(id(1), signal, async () => Response.json({ snapshot: { courseId: id(99), version: 1, nodes: [], edges: [] } }))).rejects.toThrow("不匹配");
  });
  it("uses the existing bind command for only explicit changed choices and keeps material bindings", () => {
    expect(examSkillRebindingIntent(binding, "1", { limits: id(3), unknown: id(99) })).toMatchObject({ action: "bind", input: { skills: [] } });
    expect(examSkillRebindingIntent(binding, "1", { limits: id(4) })).toEqual({ action: "bind", input: {
      courseId: id(1), milestoneId: null, expectedPackVersion: "1", createKnowledgeNodes: false,
      skills: [{ skillId: "limits", nodeId: id(4) }], materials: [],
    } });
    expect(binding.skills[0]!.nodeId).toBe(id(3));
  });
  it("explains preserved history and offers an explicit loading action", () => {
    const overview = { pack: { version: "1" }, skills: [] } as unknown as ExamSprintOverview;
    const html = renderToStaticMarkup(createElement(SkillRebinding, { binding, overview, disabled: false, send: () => undefined }));
    expect(html).toContain("技能变更后重新关联");
    expect(html).toContain("旧答案和成绩保留在原技能下");
    expect(html).toContain("读取最新课程考点");
    expect(html).not.toContain("<select");
  });
});
