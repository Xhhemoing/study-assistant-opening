// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { learningAttemptCreateInputSchema, learningAttemptSubmitInputSchema, type LearningAttempt, type LearningObservation, type SourceRecord } from "@aistudy/contracts";
import { CLOSED_CAPABILITIES } from "@aistudy/config/public";
const api = vi.hoisted(() => ({ listSources: vi.fn(), prepare: vi.fn(), getSummary: vi.fn(), createSession: vi.fn(), createAttempt: vi.fn(), getAttempt: vi.fn(), listObservations: vi.fn(), submitAttempt: vi.fn(), getObservationHistory: vi.fn(), getGradingStatus: vi.fn(), gradeObservation: vi.fn() }));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => api }));
vi.mock("../client/api", async original => ({ ...await original<typeof import("../client/api")>(), createOpeningApi: () => api }));
vi.mock("./photo-practice-client", () => ({ preparePhotoPractice: api.prepare }));
vi.mock("./photo-recognition-editor", () => ({ PhotoRecognitionEditor: () => null }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));
const gradingIo = vi.hoisted(() => ({ observation: vi.fn(), sources: vi.fn() }));
vi.mock("../../../../../../packages/database/src/repositories/opening-learning-facts", async original => ({
  ...await original<typeof import("../../../../../../packages/database/src/repositories/opening-learning-facts")>(),
  admitLearningSources: gradingIo.sources,
}));
vi.mock("../../../../../../packages/database/src/repositories/opening-observation-revision-history", () => ({ qualifyObservationRevision: gradingIo.observation }));
vi.mock("../../../../../../packages/database/src/repositories/opening-answer-interpretation-state", () => ({ readOpeningAnswerInterpretationMetadata: async () => null }));
import { readOpeningAiGradingContext } from "../../../../../../packages/database/src/repositories/opening-ai-grading-context";
import { OpeningCapabilitiesContext } from "../capabilities/capabilities-provider";
import { PhotoPractice } from "./photo-practice";
import { LearningAttemptForm } from "./attempt-form";
import { canGradeObservation } from "./ai-grading-card";

beforeEach(() => {
  vi.resetAllMocks(); window.sessionStorage.clear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  HTMLDialogElement.prototype.show = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
const id = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
async function change(input: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLTextAreaElement ? "input" : "change", { bubbles: true }));
  });
}

it.each([
  { enabled: true, photo: true, text: true, attachment: true, skipped: "disabled", identity: 101 },
  { enabled: true, photo: true, text: false, attachment: true, skipped: "no_model", identity: 111 },
  { enabled: false, photo: true, text: true, attachment: true, skipped: "disabled", identity: 121 },
  { enabled: true, photo: false, text: true, attachment: true, skipped: "disabled", identity: 131 },
  { enabled: true, photo: true, text: true, attachment: false, skipped: "disabled", identity: 141 },
])("preserves the real owner across failed submit and remount: $identity", async ({ enabled, photo, text, attachment, skipped, identity }) => {
  const courseId = id(identity), sourceId = id(identity + 1), workId = id(identity + 2), sessionId = id(identity + 3), attemptId = id(identity + 4), observationId = id(identity + 5);
  const stem = "计算 1+1，并说明理由";
  const sources: SourceRecord[] = [sourceId, workId].map((source, index) => ({ id: source, workspaceId: courseId, name: index ? "我的解答.png" : "原题.png", mime: "image/png", bytes: 100, sha256: "a".repeat(64), version: 2, uploadState: "uploaded", parseState: "ready", error: null, createdAt: "2026-10-21T00:00:00Z" }));
  const attempt: LearningAttempt = { id: attemptId, workspaceId: courseId, courseId, sessionId, skillLabel: "随手练习", requirementKey: null, sourceIds: [sourceId], sourceVersions: { [sourceId]: 2 }, problemId: sourceId, itemVersionId: sessionId, stemSnapshot: stem, observationId: null, submittedAt: null, startedAt: "2026-10-22T00:00:00Z", historyRevision: 0 };
  let observation: LearningObservation | null = null;
  api.listSources.mockResolvedValue(sources); api.prepare.mockResolvedValue({ sourceId, sourceVersion: 2, courseId });
  api.getSummary.mockResolvedValue([]); api.createSession.mockResolvedValue({ id: sessionId });
  api.createAttempt.mockImplementation(async input => { learningAttemptCreateInputSchema.parse(input); return attempt; });
  api.getAttempt.mockResolvedValue({ attemptId, sessionId, deliveredAssistance: "none" });
  api.listObservations.mockImplementation(async () => observation ? [observation] : []);
  api.getObservationHistory.mockImplementation(async () => ({ rootObservationId: observationId, headObservationId: observationId, revisions: [observation] }));
  api.getGradingStatus.mockResolvedValue({ observationId, headObservationId: observationId, status: "needs_manual", retryable: true, autoGradeSkipped: skipped, jobId: null });
  api.submitAttempt.mockImplementation(async (_attemptId, raw) => {
    const input = learningAttemptSubmitInputSchema.parse(raw);
    if (api.submitAttempt.mock.calls.length === 1) throw new Error("暂时无法保存，请重试");
    observation = { ...attempt, id: observationId, attemptId, answer: input.answer, outcome: input.outcome, assistance: input.assistance, clientKey: `photo-practice:${attemptId}`, sourceTurnIds: [], verdictSource: "self_report", referenceSourceId: null, evidenceVerdict: "MASTERY_NOT_ESTABLISHED", occurredAt: "2026-10-22T00:00:00Z", revisionKind: "original", sourceIds: [sourceId, ...(input.workSource ? [workId] : [])], sourceVersions: { [sourceId]: 2, ...(input.workSource ? { [workId]: 2 } : {}) } };
    expect(canGradeObservation(observation)).toBe(true);
    if (input.workSource) expect(input.workSource).toEqual({ id: workId, version: 2, physicalPage: 1 });
    gradingIo.observation.mockResolvedValue({ ...observation, eligibility: { usableForCurrentVersion: "yes" } });
    gradingIo.sources.mockResolvedValue([sources[0]]);
    const tx = Object.assign(vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join("?");
      if (sql.includes("SELECT id FROM users")) return [{ id: courseId }];
      if (sql.includes("SELECT o.*")) return [{ id: observationId, current_head_id: observationId, grading_work_source: input.workSource ?? null, answer_revision: 1 }];
      if (sql.includes("client_key=")) return [];
      if (sql.includes("SELECT v.*")) return [{ stem_snapshot: stem, source_id: sourceId, attempt_source_ids: [sourceId] }];
      if (sql.includes("SELECT id,mime")) return [sources[1]];
      if (sql.includes("FROM opening_source_chunks")) return [{ id: id(identity + 6), source_id: sourceId, source_version: 2, page: 1, text: stem, image_object_key: null, mime: "image/png", bytes: 100 }];
      throw new Error(`Unexpected grading query: ${sql}`);
    }), { json: (value: unknown) => value });
    const context = await readOpeningAiGradingContext(tx as never, { workspaceId: courseId, ownerUserId: courseId }, { observationId }, { readOnly: true });
    expect(context.observation.answer).toBe(input.answer);
    expect(context.workSource).toEqual(input.workSource ?? null);
    expect(context.stem).toBe(stem);
    return observation;
  });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const render = async () => act(async () => root.render(createElement(OpeningCapabilitiesContext.Provider, { value: { ...CLOSED_CAPABILITIES, studySessionV2: enabled } }, photo
    ? createElement(PhotoPractice, { sourceId })
    : createElement(LearningAttemptForm, { courseId, initialProblem: { sourceId, sourceVersion: 2, stem }, onRecorded() {} }))));
  const button = (label: string) => Array.from(container.querySelectorAll("button")).find(item => item.textContent === label)!;
  try {
    await render();
    if (photo) {
      expect(container.querySelector('[aria-label="学习会话"]')).toBeNull();
      await change(container.querySelector("textarea")!, stem);
      await act(async () => button("确认题干，开始作答").click());
    }
    expect(Boolean(container.querySelector('[aria-label="学习会话"]'))).toBe(enabled && photo);
    expect(container.querySelector("textarea")?.value).toBe("");
    const select = Array.from(container.querySelectorAll("select")).find(item => item.closest("label")?.textContent?.includes("作答图片或文档"))!;
    expect(select.value).toBe(""); expect(api.submitAttempt).not.toHaveBeenCalled(); expect(api.gradeObservation).not.toHaveBeenCalled();
    if (enabled && photo) expect(container.querySelectorAll("[data-primary-action]")).toHaveLength(1);
    if (text) await change(container.querySelector("textarea")!, "我的第一行\n我的第二行：2");
    if (attachment) await change(select, `${workId}:2`);
    await act(async () => button("保存并批改").click());
    expect(api.submitAttempt).toHaveBeenCalledOnce();
    const original = api.submitAttempt.mock.calls[0]!;
    expect(original[1].answer).toBe(text ? "我的第一行\n我的第二行：2" : "");
    expect(container.textContent).not.toContain("原答案已保存。");
    await act(async () => root.render(null)); await render();
    await act(async () => button("继续此练习").click());
    expect(container.querySelector("textarea")?.value).toBe(original[1].answer);
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    await act(async () => button("重试保存同一答案").click());
    expect(api.submitAttempt.mock.calls[1]).toEqual(original);
    expect(api.createAttempt.mock.calls[1]).toEqual(api.createAttempt.mock.calls[0]);
    expect(api.createSession).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("原答案已保存。");
    expect(container.textContent).toContain(skipped === "disabled" ? "工作区已关闭首次提交自动批改" : "尚无可用的批改模型");
    expect(button("手动批改")).toBeTruthy();
    expect(container.querySelectorAll("[data-primary-action]")).toHaveLength(0);
    expect(container.textContent).not.toContain("看下一步安排"); expect(api.gradeObservation).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); container.remove(); }
});
