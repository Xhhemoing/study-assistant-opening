// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpeningApi } from "../client/api";
import { CourseKnowledge } from "./course-knowledge";

const courseId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const nodeA = "11111111-1111-4111-8111-111111111111";
const nodeB = "22222222-2222-4222-8222-222222222222";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("refetches course knowledge when knowledgeRefreshToken increments", async () => {
  const getCourseKnowledge = vi.fn()
    .mockResolvedValueOnce({
      version: 1,
      sourceVersions: {},
      snapshot: { courseId, version: 1, edges: [], nodes: [] },
    })
    .mockResolvedValueOnce({
      version: 2,
      sourceVersions: {},
      snapshot: {
        courseId,
        version: 2,
        edges: [],
        nodes: [
          { id: nodeA, courseId, label: "第一章 向量空间", kind: "chapter" as const, evidenceChunkIds: [], status: "suggested" as const },
          { id: nodeB, courseId, label: "线性无关", kind: "concept" as const, evidenceChunkIds: [], status: "suggested" as const },
        ],
      },
    });
  const listTutorActions = vi.fn().mockResolvedValue([]);
  const api = { getCourseKnowledge, listTutorActions } as unknown as OpeningApi;

  await act(async () => root.render(<CourseKnowledge courseId={courseId} api={api} knowledgeRefreshToken={0} />));
  expect(getCourseKnowledge).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("还没有整理出课程知识");

  await act(async () => root.render(<CourseKnowledge courseId={courseId} api={api} knowledgeRefreshToken={1} />));
  expect(getCourseKnowledge).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("第一章 向量空间");
});
