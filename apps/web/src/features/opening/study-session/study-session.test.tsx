import { expect, it } from "vitest";
import { CLOSED_CAPABILITIES } from "@aistudy/config/public";
import { loadFeatureSwitches, resolveCapabilities } from "@aistudy/config";
import { primaryAction, type StudySessionView } from "./model";

const view: StudySessionView = { step: { kind: "question", id: "q", title: "span", prompt: "求系数", purpose: "practice", estimateMinutes: null, photo: false, coordinates: 2 },
  position: { index: 2, total: 3 }, help: { level: "none", hints: [], next: null }, answer: {}, sealed: true,
  result: { outcome: "correct", assistance: "independent" }, next: null, photo: null };
it.each(["发放新题确认", "返回原要求"])("uses bounded %s only for an actual result action", label => {
  expect(primaryAction({ ...view, primaryActionLabel: label }, false)).toEqual({ kind: "next", label, disabled: false });
  expect(primaryAction({ ...view, primaryActionLabel: label }, true).disabled).toBe(true);
  expect(primaryAction({ ...view, primaryActionLabel: label, blocked: "证据待核对" }, false)).toMatchObject({ kind: "none", disabled: true });
  expect(primaryAction({ ...view, primaryActionLabel: label, result: null }, false)).toMatchObject({ kind: "submit", label: "重新确认提交" });
});
it("preserves ordinary result, redo and learn action labels", () => {
  expect(primaryAction(view, false).label).toBe("看下一步安排");
  expect(primaryAction({ ...view, result: { outcome: "incorrect", assistance: "independent" }, canRedo: true }, false).label).toBe("改这道题");
  expect(primaryAction({ ...view, step: { kind: "learn", id: "l", title: "短讲", body: "内容", estimateMinutes: null } }, false).label).toBe("开始做题");
});

it("keeps the new session closed by default and requires authenticated teaching access", () => {
  expect(CLOSED_CAPABILITIES.studySessionV2).toBe(false);
  expect(resolveCapabilities(loadFeatureSwitches({}), "learner").studySessionV2).toBe(false);
  expect(resolveCapabilities(loadFeatureSwitches({ OPENING_STUDY_SESSION_V2: "1" }), "learner").studySessionV2).toBe(true);
  expect(resolveCapabilities(loadFeatureSwitches({ OPENING_STUDY_SESSION_V2: "1" }), null).studySessionV2).toBe(false);
});
