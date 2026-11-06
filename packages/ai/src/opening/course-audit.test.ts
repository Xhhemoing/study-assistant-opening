import { describe, expect, it } from "vitest";
import { binomialUpper95 } from "@aistudy/domain";
import { courseAuditReviewIdentity, createCourseAuditReview } from "../../../../scripts/study-course-audit-review";
import { createCourseAuditSample } from "../../../../scripts/study-course-audit-sample";

// Pure-function units for the offline course audit scripts; no files, database, network or model calls.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const COURSE = id(9000);
type Block = { id: string; type: string; position: number; content: Record<string, unknown>; role: string };
type Row = { n: number; mandatory?: boolean; sourcesAvailable?: boolean; saved?: boolean; activity?: boolean; blocks?: Block[] };

const pair = (base: number, index: number, question = `Q${base}-${index}`, answer = `A${base}-${index}`): Block[] => [
  { id: id(base + index * 2), type: "question", position: index * 2, content: { text: question }, role: "prompt" },
  { id: id(base + index * 2 + 1), type: "solution", position: index * 2 + 1, content: { text: answer }, role: "answer_key" },
];
const questions = (n: number, count: number) => Array.from({ length: count }, (_, index) => pair(n * 1000, index)).flat();

function input(rows: Row[], artifactsFor = rows) {
  const requirements = rows.map(row => ({
    requirement: { id: id(row.n), courseId: COURSE, revision: 1, stableSkillId: id(row.n + 100), knowledgeNodeId: null,
      requirementKey: `r${row.n}`, title: `Requirement ${row.n}`, position: row.n, mandatory: row.mandatory ?? true,
      goalIds: [], prerequisiteIds: [], sourceRefs: [],
      verification: { kind: "manual", status: "needs_check", exerciseKeys: [], rubric: null, missingReasons: [] },
      origin: "confirmed", lifecycle: "active", approvedAt: null },
    compilation: { activityId: id(row.n + 200), generateStatus: "ready", contentVersion: 3, saved: row.saved ?? true,
      documentId: id(row.n + 300), revisionNumber: 2, verificationStatus: "needs_check" },
    status: "needs_correction", observationId: null, missingReasons: [], sourcesAvailable: row.sourcesAvailable ?? true,
  }));
  const artifacts = artifactsFor.filter(row => row.activity !== false && (row.saved ?? true)).map(row => {
    const blocks = row.blocks ?? [];
    return { spec: { id: id(row.n + 400), activityId: id(row.n + 200), teachingUnitId: id(row.n + 500), documentId: id(row.n + 300),
      revisionNumber: 2, blockOrder: blocks.map(block => ({ blockId: block.id, position: block.position, blockType: block.type, role: block.role })),
      sourceRefs: [{ sourceId: id(8000), version: 1 }], goals: [], verificationStatus: "needs_check", generationConfig: {}, version: 3,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    revision: { documentId: id(row.n + 300), revisionNumber: 2,
      blocks: blocks.map(({ role: _role, ...block }) => block) } };
  });
  const mandatory = rows.filter(row => row.mandatory ?? true).length;
  return { snapshot: { courseId: COURSE, scopeState: "confirmed", requirements, suggestions: [],
    summary: { total: rows.length, mandatory, verified: 0, blocked: 0 }, materials: [], currentActivity: null, currentRoute: null, observationId: null },
  artifacts };
}
// The CLI hands review a JSON round-trip of the sampler output; reproduce that boundary exactly.
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sampleOf = (rows: Row[], size: number) => json(createCourseAuditSample(input(rows), size));
const questionKey = (item: { documentId: string; revisionNumber: number; questionBlockId: string }) =>
  JSON.stringify([item.documentId, item.revisionNumber, item.questionBlockId]);
const block = (index: number, type: string, role: string, text: string): Block =>
  ({ id: id(1000 + index), type, position: index, content: { text }, role });
const gapRows: Row[] = [
  { n: 1, blocks: [block(0, "question", "prompt", "  "), block(1, "solution", "answer_key", "A0"),
    block(2, "question", "prompt", "Q no answer"), block(3, "question", "prompt", "Q blank answer"),
    block(4, "solution", "answer_key", " "), block(5, "question", "prompt", "Q ok"), block(6, "solution", "answer_key", "A ok")] },
  { n: 2, sourcesAvailable: false, blocks: questions(2, 1) },
  { n: 3, saved: false },
  { n: 4, activity: false },
  { n: 5, blocks: [{ id: id(5000), type: "text", position: 0, content: { text: "teach only" }, role: "teach" }] },
  { n: 6, mandatory: false, blocks: questions(6, 2) },
];

describe("createCourseAuditSample", () => {
  it("classifies every gap reason and keeps only complete prompt/answer pairs in the frame", () => {
    const sample = createCourseAuditSample(input(gapRows), 1);
    const gaps = Object.fromEntries(sample.requirements.map(row => [row.requirement.requirementKey, { eligible: row.eligible, gaps: row.gaps }]));
    expect(gaps).toStrictEqual({
      r1: { eligible: 1, gaps: [{ reason: "empty_question", questionBlockId: id(1000) },
        { reason: "missing_reference_answer", questionBlockId: id(1002) }, { reason: "missing_reference_answer", questionBlockId: id(1003) }] },
      r2: { eligible: 0, gaps: [{ reason: "source_unavailable" }] },
      r3: { eligible: 0, gaps: [{ reason: "unsaved_compilation" }] },
      r4: { eligible: 0, gaps: [{ reason: "missing_artifact" }] },
      r5: { eligible: 0, gaps: [{ reason: "no_questions" }] },
      r6: { eligible: 2, gaps: [] },
    });
    expect(sample.counts).toStrictEqual({ requirements: 6, mandatory: 5, optional: 1, population: 3, sampled: 1 });
    expect(sample.mandatory).toStrictEqual({ requirements: 5, eligible: 1, requirementsWithGaps: 5 });
    expect(sample.optional).toStrictEqual({ requirements: 1, eligible: 2, requirementsWithGaps: 0 });
    expect(sample.samplingFrame.map(item => [item.questionBlockId, item.answerBlockId]))
      .toStrictEqual([[id(1005), id(1006)], [id(6000), id(6001)], [id(6002), id(6003)]]);
    expect(Object.keys(sample.samplingFrame[0]!)).not.toContain("prompt");
  });

  it("draws a subset of the frame without replacement", () => {
    const seen = new Set<string>();
    for (let run = 0; run < 40; run += 1) {
      const sample = createCourseAuditSample(input([{ n: 1, blocks: questions(1, 6) }, { n: 2, mandatory: false, blocks: questions(2, 4) }]), 4);
      const frame = new Map(sample.samplingFrame.map(item => [questionKey(item), item]));
      const keys = sample.samples.map(questionKey);
      expect(sample.counts.population).toBe(10);
      expect(keys).toHaveLength(4);
      expect(new Set(keys).size).toBe(4);
      for (const item of sample.samples) {
        expect(courseAuditReviewIdentity(item)).toStrictEqual(frame.get(questionKey(item)));
        expect(item.reviewStatus).toBe("pending");
        seen.add(questionKey(item));
      }
    }
    // 40 draws of 4 from 10 miss a given question with probability 0.6^40 ≈ 1e-9.
    expect(seen.size).toBe(10);
  });

  it("returns a permutation of the whole frame at sampleSize = population and rejects larger or non-positive sizes", () => {
    const rows: Row[] = [{ n: 1, blocks: questions(1, 3) }];
    const sample = createCourseAuditSample(input(rows), 3);
    expect(sample.samples.map(questionKey).sort()).toStrictEqual(sample.samplingFrame.map(questionKey).sort());
    expect(() => createCourseAuditSample(input(rows), 4)).toThrow("Sample size exceeds population");
    expect(() => createCourseAuditSample(input([{ n: 1, blocks: [] }]), 1)).toThrow("Sample size exceeds population");
    for (const size of [0, -1, 1.5, Number.NaN]) expect(() => createCourseAuditSample(input(rows), size)).toThrow("Invalid sample size");
  });

  it("rejects artifacts that do not match the saved compilation", () => {
    const raw = input([{ n: 1, blocks: questions(1, 2) }]);
    raw.artifacts[0]!.spec.version = 4;
    expect(() => createCourseAuditSample(raw, 1)).toThrow("Artifact version mismatch");
  });
});
type Outcome = "correct" | "incorrect" | "unjudgeable";
type AuditSample = ReturnType<typeof sampleOf>;
type AuditItem = AuditSample["samples"][number];
const reviewsFor = (sample: AuditSample, plan: Array<[AuditItem, Outcome]>) =>
  ({ courseId: sample.courseId, results: plan.map(([item, outcome]) => ({ identity: courseAuditReviewIdentity(item), outcome })) });
const groupsOf = (sample: AuditSample) => ({ mandatory: sample.samples.filter(item => item.requirement.mandatory),
  optional: sample.samples.filter(item => !item.requirement.mandatory) });
// Exact one-sided Clopper–Pearson roots (beta.ppf(0.95, k + 1, n - k)) from Python decimal, 80 digits.
const EXACT_UPPER95: ReadonlyArray<[number, number, number]> = [
  [1, 2, 0.9746794344808964], [2, 3, 0.9830475724915585], [1, 3, 0.8646496378284162],
  [2, 5, 0.8107446225622292], [3, 6, 0.8468388820247769],
];

describe("createCourseAuditReview", () => {
  const rows: Row[] = [{ n: 1, blocks: questions(1, 4) }, { n: 2, mandatory: false, blocks: questions(2, 3) }];
  const sample = sampleOf(rows, 7);
  const { mandatory: m, optional: o } = groupsOf(sample);
  // mandatory: correct, incorrect, unjudgeable, pending; optional: correct, correct, incorrect.
  const plan: Array<[AuditItem, Outcome]> = [[m[0]!, "correct"], [m[1]!, "incorrect"], [m[2]!, "unjudgeable"],
    [o[0]!, "correct"], [o[1]!, "correct"], [o[2]!, "incorrect"]];

  it("rejects altered samples and reviews that are not bound to the exact sample", () => {
    const sampleMutations: Array<(s: AuditSample) => void> = [
      s => { s.counts.population += 1; },
      s => { s.samples[0]!.contentVersion += 1; },
      s => { s.samples.push(s.samples[0]!); s.counts.sampled += 1; },
      s => { s.mandatory.eligible -= 1; },
    ];
    for (const mutate of sampleMutations) {
      const altered = json(sample);
      mutate(altered);
      expect(() => createCourseAuditReview(altered, reviewsFor(sample, []))).toThrow();
    }
    expect(() => createCourseAuditReview({ ...sample, format: "course-audit-pending-v0" }, reviewsFor(sample, []))).toThrow();
    const subset = sampleOf(rows, 2);
    const unsampled = subset.samplingFrame.find(item => !subset.samples.some(s => questionKey(s) === questionKey(item)))!;
    expect(() => createCourseAuditReview(subset, { courseId: subset.courseId, results: [{ identity: unsampled, outcome: "correct" }] }))
      .toThrow("Invalid local audit binding");
    const tampered = reviewsFor(sample, [[m[0]!, "correct"]]);
    tampered.results[0]!.identity.contentVersion += 1;
    expect(() => createCourseAuditReview(sample, tampered)).toThrow("Invalid local audit binding");
    expect(() => createCourseAuditReview(sample, reviewsFor(sample, [[m[0]!, "correct"], [m[0]!, "incorrect"]]))).toThrow("Invalid local audit identity");
    expect(() => createCourseAuditReview(sample, { ...reviewsFor(sample, []), courseId: id(9999) })).toThrow("Invalid local audit binding");
    expect(() => createCourseAuditReview(sample, { courseId: sample.courseId, results: [{ identity: courseAuditReviewIdentity(m[0]!), outcome: "pending" }] })).toThrow();
  });

  it("counts every group and reports error rates with pending, unjudgeable and conservative figures", () => {
    const report = createCourseAuditReview(sample, reviewsFor(sample, plan));
    expect(report.format).toBe("course-audit-review-v2");
    expect(report.reviewCounts).toStrictEqual({
      all: { total: 7, reviewed: 6, pending: 1, correct: 3, incorrect: 2, unjudgeable: 1 },
      mandatory: { total: 4, reviewed: 3, pending: 1, correct: 1, incorrect: 1, unjudgeable: 1 },
      optional: { total: 3, reviewed: 3, pending: 0, correct: 2, incorrect: 1, unjudgeable: 0 },
    });
    const { all, mandatory, optional } = report.errorRate;
    expect(all).toMatchObject({ population: 7, sampleSize: 7, complete: false, judged: 5, incorrect: 2, unjudgeable: 1,
      rate: 0.4, conservative: { errors: 3, denominator: 6, rate: 0.5 }, pointEstimateWithin2Percent: null });
    expect(all.upper95).toBe(binomialUpper95(2, 5));
    expect(all.conservative.upper95).toBe(binomialUpper95(3, 6));
    expect(mandatory).toMatchObject({ population: 4, sampleSize: 4, complete: false, judged: 2, incorrect: 1, unjudgeable: 1,
      rate: 0.5, conservative: { errors: 2, denominator: 3 }, pointEstimateWithin2Percent: null });
    expect(optional).toMatchObject({ population: 3, sampleSize: 3, complete: true, judged: 3, incorrect: 1, unjudgeable: 0,
      rate: 1 / 3, conservative: { errors: 1, denominator: 3, rate: 1 / 3 }, pointEstimateWithin2Percent: false });
    expect(optional.upper95).toBe(optional.conservative.upper95);
    for (const [k, n, reference] of EXACT_UPPER95) expect(Math.abs(binomialUpper95(k, n)! - reference)).toBeLessThan(1e-9);
    expect(mandatory.upper95).toBe(binomialUpper95(1, 2));
    expect(mandatory.conservative.upper95).toBe(binomialUpper95(2, 3));
    expect(optional.upper95).toBe(binomialUpper95(1, 3));
    expect(report.errorRateDefinition).toMatch(/independent binomial/);
    expect(report.errorRateDefinition).toMatch(/upper95 <= 2% is not a default acceptance condition/);
    expect(report.errorRateDefinition).toMatch(/targeted error hunting are not random samples/);
  });

  it("leaves rates null with no judged answers and counts all-unjudgeable as conservative errors", () => {
    const pending = createCourseAuditReview(sample, reviewsFor(sample, []));
    expect(pending.errorRate.all).toStrictEqual({ population: 7, sampleSize: 7, complete: false, judged: 0, incorrect: 0, unjudgeable: 0,
      rate: null, upper95: null, conservative: { errors: 0, denominator: 0, rate: null, upper95: null }, pointEstimateWithin2Percent: null });
    const unjudgeable = createCourseAuditReview(sample, reviewsFor(sample, o.map(item => [item, "unjudgeable"])));
    expect(unjudgeable.errorRate.optional).toStrictEqual({ population: 3, sampleSize: 3, complete: true, judged: 0, incorrect: 0, unjudgeable: 3,
      rate: null, upper95: null, conservative: { errors: 3, denominator: 3, rate: 1, upper95: 1 }, pointEstimateWithin2Percent: null });
  });

  it("decides the 2% point estimate exactly and keeps the conservative figure separate", () => {
    const big = sampleOf([{ n: 1, blocks: questions(1, 50) }, { n: 2, mandatory: false, blocks: questions(2, 49) }], 99);
    const g = groupsOf(big);
    const report = createCourseAuditReview(big, reviewsFor(big, [
      ...g.mandatory.map((item, index): [AuditItem, Outcome] => [item, index === 0 ? "incorrect" : "correct"]),
      ...g.optional.map((item, index): [AuditItem, Outcome] => [item, index === 0 ? "incorrect" : "correct"]),
    ]));
    expect(report.errorRate.mandatory).toMatchObject({ complete: true, judged: 50, rate: 0.02, pointEstimateWithin2Percent: true });
    expect(report.errorRate.mandatory.upper95!).toBeGreaterThan(0.02);
    expect(report.errorRate.optional).toMatchObject({ complete: true, judged: 49, rate: 1 / 49, pointEstimateWithin2Percent: false });
    const withUnjudgeable = createCourseAuditReview(big, reviewsFor(big,
      g.mandatory.map((item, index): [AuditItem, Outcome] => [item, index === 0 ? "unjudgeable" : "correct"])));
    expect(withUnjudgeable.errorRate.mandatory).toMatchObject({ complete: true, judged: 49, incorrect: 0, rate: 0,
      conservative: { errors: 1, denominator: 50, rate: 0.02 }, pointEstimateWithin2Percent: true });
  });

  it("carries the sampling frame size and sample size as denominators (zero errors in 149 of 160)", () => {
    const partial = sampleOf([{ n: 1, blocks: questions(1, 160) }], 149);
    expect(partial.counts).toMatchObject({ population: 160, sampled: 149 });
    const report = createCourseAuditReview(partial, reviewsFor(partial, partial.samples.map(item => [item, "correct"])));
    expect(report.errorRate.all).toMatchObject({ population: 160, sampleSize: 149, complete: true, judged: 149, incorrect: 0,
      rate: 0, pointEstimateWithin2Percent: true });
    expect(report.errorRate.mandatory).toMatchObject({ population: 160, sampleSize: 149 });
    expect(report.errorRate.optional).toMatchObject({ population: 0, sampleSize: 0, complete: true, judged: 0, pointEstimateWithin2Percent: null });
    expect(report.errorRate.all.upper95!).toBeCloseTo(0.0199, 4);
    expect(report.errorRate.all.upper95!).toBeLessThan(0.02);
  });
});
