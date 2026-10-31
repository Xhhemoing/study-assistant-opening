import { expect, it } from "vitest";
import type { LearningAttempt, LearningObservation } from "@aistudy/contracts";
import { getSpanProblem } from "@aistudy/domain";
import { adaptSpanQuestion, adaptSpanResult, adaptSpanHelp, adaptSpanNext, createSpanStudySession } from "./span";
import { vi } from "vitest";
import { spanLessonDetailsSchema, spanLessonRequest } from "../../teaching/span/span-session-client";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { stepRenderers } from "../step-renderers";
vi.mock("../../teaching/span/span-session-client", async original => ({ ...await original<typeof import("../../teaching/span/span-session-client")>(), spanLessonRequest: vi.fn() }));
vi.mock("../../assistant/study-exposure-ack", () => ({ acknowledgeStudyExposure: vi.fn() }));
import type { PhotoState } from "../model";
const id = "11111111-1111-4111-8111-111111111111";
const attempt = { id, itemVersionId: id, spanExercise: getSpanProblem("span-independent-3d")! } as LearningAttempt;
it("reads the shared details focus through the port into the rendered v2 learn step", async () => {
  const targetedFocus = "系数代入后，第3坐标没对上。";
  const details = spanLessonDetailsSchema.parse({ targetedFocus, estimateMinutes: 17, session: { activityId: id, sessionId: id, courseId: id, sourceIds: [id], intent: { purpose: "self_study", timeBudgetMinutes: 20, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" }, moveId: "self-example", status: "active", revision: 1, retestId: null, createdAt: "2026-10-31T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z" }, attempts: [], observations: [], assistance: {} });
  vi.mocked(spanLessonRequest).mockResolvedValue({ problem: attempt.spanExercise, solution: { kind: "none" }, exposureReceipt: { id } });
  const view = await createSpanStudySession(details, vi.fn()).load();
  expect(view.step).toMatchObject({ targetedFocus, estimateMinutes: 17 });
  expect(view.photo?.enabled).toBe(false);
  const html = renderToStaticMarkup(createElement(stepRenderers.learn, { step: view.step, answer: {}, locked: false, onEdit: vi.fn() }));
  expect(html).toContain(targetedFocus);
  expect(html.indexOf("上次错在这一步")).toBeLessThan(html.indexOf("span 是所有"));
});
it("adapts a real span question without inventing time or enabling photos", () => {
  const step = adaptSpanQuestion(attempt);
  expect(step).toMatchObject({ kind: "question", estimateMinutes: null, answerModes: ["text"], attemptRef: { id, itemVersionId: id } });
  expect(step.prompt).toContain("span");
});
it("keeps photo states explicit so pending and unavailable cannot be treated as ready", () => {
  const states: PhotoState["status"][] = ["none", "uploading", "preparing", "ready", "pending", "unavailable", "failed"];
  expect(states).toContain("pending");
  expect(states).toContain("unavailable");
  expect(states.filter(state => state === "ready")).toHaveLength(1);
});
it("keeps authoritative evaluation separate from assistance and pending grading", () => {
  const record = { assistance: "hinted", serverEvaluation: { decision: "correct", reasonCodes: ["verified_exactly"] } } as LearningObservation;
  expect(adaptSpanResult(record)).toEqual({ outcome: "correct", assistance: "hinted", reasonCode: "verified_exactly" });
  expect(adaptSpanResult({ ...record, serverEvaluation: null }, "grading").outcome).toBe("pending");
  expect(adaptSpanResult({ ...record, serverEvaluation: null }, "needs_manual").outcome).toBe("needs_manual");
  expect(adaptSpanHelp("revealed", [1, 2], ["方向", "定义"], false)).toMatchObject({ level: "revealed", hintsShown: 2, canRequest: true });
});
it("adapts real successor choices and rejects destinations outside the course", () => {
  const href = `/opening/courses/${id}/study/span?lesson=${id}`;
  expect(adaptSpanNext({ kind: "ready", href, activityId: id, sessionId: id, courseId: id, label: "继续新题", resumed: false }, id)).toMatchObject({ action: href, label: "继续新题", estimateMinutes: null, reasonCode: null });
  expect(() => adaptSpanNext({ kind: "choice", reason: "source_unavailable", primary: { href: "https://evil.test", label: "继续" } }, id)).toThrow();
});
