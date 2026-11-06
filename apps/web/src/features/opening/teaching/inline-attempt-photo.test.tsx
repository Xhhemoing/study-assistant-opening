// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LearningAttempt, LearningObservation, SourceRecord } from "@aistudy/contracts";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";
import type { InlineAttemptDraft } from "./inline-attempt-drafts";

const api = vi.hoisted(() => ({
  getSubmittedAttempt: vi.fn(), getSummary: vi.fn(), getCourseKnowledge: vi.fn(), listSources: vi.fn(),
  createSession: vi.fn(), createAttempt: vi.fn(), submitAttempt: vi.fn(), getObservationHistory: vi.fn(),
}));
const revisionCard = vi.hoisted(() => vi.fn());
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => api }));
vi.mock("./activity-client", () => ({ createTeachingActivityClient: () => api }));
vi.mock("../client/api", async original => ({ ...await original<typeof import("../client/api")>(), createOpeningApi: () => api }));
vi.mock("./teaching-hint-client", async original => ({ ...await original<typeof import("./teaching-hint-client")>(), readReleasedTeachingHints: async () => [] }));
vi.mock("../learning/observation-revision-card", () => ({ ObservationRevisionCard: (props: object) => { revisionCard(props); return null; } }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));
vi.mock("../design/haptics", () => ({ successfulInteractionHaptic() {} }));
import { InlineAttemptForm, type InlineAttemptContext } from "./inline-attempt";

const activityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const blockId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const attemptId = "22222222-2222-4222-8222-222222222222";
const photoId = "99999999-9999-4999-8999-999999999999";
const prompt = "求 y = x^2 在 x = 1 处的导数";
const workSource = { id: photoId, version: 2, physicalPage: 1 };
const gradingPhoto = { workSourceId: photoId, workSourceVersion: 2, physicalPage: 1 };
const record: LearningObservation = { ...learningObservation, attemptId, itemVersionId: "88888888-8888-4888-8888-888888888888",
  requirementKey: `teaching:${blockId}:v3`, answer: "", outcome: "unverified", verdictSource: "self_report" };
const attempt: LearningAttempt = { id: attemptId, workspaceId: record.workspaceId, courseId: record.courseId, sessionId: record.sessionId,
  skillLabel: "导数", requirementKey: record.requirementKey!, sourceIds: record.sourceIds, sourceVersions: {}, problemId: record.problemId ?? null,
  itemVersionId: record.itemVersionId!, startedAt: record.occurredAt, submittedAt: null, observationId: null, historyRevision: 1 };
const context: InlineAttemptContext = { id: activityId, courseId: record.courseId, sourceIds: record.sourceIds, contentVersion: 3,
  status: "active", intentSummary: "导数练习", onCourseAssociated() {} };
const onDraftChange = vi.fn();
function source(changes: Partial<SourceRecord> = {}): SourceRecord {
  return { id: photoId, workspaceId: record.workspaceId, name: "手写作答.png", mime: "image/png", bytes: 100, sha256: "a".repeat(64), version: 2,
    uploadState: "uploaded", parseState: "not_started", error: null, createdAt: record.occurredAt, ...changes };
}
const draft = (changes: Partial<InlineAttemptDraft> = {}): InlineAttemptDraft => ({ prompt, skillLabel: "导数", answer: "", ...changes });

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.resetAllMocks(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.getSubmittedAttempt.mockResolvedValue(null);
  api.getSummary.mockResolvedValue([]); api.getCourseKnowledge.mockResolvedValue({ snapshot: null });
  api.createSession.mockResolvedValue({ id: record.sessionId }); api.createAttempt.mockResolvedValue(attempt);
  api.listSources.mockResolvedValue([source(), source({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "仍在上传.png", uploadState: "pending" })]);
  api.submitAttempt.mockResolvedValue(record);
  api.getObservationHistory.mockResolvedValue({ rootObservationId: record.id, headObservationId: record.id, revisions: [record] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
async function render(initialDraft = draft(), status: InlineAttemptContext["status"] = "active") {
  await act(async () => root.render(createElement(InlineAttemptForm, { blockId, prompt, context: { ...context, status }, ready: true, initialDraft, onDraftChange })));
  await flush();
}
const photoSelect = () => [...container.querySelectorAll("select")].find(select => select.closest("label")?.textContent?.includes("作答图片或文档")) ?? null;
const submitButton = () => container.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
const lastCardProps = () => revisionCard.mock.lastCall?.[0] as { autoGrade?: boolean; gradingPhoto?: unknown } | undefined;
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function submit() {
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await flush();
}

it("offers uploaded photos once the question is prepared and lets a photo replace an empty text answer", async () => {
  await render();
  expect(api.createAttempt).toHaveBeenCalledOnce();
  expect([...photoSelect()!.options].map(option => option.textContent)).toEqual(["仅批改文字答案", "手写作答.png"]);
  expect(submitButton().disabled).toBe(true);
  await choose(photoSelect()!, `${photoId}:2`);
  expect(submitButton().disabled).toBe(false);
  expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ answer: "", workSource, preparation: expect.objectContaining({ attemptId }) }));
  await submit();
  expect(api.submitAttempt).toHaveBeenCalledExactlyOnceWith(attemptId, expect.objectContaining({ answer: "", workSource }));
  expect(lastCardProps()).toMatchObject({ autoGrade: true, gradingPhoto });
});

it("leaves the materials sealed into the question's attempt out of the photo choices", async () => {
  const sealedMaterial = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  api.createAttempt.mockResolvedValue({ ...attempt, sourceIds: [...attempt.sourceIds, sealedMaterial] });
  api.listSources.mockResolvedValue([
    source({ id: attempt.sourceIds[0]!, name: "课堂讲义.pdf", mime: "application/pdf", parseState: "ready" }),
    source({ id: sealedMaterial, name: "参考答案.png" }), source(),
  ]);
  await render();
  expect([...photoSelect()!.options].map(option => option.textContent)).toEqual(["仅批改文字答案", "手写作答.png"]);
});

it("keeps a text answer working when the photo list cannot be read, and sends it without a photo", async () => {
  api.listSources.mockRejectedValue(new Error("offline"));
  await render(draft({ answer: "y' = 2x，所以导数是 2" }));
  expect(container.textContent).toContain("暂时读不到作答照片列表");
  expect(photoSelect()!.value).toBe("");
  expect(submitButton().disabled).toBe(false);
  api.listSources.mockResolvedValue([source()]);
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "刷新文件")!.click());
  await flush();
  expect(container.textContent).not.toContain("暂时读不到作答照片列表");
  expect([...photoSelect()!.options].map(option => option.textContent)).toContain("手写作答.png");
  await submit();
  expect(api.submitAttempt.mock.calls[0]![1]).toMatchObject({ answer: "y' = 2x，所以导数是 2" });
  expect(api.submitAttempt.mock.calls[0]![1]).not.toHaveProperty("workSource");
  expect(lastCardProps()).toBeDefined();
  expect(lastCardProps()!.gradingPhoto).toBeUndefined();
});

it("freezes the attached photo with the answer once submission starts and replays the same request", async () => {
  api.submitAttempt.mockRejectedValueOnce(new Error("reply lost")).mockResolvedValue(record);
  await render();
  await choose(photoSelect()!, `${photoId}:2`);
  await submit();
  expect(photoSelect()!.disabled).toBe(true);
  expect(container.querySelector("textarea")!.disabled).toBe(true);
  expect(submitButton()).toMatchObject({ disabled: false, textContent: "重新确认原答案已保存" });
  expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ answer: "", workSource, submission: expect.objectContaining({ input: expect.objectContaining({ workSource }) }) }));
  await submit();
  expect(api.submitAttempt).toHaveBeenCalledTimes(2);
  expect(api.submitAttempt.mock.calls[1]).toEqual(api.submitAttempt.mock.calls[0]);
  expect(lastCardProps()).toMatchObject({ gradingPhoto });
});

it("restores a frozen photo-only request read-only and replays it unchanged", async () => {
  const checkpoint = { input: { activityId, courseId: record.courseId, blockId, contentVersion: 3, sourceIds: record.sourceIds, prompt, skillLabel: "导数", answer: "", workSource },
    attemptKey: `teaching-attempt:${crypto.randomUUID()}`, submitKey: `teaching-answer:${crypto.randomUUID()}`, sessionId: record.sessionId, attemptId, status: "pending" as const };
  await render(draft({ workSource, submission: checkpoint }));
  expect(photoSelect()).toMatchObject({ value: `${photoId}:2`, disabled: true });
  expect(submitButton()).toMatchObject({ disabled: false, textContent: "重新确认原答案已保存" });
  await submit();
  expect(api.createSession).not.toHaveBeenCalled();
  expect(api.submitAttempt).toHaveBeenCalledExactlyOnceWith(attemptId, { clientKey: checkpoint.submitKey, answer: "", outcome: "unverified", assistance: "unknown", verdictSource: "self_report", workSource });
  expect(lastCardProps()).toMatchObject({ autoGrade: false, gradingPhoto });
});

it("waits for the prepared question before offering a photo", async () => {
  api.createAttempt.mockReturnValue(new Promise(() => undefined));
  await render(draft({ answer: "先写下思路" }));
  expect(container.querySelector("textarea")).not.toBeNull();
  expect(photoSelect()).toBeNull();
  expect(api.listSources).not.toHaveBeenCalled();
});

it.each([
  { status: "active" as const, saved: { attempt, observation: record } },
  { status: "completed" as const, saved: null },
])("does not offer a photo after the answer is saved or the lesson is completed: $status", async ({ status, saved }) => {
  api.getSubmittedAttempt.mockResolvedValue(saved);
  await render(draft(), status);
  expect(photoSelect()).toBeNull();
  expect(api.listSources).not.toHaveBeenCalled();
  expect(api.submitAttempt).not.toHaveBeenCalled();
});
