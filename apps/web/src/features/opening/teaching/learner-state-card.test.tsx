// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const preferences = vi.hoisted(() => ({ diagnostics: false }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => preferences.diagnostics }));
vi.mock("./learner-shadow-panel", () => ({ LearnerShadowPanel: () => <div data-shadow-panel /> }));
import { LearnerStateCard } from "./learner-state-card";

const courseId = "11111111-1111-4111-8111-111111111111";
const otherCourseId = "22222222-2222-4222-8222-222222222222";
const feature = (index: number, changes = {}) => ({ observationId: `answer-${index}`, courseId,
  eligibility: { verifiedCorrect: "yes", usableForCurrentVersion: "yes" }, ...changes });
const response = (features = Array.from({ length: 5 }, (_, index) => feature(index))) => ({
  stateVersion: "state-one", dataAsOf: "2026-10-21T12:00:00.000Z", features,
  display: { scope: "recorded_requirements", total: 1, unscopedObservations: 0,
    counts: { independent: 1, hinted: 0, retest: 0, insufficient: 0 } },
  summary: [{ courseId, requirementKey: "rank", skillLabel: "矩阵的秩", status: "observed_independent", sampleCount: 5,
    views: { independent: 5, retention: 5, transfer: 0, help: 0 }, gaps: [] }],
  completeness: { status: "truncated", total: features.length, returned: 1, stale: false, gaps: [] },
});
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  preferences.diagnostics = false;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
});
async function render(value: ReturnType<typeof response>, scopedCourseId?: string) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(value)));
  await act(async () => root.render(<LearnerStateCard courseId={scopedCourseId} proactive />));
}

it("stays hidden until five distinct current graded answers are available", async () => {
  const features = Array.from({ length: 4 }, (_, index) => feature(index));
  features.push(feature(0), feature(4, { eligibility: { verifiedCorrect: "unknown", usableForCurrentVersion: "yes" } }),
    feature(5, { eligibility: { verifiedCorrect: "yes", usableForCurrentVersion: "unknown" } }));
  await render(response(features));
  expect(host.childElementCount).toBe(0);
});

it("shows progress from the full sequence even when displayed evidence is truncated", async () => {
  const value = response();
  value.features[4] = feature(4, { eligibility: { verifiedCorrect: "no", usableForCurrentVersion: "yes" } });
  await render(value, courseId);
  expect(host.querySelector('[aria-label="开始前的学习建议"]')).not.toBeNull();
  expect(host.textContent).toContain("已记录 5 次作答");
  expect(host.querySelector("a")?.getAttribute("href")).toBe(`/opening/courses/${courseId}/study`);
  expect(host.querySelector('[aria-label="学习证据诊断"]')).toBeNull();
  expect(host.querySelector("[data-shadow-panel]")).toBeNull();
});

it("does not borrow another course's answers to reach the display threshold", async () => {
  await render(response([...Array.from({ length: 4 }, (_, index) => feature(index)), feature(4, { courseId: otherCourseId })]), courseId);
  expect(host.childElementCount).toBe(0);
});

it("shows graded answers without zero-content counters when their learning topics are not grouped yet", async () => {
  const value = response();
  value.display = { ...value.display, total: 0, unscopedObservations: 5,
    counts: { independent: 0, hinted: 0, retest: 0, insufficient: 0 } };
  await render(value);
  expect(host.textContent).toContain("已记录 5 次作答");
  expect(host.querySelector('[aria-label="练习进展"] dl')).toBeNull();
  expect(host.textContent).not.toContain("练习了 0 项内容");
});

it("places technical details and predictions inside the developer diagnostic disclosure", async () => {
  preferences.diagnostics = true;
  await render(response());
  const diagnostic = host.querySelector<HTMLDetailsElement>('details[aria-label="学习证据诊断"]');
  expect(diagnostic?.open).toBe(false);
  expect(diagnostic?.textContent).toContain("状态版本：state-one");
  expect(diagnostic?.querySelector("[data-shadow-panel]")).not.toBeNull();
});
