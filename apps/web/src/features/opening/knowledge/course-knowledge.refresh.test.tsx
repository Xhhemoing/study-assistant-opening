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
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it("shows unreadable and parsing guidance on an empty graph and zero-node checked notice when eligible materials produced no nodes", async () => {
  const getCourseKnowledge = vi.fn()
    .mockResolvedValueOnce({
      version: 0,
      sourceVersions: {},
      snapshot: { courseId, version: 0, edges: [], nodes: [] },
      sync: {
        status: "empty",
        activeJobId: null,
        lastBuiltVersion: null,
        coveredSourceVersions: {},
        eligibleSourceVersions: {},
        parsingSourceCount: 1,
        unreadableSourceCount: 2,
        rebuildBlockedByMaterials: false,
        lastFailedJob: null,
        requestedJob: null,
      },
    })
    .mockResolvedValueOnce({
      version: 1,
      sourceVersions: {},
      snapshot: { courseId, version: 1, edges: [], nodes: [] },
      sync: {
        status: "up_to_date",
        activeJobId: null,
        lastBuiltVersion: 1,
        coveredSourceVersions: { [nodeA]: 1 },
        eligibleSourceVersions: { [nodeA]: 1 },
        parsingSourceCount: 0,
        unreadableSourceCount: 0,
        rebuildBlockedByMaterials: false,
        lastFailedJob: null,
        requestedJob: null,
      },
    });
  const api = { getCourseKnowledge, listTutorActions: vi.fn().mockResolvedValue([]) } as unknown as OpeningApi;

  await act(async () => root.render(<CourseKnowledge courseId={courseId} api={api} knowledgeRefreshToken={0} />));
  expect(host.querySelector('[role="status"]')?.textContent).toContain("有 2 份资料无法读取文字，另有 1 份资料仍在解析中");

  await act(async () => root.render(<CourseKnowledge courseId={courseId} api={api} knowledgeRefreshToken={1} />));
  expect(host.querySelector('[role="status"]')?.textContent).toContain("已检查可读资料，暂未提取到知识点");
});

it("shows blocked replacement preservation copy and lastFailedJob notices on a non-empty graph", async () => {
  const jobId = "33333333-3333-4333-8333-333333333333";
  const nonEmptySnapshot = {
    courseId,
    version: 2,
    edges: [],
    nodes: [
      { id: nodeA, courseId, label: "第一章 向量空间", kind: "chapter" as const, evidenceChunkIds: [], status: "needs_check" as const },
    ],
  };
  const getCourseKnowledge = vi.fn()
    .mockResolvedValueOnce({
      version: 2,
      sourceVersions: { [nodeB]: 1 },
      snapshot: nonEmptySnapshot,
      sync: {
        status: "needs_rebuild",
        activeJobId: null,
        lastBuiltVersion: 1,
        coveredSourceVersions: { [nodeB]: 1 },
        eligibleSourceVersions: {},
        parsingSourceCount: 0,
        unreadableSourceCount: 1,
        rebuildBlockedByMaterials: true,
        lastFailedJob: { jobId, state: "failed" },
        requestedJob: null,
      },
    })
    .mockResolvedValueOnce({
      version: 2,
      sourceVersions: { [nodeB]: 1 },
      snapshot: nonEmptySnapshot,
      sync: {
        status: "needs_rebuild",
        activeJobId: null,
        lastBuiltVersion: 1,
        coveredSourceVersions: { [nodeB]: 1 },
        eligibleSourceVersions: { [nodeB]: 1 },
        parsingSourceCount: 0,
        unreadableSourceCount: 0,
        rebuildBlockedByMaterials: false,
        lastFailedJob: { jobId, state: "outcome_unknown" },
        requestedJob: null,
      },
    });
  const api = { getCourseKnowledge, listTutorActions: vi.fn().mockResolvedValue([]) } as unknown as OpeningApi;

  await act(async () => root.render(<CourseKnowledge courseId={courseId} api={api} knowledgeRefreshToken={0} />));
  const blockedNotice = host.querySelector('[role="status"]')?.textContent ?? "";
  expect(blockedNotice).toContain("旧知识点已保留，请先处理新版资料");
  expect(blockedNotice).toContain("1 份资料无法读取文字");

  await act(async () => root.render(<CourseKnowledge courseId={courseId} api={api} knowledgeRefreshToken={1} />));
  const failedNotice = host.querySelector('[role="status"]')?.textContent ?? "";
  expect(failedNotice).toContain("上次整理知识点结果暂未确认");
});
