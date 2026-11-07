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

it.each([400, 409])("releases a rejected photo on HTTP %s and resubmits the same attempt with a new key", async status => {
  const { OpeningApiError } = await import("../client/api");
  api.submitAttempt.mockRejectedValueOnce(new OpeningApiError(status, "照片不可用", status === 400 ? "VALIDATION" : "CONFLICT", "work_source_rejected")).mockResolvedValue(record);
  await render(draft({ answer: "我的答案", workSource }));
  await submit();
  expect(container.textContent).toContain("照片不可用");
  expect(container.textContent).toContain("可以改页码、换照片或移除照片");
  expect(photoSelect()!.disabled).toBe(false);
  expect(container.querySelector("textarea")!.disabled).toBe(false);
  expect(submitButton().textContent).not.toContain("重新确认");
  expect(onDraftChange.mock.lastCall![0]).toMatchObject({ answer: "我的答案", workSource, preparation: { attemptId } });
  expect(onDraftChange.mock.lastCall![0]).not.toHaveProperty("submission");
  await submit();
  expect(api.submitAttempt).toHaveBeenCalledTimes(2);
  expect(api.submitAttempt.mock.calls[0]![0]).toBe(attemptId);
  expect(api.submitAttempt.mock.calls[1]![0]).toBe(attemptId);
  expect(api.submitAttempt.mock.calls[0]![1].clientKey).not.toBe(api.submitAttempt.mock.calls[1]![1].clientKey);
  expect(api.createSession).toHaveBeenCalledTimes(1);
  expect(api.createAttempt.mock.calls.every(call => call[0].clientKey === api.createAttempt.mock.calls[0]![0].clientKey)).toBe(true);
});

it("keeps a conflict without the rejection reason frozen", async () => {
  const { OpeningApiError } = await import("../client/api");
  api.submitAttempt.mockRejectedValue(new OpeningApiError(409, "冲突", "CONFLICT"));
  await render(draft({ answer: "答案", workSource })); await submit();
  expect(photoSelect()!.disabled).toBe(true);
  expect(container.querySelector("textarea")!.disabled).toBe(true);
  expect(submitButton().textContent).toContain("重新确认");
});

it("restores a preparation and photo without creating a new session", async () => {
  const preparation = { input: { activityId, courseId: record.courseId, blockId, contentVersion: 3, sourceIds: record.sourceIds, prompt, skillLabel: "导数" },
    attemptKey: `teaching-attempt:${crypto.randomUUID()}`, sessionId: record.sessionId, attemptId };
  await render(draft({ answer: "答案", workSource, preparation }));
  expect(api.createSession).not.toHaveBeenCalled();
  expect(api.createAttempt).toHaveBeenCalledWith(expect.objectContaining({ clientKey: preparation.attemptKey }));
  expect(photoSelect()).toMatchObject({ value: `${photoId}:2`, disabled: false });
  expect(onDraftChange.mock.lastCall![0]).toMatchObject({ workSource, preparation });
});

it("keeps a conflicting draft and its photo read-only", async () => {
  await render(draft({ prompt: "不同题干", answer: "答案", workSource }));
  expect(photoSelect()!.disabled).toBe(true);
  expect([...container.querySelectorAll("button")].find(button => button.textContent === "刷新文件")!.disabled).toBe(true);
  expect(submitButton().disabled).toBe(true);
  expect(api.createAttempt).not.toHaveBeenCalled(); expect(api.submitAttempt).not.toHaveBeenCalled();
});

it("releases a restored frozen submission and filters the recovered attempt's materials", async () => {
  const { OpeningApiError } = await import("../client/api");
  const checkpoint = { input: { activityId, courseId: record.courseId, blockId, contentVersion: 3, sourceIds: record.sourceIds, prompt, skillLabel: "导数", answer: "答案", workSource },
    attemptKey: `teaching-attempt:${crypto.randomUUID()}`, submitKey: `teaching-answer:${crypto.randomUUID()}`, sessionId: record.sessionId, attemptId, status: "pending" as const };
  api.listSources.mockResolvedValue([source(), source({ id: record.sourceIds[0], name: "原题.png" })]);
  api.submitAttempt.mockRejectedValueOnce(new OpeningApiError(409, "照片不可用", "CONFLICT", "work_source_rejected"));
  await render(draft({ answer: "答案", workSource, submission: checkpoint }));
  expect(container.textContent).toContain("已恢复上次提交的原答案");
  await submit();
  expect(container.textContent).not.toContain("已恢复上次提交的原答案");
  expect([...photoSelect()!.options].map(option => option.textContent)).not.toContain("原题.png");
  expect(photoSelect()!.disabled).toBe(false);
  api.submitAttempt.mockResolvedValueOnce(record);
  await submit();
  expect(lastCardProps()).toMatchObject({ autoGrade: true });
  expect(api.getObservationHistory).not.toHaveBeenCalled();
  expect(api.createSession).not.toHaveBeenCalled();
  expect(api.createAttempt.mock.calls.every(call => call[0].clientKey === checkpoint.attemptKey)).toBe(true);
});

it("does not send a stored photo when the question already has 32 distinct sources", async () => {
  const ids = Array.from({ length: 32 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  api.createAttempt.mockResolvedValue({ ...attempt, sourceIds: [...ids.slice(0, 20), ids[0]], sourceVersions: Object.fromEntries(ids.slice(10).map(id => [id, 1])) });
  await render(draft({ answer: "文字答案", workSource }));
  expect(photoSelect()).toBeNull();
  expect(container.textContent).toContain("关联的资料已达上限");
  await submit();
  expect(api.submitAttempt.mock.calls[0]![1]).not.toHaveProperty("workSource");
  expect(api.submitAttempt.mock.calls[0]![1].answer).toBe("文字答案");
});

it("does not release or start another request when rejection arrives after unmount", async () => {
  const { OpeningApiError } = await import("../client/api");
  let reject!: (reason: Error) => void;
  api.submitAttempt.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  await render(draft({ answer: "答案", workSource }));
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const frozen = onDraftChange.mock.lastCall![0];
  expect(frozen.submission).toBeDefined();
  const calls = [api.createSession.mock.calls.length, api.createAttempt.mock.calls.length, api.submitAttempt.mock.calls.length];
  await act(async () => root.render(null));
  onDraftChange.mockClear();
  await act(async () => reject(new OpeningApiError(409, "照片不可用", "CONFLICT", "work_source_rejected")));
  expect(onDraftChange).not.toHaveBeenCalled();
  expect([api.createSession.mock.calls.length, api.createAttempt.mock.calls.length, api.submitAttempt.mock.calls.length]).toEqual(calls);
});
