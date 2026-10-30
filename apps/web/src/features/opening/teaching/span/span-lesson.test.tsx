// @vitest-environment jsdom
import { createContext, createElement, type ReactNode } from "react";
import type { SpanLessonSnapshot } from "@aistudy/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const { probe, passthrough } = vi.hoisted(() => ({
  probe: { intent: null as unknown },
  passthrough: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
vi.mock("../../v3/motion/view-transition", () => ({ TransitionLink: passthrough }));
vi.mock("../../assistant/conversation-links", () => ({ conversationObjectHref: (href: string) => href }));
vi.mock("../../design/ui", () => ({ ContentBlock: passthrough, ContentGrid: passthrough, ui: { quiet: "", input: "", primary: "", secondary: "" } }));
vi.mock("../student-copy", () => ({ studentCopy: { nextCorrect: "", nextIncorrect: "" } }));
vi.mock("../learner-state-card", () => ({ LearnerStateCard: passthrough }));
vi.mock("./delayed-retest-control", () => ({ SpanDelayedRetestControl: passthrough }));
vi.mock("./worked-example", () => ({ SpanWorkedExample: passthrough, SpanOverviewLinks: passthrough }));
vi.mock("./span-explorer", () => ({ SpanExplorer: passthrough }));
vi.mock("../study-intent-controls", async original => {
  const { StudyIntentControls } = await original<typeof import("../study-intent-controls")>();
  return { StudyIntentControls: (props: Parameters<typeof StudyIntentControls>[0]) => { probe.intent = props.currentIntent; return createElement(StudyIntentControls, props); } };
});
vi.mock("./span-session-summary", () => ({ SpanSessionSummary: passthrough }));
vi.mock("./span-session-client", async original => ({ ...await original<typeof import("./span-session-client")>(), spanLessonRequest: vi.fn() }));
vi.mock("./span-practice", () => ({ SpanPractice: passthrough }));
vi.mock("../../assistant/current-study-context", () => ({ useStudyAssistantContext: vi.fn() }));
vi.mock("../lesson-assistant-context", () => ({ spanAssistantContext: () => ({}), spanPracticeEntryKey: () => "entry" }));
vi.mock("../selection-ask", () => ({ SelectionAsk: passthrough, LessonSelectionAskContext: createContext(null) }));
vi.mock("../explanation-actions", () => ({ ExplanationActions: passthrough, explanationActionPrompt: () => "" }));
vi.mock("../lesson-companion-workspace", () => ({ LessonCompanionWorkspace: passthrough }));
vi.mock("../lesson-shortcuts", () => ({ useLessonArrowKeys: vi.fn() }));
vi.mock("../../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));
vi.mock("./span-tutor-control", () => ({ SpanTutorControl: passthrough }));
vi.mock("./span-next-action-control", () => ({ SpanNextActionControl: passthrough, currentSpanObservationId: () => undefined }));
vi.mock("./span-answer", () => ({ isSpanReservedProblemId: () => false }));

import { SpanLesson } from "./span-lesson";
import { SpanLessonSession } from "./span-lesson-session";
import { spanLessonRequest } from "./span-session-client";

it("restores matching intent once, then sends pause and renders the paused session", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const id = "11111111-1111-4111-8111-111111111111";
  const intent = { purpose: "self_study" as const, timeBudgetMinutes: 12, language: "zh" as const, pace: "normal" as const, continuous: true, selfReportedFatigue: "unknown" as const };
  const snapshot: SpanLessonSnapshot = { activityId: id, sessionId: id, courseId: "22222222-2222-4222-8222-222222222222", sourceIds: [id], intent, moveId: "self-independent", status: "active", revision: 2, retestId: null, createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:00Z" };
  const event = { id, sessionId: id, activityId: id, attemptId: null, version: 1, change: { kind: "preference", intent }, intent, signals: [], action: "continue", createdAt: snapshot.createdAt };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ event }));
  const request = vi.mocked(spanLessonRequest); request.mockReset();
  const writes: string[] = [];
  request.mockImplementation(async (_path, _schema, init) => {
    if (!init) return { session: structuredClone(snapshot), attempts: [], observations: [], assistance: {}, hintLevels: {}, intentEvent: null };
    const { status } = JSON.parse(init.body as string); writes.push(status);
    // Bound the pre-fix feedback loop so this regression fails deterministically.
    if (writes.length > 3) throw new Error("repeated active save");
    return structuredClone({ ...snapshot, status, revision: status === "paused" ? 3 : 2 });
  });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<SpanLessonSession courseId={snapshot.courseId} sourceIds={[id]} sourceLoadError={false} initialActivityId={id} />));
    expect(writes).toEqual(["active"]);
    const pause = [...host.querySelectorAll("button")].find(button => button.textContent === "暂停并保存")!;
    expect(pause.disabled).toBe(false);
    await act(async () => pause.click());
    expect(writes).toEqual(["active", "paused"]);
    expect(host.querySelector("h1")?.textContent).toBe("本次学习已暂停");
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); host.remove(); fetch.mockRestore(); request.mockReset(); }
});

it("passes the persisted session intent to the study intent controls", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ event: null }));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const intent = { purpose: "challenge" as const, timeBudgetMinutes: 25, language: "zh" as const, pace: "fast" as const, continuous: true, selfReportedFatigue: "unknown" as const };
  try {
    await act(async () => root.render(createElement(SpanLesson, { courseId: "course", sourceIds: ["source"], sourceLoadError: false, session: { sessionId: "session", intent } as never })));
    expect(probe.intent).toEqual(intent);
  } finally { await act(async () => root.unmount()); host.remove(); fetch.mockRestore(); }
});
