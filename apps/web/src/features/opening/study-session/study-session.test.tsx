import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CLOSED_CAPABILITIES } from "@aistudy/config/public";
import { loadFeatureSwitches, resolveCapabilities } from "@aistudy/config";

it("keeps the new session closed by default and requires authenticated teaching access", () => {
  expect(CLOSED_CAPABILITIES.studySessionV2).toBe(false);
  expect(resolveCapabilities(loadFeatureSwitches({}), "learner").studySessionV2).toBe(false);
  expect(resolveCapabilities(loadFeatureSwitches({ OPENING_STUDY_SESSION_V2: "1" }), "learner").studySessionV2).toBe(true);
  expect(resolveCapabilities(loadFeatureSwitches({ OPENING_STUDY_SESSION_V2: "1" }), null).studySessionV2).toBe(false);
});

import { StudySessionShell } from "./study-session-shell";
import { stepRenderers } from "./step-renderers";
import type { StudySessionView } from "./model";
const noop = () => {};
it.each(["learn", "question"] as const)("registers %s and renders exactly one primary action across result states", kind => {
  const step = kind === "learn" ? { kind, id: "step", title: "学习", body: "先建立向量等式", estimateMinutes: null }
    : { kind, id: "step", title: "作答", prompt: "求系数", estimateMinutes: null, answerModes: ["text"], hintsAvailable: 4, attemptRef: { id: "attempt", itemVersionId: null }, fields: [] };
  expect(stepRenderers[kind]).toBeTypeOf("function");
  for (const result of [null, { outcome: "correct", assistance: "hinted" }]) {
    const view = { step, result, help: { level: "none", hintsShown: 0, tutorAsked: false, texts: [], canRequest: true }, next: null, answer: {}, locked: false } as StudySessionView;
    const html = renderToStaticMarkup(createElement(StudySessionShell, { view, onPrimary: noop, onEdit: noop, onHelp: noop, onPause: noop, onReload: noop, onNavigate: noop }));
    expect(html.match(/data-primary-action/g)).toHaveLength(1);
    expect(html).not.toContain("分钟"); expect(html).not.toContain("拍照");
    if (result) expect(html).toContain("用提示后答对");
  }
});
