// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
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
vi.mock("../study-intent-controls", () => ({ StudyIntentControls: (props: { currentIntent?: unknown }) => { probe.intent = props.currentIntent; return null; } }));
vi.mock("./span-practice", () => ({ SpanPractice: passthrough }));
vi.mock("../../assistant/current-study-context", () => ({ useStudyAssistantContext: vi.fn() }));
vi.mock("../lesson-assistant-context", () => ({ spanAssistantContext: () => ({}), spanPracticeEntryKey: () => "entry" }));
vi.mock("../selection-ask", () => ({ SelectionAsk: passthrough }));
vi.mock("../lesson-companion-workspace", () => ({ LessonCompanionWorkspace: passthrough }));
vi.mock("../lesson-shortcuts", () => ({ useLessonArrowKeys: vi.fn() }));
vi.mock("../../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));
vi.mock("./span-tutor-control", () => ({ SpanTutorControl: passthrough }));
vi.mock("./span-next-action-control", () => ({ SpanNextActionControl: passthrough, currentSpanObservationId: () => undefined }));
vi.mock("./span-answer", () => ({ isSpanReservedProblemId: () => false }));

import { SpanLesson } from "./span-lesson";

it("passes the persisted session intent to the study intent controls", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const intent = { purpose: "challenge" as const, timeBudgetMinutes: 25, language: "zh" as const, pace: "fast" as const, continuous: true, selfReportedFatigue: "unknown" as const };
  try {
    await act(async () => root.render(createElement(SpanLesson, { courseId: "course", sourceIds: ["source"], sourceLoadError: false, session: { sessionId: "session", intent } as never })));
    expect(probe.intent).toEqual(intent);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
