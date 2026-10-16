import type { MeasurementAttempt, MeasurementTrial } from "@aistudy/contracts";
import { describe, expect, it } from "vitest";
import {
  chooseNextMeasurementItem,
  getMeasurementUnit,
  gradeMeasurementAnswer,
  listMeasurementUnits,
  publicMeasurementItem,
  type MeasurementCatalogItem,
} from "./catalog";

const unit = getMeasurementUnit("calculus-parts-v1")!;
const completedAt = "2026-10-17T03:00:00.000Z";
const due48h = "2026-10-19T03:00:00.000Z";
const due7d = "2026-10-24T03:00:00.000Z";
const trial: MeasurementTrial = {
  id: "trial-1", courseId: "course-1", unitId: unit.id,
  protocolVersion: unit.protocolVersion, bankVersion: unit.bankVersion, models: [],
  selectionPolicy: "fixed-common-probes-v1", status: "active",
  startedAt: "2026-10-16T01:00:00.000Z", practiceCompletedAt: null,
};

function attempt(item: MeasurementCatalogItem, ordinal: number,
  changes: Partial<MeasurementAttempt> = {}): MeasurementAttempt {
  return {
    id: `attempt-${ordinal}`, trialId: trial.id, ordinal, item: publicMeasurementItem(item),
    presentedAt: "2026-10-17T02:00:00.000Z", answeredAt: completedAt, dueAt: null,
    firstAttempt: true, helpEvents: [], answer: item.correctOptionId, outcome: "correct",
    retractedAt: null, retractionReason: null, predictions: [], feedback: null,
    ...changes,
  };
}

const practice = unit.items.filter((item) => item.phase === "practice");
const delay48h = unit.items.filter((item) => item.phase === "delay_48h");
const practiceAttempts = practice.map((item, index) => attempt(item, index));
const select = (changes: Partial<Parameters<typeof chooseNextMeasurementItem>[0]> = {}) =>
  chooseNextMeasurementItem({ trial, attempts: [], items: unit.items, now: completedAt, ...changes });

describe("curated measurement bank", () => {
  it("has three stable criteria with two practice and two delayed observations each", () => {
    expect(listMeasurementUnits().map((entry) => entry.id)).toEqual(["calculus-parts-v1"]);
    expect(getMeasurementUnit("unknown-unit")).toBeNull();
    expect(unit.protocolVersion).toBe("v1");
    expect(unit.bankVersion).toBe("v1");
    expect(new Set(unit.items.map((item) => item.id)).size).toBe(12);
    expect(practice).toHaveLength(6);
    for (const skillId of ["choose-u-dv", "compute-v", "assemble-parts"]) {
      expect(practice.filter((item) => item.skillId === skillId)).toHaveLength(2);
      for (const phase of ["delay_48h", "delay_7d"]) {
        expect(unit.items.filter((item) => item.skillId === skillId && item.phase === phase)).toHaveLength(1);
      }
    }
  });

  it("holds out structural families and keeps related training problems in the same family", () => {
    const practiceFamilies = new Set(practice.map((item) => item.familyId));
    const delayFamilies = unit.items.filter((item) => item.phase !== "practice").map((item) => item.familyId);
    expect(delayFamilies.every((family) => !practiceFamilies.has(family))).toBe(true);
    expect(new Set(delayFamilies).size).toBe(6);
    expect(practice.find((item) => item.id === "parts-p-u-exp")?.familyId)
      .toBe(practice.find((item) => item.id === "parts-p-a-exp")?.familyId);
    expect(practice.find((item) => item.id === "parts-p-u-trig")?.familyId)
      .toBe(practice.find((item) => item.id === "parts-p-a-trig")?.familyId);
  });

  it.each(unit.items)("grades only valid option IDs for $id", (item) => {
    expect(item.options).toHaveLength(4);
    expect(new Set(item.options.map((option) => option.id)).size).toBe(4);
    expect(new Set(item.options.map((option) => option.label)).size).toBe(4);
    expect(item.options.map((option) => gradeMeasurementAnswer(item, option.id)).filter((result) => result === "correct"))
      .toHaveLength(1);
    for (const answer of ["", "Z", ` ${item.correctOptionId}`, item.options[0]!.label]) {
      expect(() => gradeMeasurementAnswer(item, answer)).toThrow("Unknown measurement answer option");
    }
  });

  it.each(unit.items)("projects $id without gold, hint, solution or mutable aliases", (item) => {
    const publicItem = publicMeasurementItem(item);
    expect(Object.keys(publicItem).sort()).toEqual([
      "familyId", "id", "options", "phase", "prompt", "skillId", "skillLabel", "version",
    ]);
    expect(JSON.stringify(publicItem)).not.toContain(item.hint);
    expect(JSON.stringify(publicItem)).not.toContain(item.solution);
    publicItem.options[0]!.label = "client changed this";
    publicItem.options.push({ id: "Z", label: "injected" });
    expect(item.options).toHaveLength(4);
    expect(item.options[0]!.label).not.toBe("client changed this");
  });

  it("uses objective simplification goals for u selection instead of claiming other decompositions are invalid", () => {
    const intendedAnswers = [
      ["parts-p-u-exp", "u = x，dv = e^x dx"],
      ["parts-p-u-trig", "u = x，dv = cos x dx"],
      ["parts-48-u-log", "u = ln x，dv = dx"],
      ["parts-7-u-inverse", "u = arctan x，dv = dx"],
    ];
    for (const [id, label] of intendedAnswers) {
      const item = unit.items.find((entry) => entry.id === id)!;
      expect(gradeMeasurementAnswer(item, item.options.find((option) => option.label === label)!.id)).toBe("correct");
    }
  });

  it("checks every compute-v option against its derivative, including wrong signs and missing factors", () => {
    const functions: Record<string, (x: number) => number> = {
      "e^(2x)": (x) => Math.exp(2 * x), "2e^(2x)": (x) => 2 * Math.exp(2 * x),
      "e^(−2x)/2": (x) => Math.exp(-2 * x) / 2, "e^(2x)/2": (x) => Math.exp(2 * x) / 2,
      "−sin x": (x) => -Math.sin(x),
      "sin x": Math.sin, "cos x": Math.cos, "−cos x": (x) => -Math.cos(x),
      "arctan x": Math.atan, "ln(1 + x²)": (x) => Math.log(1 + x * x),
      "1/(1 + x²)": (x) => 1 / (1 + x * x), "−1/(1 + x²)": (x) => -1 / (1 + x * x),
      "x²/2": (x) => x * x / 2, "x²": (x) => x * x, "1": () => 1, "ln x": Math.log,
    };
    const integrands: Record<string, (x: number) => number> = {
      "parts-p-v-exp": (x) => Math.exp(2 * x), "parts-p-v-trig": Math.sin,
      "parts-48-v-inverse": (x) => 1 / (1 + x * x), "parts-7-v-power": (x) => x,
    };
    for (const item of unit.items.filter((entry) => entry.skillId === "compute-v")) {
      for (const option of item.options) {
        const matches = [0.4, 1.3, 2.1].every((x) => {
          const f = functions[option.label]!;
          const derivative = (f(x + 0.00001) - f(x - 0.00001)) / 0.00002;
          return Math.abs(derivative - integrands[item.id]!(x)) < 0.000001;
        });
        expect(gradeMeasurementAnswer(item, option.id), `${item.id}: ${option.label}`)
          .toBe(matches ? "correct" : "incorrect");
      }
    }
  });

  it("does not give the exact answer to a future compute-v probe in earlier feedback", () => {
    for (const [index, item] of unit.items.entries()) {
      if (item.skillId !== "compute-v") continue;
      const answer = item.options.find((option) => option.id === item.correctOptionId)!.label;
      for (const previous of unit.items.slice(0, index)) {
        expect(previous.solution, `${previous.id} exposes ${item.id}`).not.toContain(`v = ${answer}`);
        expect(previous.hint, `${previous.id} exposes ${item.id}`).not.toContain(`v = ${answer}`);
      }
    }
  });

  it("assembles the given uv and vdu, preserving both negative signs and factors", () => {
    const intendedAnswers = [
      ["parts-p-a-exp", "∫x e^x dx = x e^x − ∫e^x dx"],
      ["parts-p-a-trig", "∫x sin x dx = −x cos x + ∫cos x dx"],
      ["parts-48-a-cyclic", "∫e^x sin x dx = −e^x cos x + ∫e^x cos x dx"],
      ["parts-7-a-reciprocal", "∫(ln x)/x² dx = −(ln x)/x + ∫dx/x²"],
    ];
    for (const [id, label] of intendedAnswers) {
      const item = unit.items.find((entry) => entry.id === id)!;
      expect(gradeMeasurementAnswer(item, item.options.find((option) => option.label === label)!.id)).toBe("correct");
    }
  });
});

describe("measurement probe schedule", () => {
  it("uses the supplied frozen bank and ignores unrelated trial attempts", () => {
    const frozen = [{ ...practice[0]!, id: "enrolled-frozen-item", prompt: "frozen prompt" }];
    expect(select({ items: frozen }).item).toBe(frozen[0]);
    expect(select({ attempts: [attempt(practice[0]!, 0, { trialId: "another-trial", outcome: null })] }).item)
      .toBe(practice[0]);
  });

  it("does not issue another item while the current item is unanswered", () => {
    expect(select({ attempts: [attempt(practice[0]!, 0, { answer: null, answeredAt: null, outcome: null })] }))
      .toEqual({ item: null, dueAt: null, complete: false });
  });

  it("moves past skipped and retracted exposures without retrying the same questions", () => {
    const attempts = [
      attempt(practice[0]!, 0, { answer: null, outcome: "skipped" }),
      attempt(practice[1]!, 1, { answer: null, outcome: null, retractedAt: completedAt, retractionReason: "interrupted" }),
    ];
    expect(select({ attempts }).item).toBe(practice[2]);
  });

  it("requires the recorded practice completion time even when all practice items are closed", () => {
    expect(select({ attempts: practiceAttempts })).toEqual({ item: null, dueAt: null, complete: false });
  });

  it("gates the first delayed phase at exactly 48 hours after completion, not enrollment", () => {
    const inputs = { trial: { ...trial, practiceCompletedAt: completedAt }, attempts: practiceAttempts };
    expect(select({ ...inputs, now: "2026-10-19T02:59:59.999Z" }))
      .toEqual({ item: null, dueAt: due48h, complete: false });
    expect(select({ ...inputs, now: new Date(due48h) }))
      .toEqual({ item: delay48h[0], dueAt: due48h, complete: false });
  });

  it("keeps the original due time when late instead of relabeling a late answer as on time", () => {
    expect(select({ trial: { ...trial, practiceCompletedAt: completedAt }, attempts: practiceAttempts, now: due7d }))
      .toEqual({ item: delay48h[0], dueAt: due48h, complete: false });
  });

  it("anchors the 7-day phase to practice completion even if the 48-hour phase was late", () => {
    const attempts = [...practiceAttempts, ...delay48h.map((item, index) => attempt(item, index + 6, {
      presentedAt: "2026-10-23T10:00:00.000Z", answeredAt: "2026-10-23T10:01:00.000Z", dueAt: due48h,
    }))];
    const inputs = { trial: { ...trial, practiceCompletedAt: completedAt }, attempts };
    expect(select({ ...inputs, now: "2026-10-24T02:59:59.999Z" })).toEqual({ item: null, dueAt: due7d, complete: false });
    expect(select({ ...inputs, now: due7d })).toEqual({
      item: unit.items.find((item) => item.phase === "delay_7d"), dueAt: due7d, complete: false,
    });
  });

  it("preserves due dates while paused but never issues items", () => {
    expect(select({ trial: { ...trial, status: "paused" } })).toEqual({ item: null, dueAt: null, complete: false });
    expect(select({ trial: { ...trial, status: "paused", practiceCompletedAt: completedAt },
      attempts: practiceAttempts, now: due7d })).toEqual({ item: null, dueAt: due48h, complete: false });
  });

  it("marks exhaustion complete, and never reopens a completed trial", () => {
    expect(select({ attempts: unit.items.map((item, index) => attempt(item, index)) }))
      .toEqual({ item: null, dueAt: null, complete: true });
    expect(select({ trial: { ...trial, status: "completed" } })).toEqual({ item: null, dueAt: null, complete: true });
  });

  it("rejects invalid persisted timestamps rather than silently allowing delayed probes", () => {
    expect(() => select({ trial: { ...trial, practiceCompletedAt: "invalid" }, attempts: practiceAttempts })).toThrow(RangeError);
    expect(() => select({ trial: { ...trial, practiceCompletedAt: completedAt }, attempts: practiceAttempts, now: "invalid" }))
      .toThrow(RangeError);
  });
});
