import { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { LearningObservation } from "@aistudy/contracts";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";

// Node-only callback harness: no DOM, browser, effects, timers, or live services.
// Status reachability is covered by ai-grading-interaction.test.tsx; here we
// exercise the parent's real editor and command callbacks at that boundary.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useReducer: (reduce: (state: unknown, action: unknown) => unknown, initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (action: unknown) => { hooks.values[index] = reduce(hooks.values[index], action); }];
  },
  useEffect: () => {},
}));
const api = vi.hoisted(() => ({
  getObservationHistory: vi.fn(), listRevisionCourses: vi.fn(),
  reviseObservation: vi.fn(), gradeObservation: vi.fn(),
}));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => api }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));
vi.mock("../cards/create-card-dialog", () => ({ CreateCardDialog: () => null }));
import { ObservationRevisionCard } from "./observation-revision-card";
import { ObservationRevisionFields } from "./observation-revision-fields";
import { AiGradingCard } from "./ai-grading-card";

const id = "11111111-1111-4111-8111-111111111111";
let head: LearningObservation;
function render(): ReactNode {
  hooks.cursor = 0;
  const outer = ObservationRevisionCard({ record: head, onChanged() {} });
  return (outer.type as (props: typeof outer.props) => ReactNode)(outer.props);
}
function find<P>(node: ReactNode, type: unknown, label?: string): P | undefined {
  if (Array.isArray(node)) return node.map(child => find<P>(child, type, label)).find(Boolean);
  if (!isValidElement<{ children?: ReactNode }>(node)) return;
  if (node.type === type && (label === undefined || node.props.children === label)) return node.props as P;
  return find<P>(node.props.children, type, label);
}
function props<P>(type: unknown, label?: string): P {
  const result = find<P>(render(), type, label);
  expect(result, `rendered ${label ?? String(type)}`).toBeDefined();
  return result!;
}
const fields = () => props<Parameters<typeof ObservationRevisionFields>[0]>(ObservationRevisionFields);
const grading = () => props<Parameters<typeof AiGradingCard>[0]>(AiGradingCard);
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
async function submit() {
  props<{ onSubmit: (event: { preventDefault: () => void }) => void }>("form").onSubmit({ preventDefault() {} });
  await settle();
}
async function openCorrectAnswer() {
  grading().onCorrectAnswer!();
  await settle();
  props<{ onChange: (event: { target: { value: string } }) => void }>("textarea")
    .onChange({ target: { value: "修正旧答案" } });
}

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; vi.resetAllMocks();
  head = { ...learningObservation, id, rootObservationId: id, answer: "旧答案", outcome: "correct", verdictSource: "self_report" };
  api.getObservationHistory.mockImplementation(async () => ({ rootObservationId: id, headObservationId: head.id, revisions: [head] }));
  api.listRevisionCourses.mockResolvedValue([]);
  api.reviseObservation.mockRejectedValue(new Error("synthetic offline: retain editor"));
});

it.each(["correct", "incorrect"] as const)("unknown answer correction starts unverified, not old %s", async outcome => {
  head = { ...head, outcome };
  await openCorrectAnswer();
  expect(fields().draft.outcome).toBe("unverified");
  expect(head.outcome).toBe(outcome);
  expect(api.gradeObservation).not.toHaveBeenCalled();
});

it("saves a changed answer unverified as self_report without paid grading", async () => {
  await openCorrectAnswer();
  const editor = fields();
  editor.onChange({ ...editor.draft, answer: "新答案未核验" });
  await submit();
  expect(api.reviseObservation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    expectedHead: id, revisionKind: "replace",
    replacement: expect.objectContaining({ answer: "新答案未核验", outcome: "unverified", verdictSource: "self_report", referenceSourceId: null }),
  }));
  expect(head.answer).toBe("旧答案");
  expect(api.gradeObservation).not.toHaveBeenCalled();
});

it.each(["correct", "incorrect"] as const)("preserves the learner's explicit new %s judgment", async outcome => {
  await openCorrectAnswer();
  const editor = fields();
  editor.onChange({ ...editor.draft, answer: "新的答案", outcome });
  await submit();
  expect(api.reviseObservation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    expectedHead: id,
    replacement: expect.objectContaining({ answer: "新的答案", outcome, verdictSource: "self_report", referenceSourceId: null }),
  }));
  expect(api.gradeObservation).not.toHaveBeenCalled();
});

it("manual result-only correction keeps its unverified default and original answer", async () => {
  grading().onDispute!();
  await settle();
  expect(props<{ value: string }>("select").value).toBe("unverified");
  await submit();
  expect(api.reviseObservation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    expectedHead: id,
    replacement: expect.objectContaining({ answer: "旧答案", outcome: "unverified", verdictSource: "self_report" }),
  }));
  expect(api.listRevisionCourses).not.toHaveBeenCalled();
  expect(api.gradeObservation).not.toHaveBeenCalled();
});

it.each(["correct", "incorrect"] as const)("ordinary correction still inherits old %s", async outcome => {
  head = { ...head, outcome };
  props<{ onClick: () => void }>("button", "纠正记录").onClick();
  await settle();
  expect(fields().draft.outcome).toBe(outcome);
  expect(api.gradeObservation).not.toHaveBeenCalled();
});

it("retries an ambiguous save with the exact same command and write key, never grading", async () => {
  await openCorrectAnswer();
  const editor = fields();
  editor.onChange({ ...editor.draft, answer: "新的答案" });
  await submit();
  await submit();
  expect(api.reviseObservation).toHaveBeenCalledTimes(2);
  expect(api.reviseObservation.mock.calls[0]![0].clientKey).toEqual(expect.any(String));
  expect(api.reviseObservation.mock.calls[1]![0]).toEqual(api.reviseObservation.mock.calls[0]![0]);
  expect(api.gradeObservation).not.toHaveBeenCalled();
});
