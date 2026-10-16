import { describe, expect, it } from "vitest";
import type { MeasurementAttempt, MeasurementPrediction } from "@aistudy/contracts";
import { MEASUREMENT_MODELS, MEASUREMENT_PLUGINS, measurementEligibility, measurementTimingExclusion, predictMeasurementPair, resolveMeasurementPlugins, validateMeasurementModels } from "./evaluation";
import { buildMeasurementReport } from "./report";

const epoch = Date.parse("2026-10-16T00:00:00.000Z");
const time = (minute: number) => new Date(epoch + minute * 60_000).toISOString();

function attempt(ordinal: number, overrides: Partial<MeasurementAttempt> = {}): MeasurementAttempt {
  const presentedAt = time(ordinal * 2);
  return {
    id: `attempt-${ordinal}`, trialId: "trial-a", ordinal,
    item: { id: `item-${ordinal}`, version: "1", skillId: "parts-method", skillLabel: "分部积分选取",
      familyId: `family-${ordinal}`, phase: "practice", prompt: "选择 u", options: [{ id: "a", label: "x" }] },
    presentedAt, answeredAt: time(ordinal * 2 + 1), dueAt: null, firstAttempt: true,
    helpEvents: [], answer: "a", outcome: "correct", retractedAt: null, retractionReason: null,
    predictions: predictMeasurementPair({ skillId: "parts-method", history: [], predictedAt: presentedAt }),
    feedback: null, feedbackWithheld: false, ...overrides,
  };
}

function probabilities(predictions: MeasurementPrediction[]) { return predictions.map(prediction => prediction.probability); }
function withProbabilities(row: MeasurementAttempt, bkt: number, frequency: number): MeasurementAttempt {
  return { ...row, predictions: row.predictions.map((prediction, index) => ({ ...prediction, probability: [bkt, frequency][index]! })) };
}

describe("measurement model plugins", () => {
  it("declares fixed uncalibrated classical BKT and an explicit frequency baseline", () => {
    expect(MEASUREMENT_MODELS.map(model => [model.id, model.calibrated])).toEqual([
      ["classical-bkt", false], ["smoothed-frequency", false],
    ]);
    expect(probabilities(predictMeasurementPair({ skillId: "parts-method", history: [], predictedAt: time(0) }))).toEqual([0.38, 0.5]);
  });

  it.each([
    ["correct", 0.5921052631578947, 2 / 3],
    ["incorrect", 0.3338709677419355, 1 / 3],
  ] as const)("conditions on an earlier %s answer before predicting the next one", (outcome, bkt, baseline) => {
    const earlier = attempt(1, { outcome });
    const predictions = predictMeasurementPair({ skillId: earlier.item.skillId, history: [earlier], predictedAt: time(4) });
    expect(predictions[0]!.probability).toBeCloseTo(bkt, 12);
    expect(predictions[1]!.probability).toBeCloseTo(baseline, 12);
    expect(predictions.every(prediction => prediction.evidenceAttemptIds.join() === earlier.id)).toBe(true);
    // This forecast was stored before the outcome and must not become an in-sample estimate.
    expect(probabilities(earlier.predictions)).toEqual([0.38, 0.5]);
  });

  it("uses only prior answers for the same stable skill, independent of input ordering", () => {
    const first = attempt(1);
    const second = attempt(2, { outcome: "incorrect" });
    const future = attempt(4);
    const other = attempt(3, { item: { ...first.item, skillId: "parts-execution" } });
    const input = { skillId: first.item.skillId, history: [future, second, other, first], predictedAt: time(7) };
    const before = structuredClone(input);
    const prediction = predictMeasurementPair(input);
    expect(prediction[0]!.evidenceAttemptIds).toEqual([first.id, second.id]);
    expect(prediction).toEqual(predictMeasurementPair({ ...input, history: [first, second] }));
    expect(input).toEqual(before);
  });

  it.each([
    ["pending", { answeredAt: null, outcome: null }],
    ["skipped", { outcome: "skipped" }],
    ["assisted", { helpEvents: [{ kind: "hint", recordedAt: time(2) }] }],
    ["assisted", { helpEvents: [{ kind: "external", recordedAt: time(2) }] }],
    ["repeated", { firstAttempt: false }],
    ["retracted", { retractedAt: time(4), retractionReason: "录入错误" }],
    ["feedback_withheld", { feedbackWithheld: true }],
  ] satisfies Array<[string, Partial<MeasurementAttempt>]>)("does not learn from %s evidence", (reason, override) => {
    const row = attempt(1, override);
    expect(measurementEligibility(row)).toBe(reason);
    expect(probabilities(predictMeasurementPair({ skillId: row.item.skillId, history: [row], predictedAt: time(5) }))).toEqual([0.38, 0.5]);
  });

  it("rejects mixed trials and duplicate history instead of inflating the evidence", () => {
    const row = attempt(1);
    expect(() => predictMeasurementPair({ skillId: row.item.skillId, history: [row, { ...attempt(2), trialId: "other" }], predictedAt: time(8) })).toThrow(/one trial/);
    expect(() => predictMeasurementPair({ skillId: row.item.skillId, history: [row, row], predictedAt: time(8) })).toThrow(/duplicate/);
  });

  it("binds each manifest to its own plugin when extended or reordered", () => {
    const custom = {
      manifest: { id: "test-predictor", version: "2", label: "test", calibrated: false as const, parameters: { constant: 0.7 } },
      predict: (history: readonly boolean[]) => history.length ? 0.7 : 0.4,
    };
    const input = { skillId: "parts-method", history: [attempt(1)], predictedAt: time(5) };
    const result = predictMeasurementPair({ ...input, plugins: [custom, ...[...MEASUREMENT_PLUGINS].reverse()] });
    expect(result.map(row => row.modelId)).toEqual(["test-predictor", "smoothed-frequency", "classical-bkt"]);
    expect(result[0]!.probability).toBe(0.7);
    expect(result[1]!.probability).toBeCloseTo(2 / 3, 12);
    expect(result[2]!.probability).toBeCloseTo(0.5921052631578947, 12);
    expect(() => predictMeasurementPair({ ...input, plugins: [{ ...custom, predict: () => Number.NaN }] })).toThrow(/invalid probability/);
  });

  it("refuses to silently resume a trial against changed model parameters or versions", () => {
    expect(() => validateMeasurementModels(structuredClone(MEASUREMENT_MODELS))).not.toThrow();
    const changed = structuredClone(MEASUREMENT_MODELS);
    changed[0]!.parameters.guess = 0.2;
    expect(() => validateMeasurementModels(changed)).toThrow(/changed/);
    changed[0] = { ...MEASUREMENT_MODELS[0]!, version: "2" };
    expect(() => validateMeasurementModels(changed)).toThrow(/changed/);
    expect(() => validateMeasurementModels([MEASUREMENT_MODELS[0]!, MEASUREMENT_MODELS[0]!])).toThrow(/unique/);
  });

  it("keeps an existing trial on its original plugin subset when new models or versions are installed", () => {
    const existing = structuredClone(MEASUREMENT_MODELS);
    const futurePlugin = {
      manifest: { ...MEASUREMENT_MODELS[0]!, version: "2", parameters: { guess: 0.1 } },
      predict: () => 0.9,
    };
    const expanded = [futurePlugin, ...MEASUREMENT_PLUGINS];
    const plugins = resolveMeasurementPlugins(existing, expanded);
    const input = { skillId: "parts-method", history: [attempt(1)], predictedAt: time(5) };
    expect(predictMeasurementPair({ ...input, plugins })).toEqual(predictMeasurementPair(input));
    expect(plugins.map(plugin => `${plugin.manifest.id}@${plugin.manifest.version}`)).toEqual(["classical-bkt@1", "smoothed-frequency@1"]);
    expect(() => resolveMeasurementPlugins(existing, [futurePlugin, MEASUREMENT_PLUGINS[1]!])).toThrow(/restore its versioned plugin/);
  });
});

describe("paired prospective measurement report", () => {
  it("scores stored probabilities on exactly the same outcomes and keeps calibration separate", () => {
    const first = withProbabilities(attempt(1), 0.25, 0.5);
    const second = withProbabilities(attempt(2, { outcome: "incorrect", dueAt: time(4), item: { ...first.item, phase: "delay_7d" } }), 0.75, 0.5);
    const report = buildMeasurementReport([first, second]);
    expect(report.eligible).toBe(2);
    expect(report.models.map(model => model.count)).toEqual([2, 2]);
    expect(report.models[0]!.brier).toBe(0.5625);
    expect(report.models[1]!.brier).toBe(0.25);
    expect(report.models[0]!.logLoss).toBeCloseTo(Math.log(4), 12);
    expect(report.models[1]!.logLoss).toBeCloseTo(Math.log(2), 12);
    expect(report.pairedBrierDifference).toBe(0.3125);
    expect(report.pairedLogLossDifference).toBeCloseTo(Math.log(2), 12);
    expect(report.models[0]!.calibration[1]).toEqual({ lower: 0.2, upper: 0.4, count: 1, meanPrediction: 0.25, observedAccuracy: 1 });
    expect(report.byPhase.map(group => group.eligible)).toEqual([1, 0, 1]);
    expect(report.conclusion).toBe("insufficient_evidence");
  });

  it("excludes an unpaired row for both models, retaining explicit coverage counts", () => {
    const complete = attempt(1);
    const incomplete = attempt(2, { predictions: [attempt(2).predictions[0]!] });
    const report = buildMeasurementReport([complete, incomplete]);
    expect(report).toMatchObject({ presented: 2, answered: 2, eligible: 1, excluded: { missing_prediction: 1 } });
    expect(report.models.map(model => model.count)).toEqual([1, 1]);
  });

  it("invalidates retracted evidence and dependent scores without rewriting forecasts", () => {
    const first = attempt(1);
    const second = attempt(2, { predictions: predictMeasurementPair({ skillId: first.item.skillId, history: [first], predictedAt: time(4) }) });
    const saved = structuredClone(second.predictions);
    const retracted = { ...first, retractedAt: time(6), retractionReason: "答案录错" };
    const report = buildMeasurementReport([retracted, second]);
    expect(report).toMatchObject({ eligible: 0, excluded: { retracted: 1, invalidated_history: 1 } });
    expect(second.predictions).toEqual(saved);
    expect(predictMeasurementPair({ skillId: first.item.skillId, history: [retracted], predictedAt: time(8) })[0]!.probability).toBe(0.38);
  });

  it.each([
    ["prediction_after_presentation", (row: MeasurementAttempt) => ({ ...row.predictions[0]!, predictedAt: row.answeredAt! })],
    ["invalid_prediction", (row: MeasurementAttempt) => ({ ...row.predictions[0]!, probability: Number.NaN })],
    ["invalid_prediction_history", (row: MeasurementAttempt) => ({ ...row.predictions[0]!, evidenceAttemptIds: [row.id] })],
    ["missing_prediction_history", (row: MeasurementAttempt) => ({ ...row.predictions[0]!, evidenceAttemptIds: ["unknown"] })],
  ] as const)("excludes %s instead of reporting misleading scores", (reason, change) => {
    const row = attempt(1);
    row.predictions[0] = change(row);
    const report = buildMeasurementReport([row]);
    expect(report.excluded).toEqual({ [reason]: 1 });
    expect(report.models.every(model => model.count === 0 && model.brier === null && model.logLoss === null)).toBe(true);
  });

  it("rejects future, other-skill and different model history on otherwise valid rows", () => {
    const first = attempt(1);
    const second = attempt(2);
    for (const evidence of [
      { ...first, answeredAt: time(9) },
      { ...first, item: { ...first.item, skillId: "different-skill" } },
    ]) {
      second.predictions = second.predictions.map(prediction => ({ ...prediction, evidenceAttemptIds: [first.id] }));
      expect(buildMeasurementReport([evidence, second]).excluded.invalid_prediction_history).toBe(1);
    }
    second.predictions[1]!.evidenceAttemptIds = [];
    expect(buildMeasurementReport([first, second]).excluded.unpaired_prediction_history).toBe(1);
  });

  it("counts withheld answers as submitted while keeping outcomes and scores unavailable", () => {
    const withheld = attempt(1, { feedbackWithheld: true, outcome: null, predictions: [] });
    const pending = attempt(2, { answeredAt: null, outcome: null, answer: null });
    const skipped = attempt(3, { outcome: "skipped", answer: null });
    const report = buildMeasurementReport([withheld, pending, skipped]);
    expect(report).toMatchObject({ presented: 3, answered: 2, pending: 1, skipped: 1, eligible: 0,
      excluded: { feedback_withheld: 1, pending: 1, skipped: 1 } });
    expect(report.pairedBrierDifference).toBeNull();
  });

  it("handles probability endpoints and bin boundaries without non-finite JSON scores", () => {
    const rows = [withProbabilities(attempt(1), 0, 0.2), withProbabilities(attempt(2), 1, 1)];
    const report = buildMeasurementReport(rows);
    expect(report.models[0]!.calibration.map(bin => bin.count)).toEqual([1, 0, 0, 0, 1]);
    expect(report.models[1]!.calibration.map(bin => bin.count)).toEqual([0, 1, 0, 0, 1]);
    expect(Number.isFinite(report.models[0]!.logLoss)).toBe(true);
  });

  it("does not turn many correlated answers from one learner into significance or learning gains", () => {
    const rows = Array.from({ length: 100 }, (_, index) => attempt(index));
    expect(buildMeasurementReport(rows).conclusion).toBe("insufficient_evidence");
    const empty = buildMeasurementReport([]);
    expect(empty.models.every(model => model.count === 0 && model.brier === null && model.logLoss === null)).toBe(true);
    expect(() => buildMeasurementReport([rows[0]!, rows[0]!])).toThrow(/duplicate/);
  });
});

describe("delayed-probe timing", () => {
  const day = 24 * 60;
  function delayed(phase: "delay_48h" | "delay_7d", presentedMinute: number, answeredMinute: number) {
    const row = attempt(2);
    const presentedAt = time(presentedMinute);
    return {
      ...row, item: { ...row.item, phase }, presentedAt, answeredAt: time(answeredMinute),
      dueAt: time((phase === "delay_48h" ? 2 : 7) * day),
      predictions: predictMeasurementPair({ skillId: row.item.skillId, history: [], predictedAt: presentedAt }),
    };
  }

  it.each([
    ["delay_48h", 2, 4], ["delay_7d", 7, 10],
  ] as const)("keeps %s at its declared boundary and excludes a later submission", (phase, dueDay, endDay) => {
    const atBoundary = delayed(phase, dueDay * day, endDay * day);
    expect(measurementTimingExclusion(atBoundary, [])).toBeNull();
    expect(measurementTimingExclusion({ ...atBoundary, answeredAt: time(endDay * day + 1) }, [])).toBe("late_probe");
    expect(measurementTimingExclusion({ ...atBoundary, dueAt: null }, [])).toBe("invalid_timing");
    expect(measurementTimingExclusion({ ...atBoundary, presentedAt: time(dueDay * day - 1) }, [])).toBe("invalid_timing");
  });

  it.each([
    { outcome: "skipped" as const },
    { retractedAt: time(6 * day), retractionReason: "录入错误" },
    { helpEvents: [{ kind: "hint" as const, recordedAt: time(6 * day) }] },
  ])("requires a fresh gap even if the earlier 48-hour probe was excluded: %j", override => {
    const earlier = { ...delayed("delay_48h", 6 * day, 6 * day + 5), id: "earlier-probe", ordinal: 1, ...override };
    const later = delayed("delay_7d", 7 * day, 7 * day + 5);
    expect(measurementTimingExclusion(later, [earlier, later])).toBe("insufficient_retest_gap");
    expect(buildMeasurementReport([earlier, later]).excluded.insufficient_retest_gap).toBe(1);
  });

  it("accepts a full 72-hour gap and retains late probes as unscored observations", () => {
    const earlier = { ...delayed("delay_48h", 4 * day - 5, 4 * day), id: "earlier-probe", ordinal: 1 };
    const later = delayed("delay_7d", 7 * day, 7 * day + 5);
    expect(measurementTimingExclusion(later, [earlier, later])).toBeNull();
    const late = { ...earlier, answeredAt: time(4 * day + 1) };
    const report = buildMeasurementReport([late]);
    expect(report).toMatchObject({ presented: 1, answered: 1, eligible: 0, excluded: { late_probe: 1 } });
    expect(predictMeasurementPair({ skillId: late.item.skillId, history: [late], predictedAt: time(8 * day) })[0]!.probability).toBe(0.38);
  });
});
