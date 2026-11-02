import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import reviewModule from "../../scripts/study-course-audit-review.ts";
const { createCourseAuditReview, courseAuditReviewIdentity, runCourseAuditReview } = reviewModule;

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const privateText = "PRIVATE-QUESTION-ANSWER-NOTE";
function fixture() {
  const requirements = [1, 2, 3].map(n => ({
    requirement: { id: id(n), courseId: id(90), revision: 2, stableSkillId: id(n + 10), knowledgeNodeId: null,
      requirementKey: `r${n}`, title: `Requirement ${n}`, position: n, mandatory: n !== 2, goalIds: [], prerequisiteIds: [], sourceRefs: [],
      verification: { kind: "manual", status: "needs_check", exerciseKeys: [], rubric: null, missingReasons: [] }, origin: "confirmed", lifecycle: "active", approvedAt: null },
    compilation: { activityId: id(n + 20), generateStatus: "ready", contentVersion: 3, saved: true,
      documentId: id(n + 30), revisionNumber: 2, verificationStatus: "needs_check" },
    status: "needs_correction", observationId: null, missingReasons: [], sourcesAvailable: n !== 3,
  }));
  return { snapshot: { courseId: id(90), scopeState: "confirmed", requirements, suggestions: [],
    summary: { total: 3, mandatory: 2, verified: 0, blocked: 0 }, materials: [], currentActivity: null, currentRoute: null, observationId: null },
  artifacts: [1, 2].map(n => {
    const blocks = Array.from({ length: 6 }, (_, i) => ({ id: id(n * 100 + i), type: i % 2 ? "solution" : "question",
      position: i, content: { text: privateText } }));
    return { spec: { id: id(n + 50), activityId: id(n + 20), teachingUnitId: id(n + 40), documentId: id(n + 30), revisionNumber: 2,
      blockOrder: blocks.map(block => ({ blockId: block.id, position: block.position, blockType: block.type, role: block.position % 2 ? "answer_key" : "prompt" })),
      sourceRefs: [{ sourceId: id(80), version: 2 }], goals: [], verificationStatus: "needs_check", generationConfig: {}, version: 3,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    revision: { documentId: id(n + 30), revisionNumber: 2, blocks } };
  }) };
}
const dir = mkdtempSync(join(tmpdir(), "course-audit-review-"));
const input = join(dir, "input.json"), samplePath = join(dir, "sample.json"), reviewsPath = join(dir, "reviews.json"), output = join(dir, "output.json");
writeFileSync(input, JSON.stringify(fixture()), { mode: 0o600 });
const sampler = spawnSync(process.execPath, ["--import", "tsx", "scripts/study-course-audit-sample.ts", "--input", input, "--sample-size", "5", "--output", samplePath], { encoding: "utf8", timeout: 60000 });
assert.equal(sampler.status, 0, sampler.stderr);
const originalSample = readFileSync(samplePath);
const sample = JSON.parse(originalSample);
// Pick by group after random selection: 5 of 6 guarantees >=2 mandatory and >=2 optional.
const mandatory = sample.samples.filter(item => item.requirement.mandatory);
const optional = sample.samples.filter(item => !item.requirement.mandatory);
const records = [[mandatory[0], "correct"], [mandatory[1], "incorrect"], [optional[0], "unjudgeable"]];
const reviews = { courseId: sample.courseId, results: records.map(([item, outcome]) => ({ identity: courseAuditReviewIdentity(item), outcome, note: privateText })) };
writeFileSync(reviewsPath, JSON.stringify(reviews), { mode: 0o600 });
const originalReviews = readFileSync(reviewsPath);
const args = ["--sample", samplePath, "--reviews", reviewsPath, "--output", output];
const invoke = options => spawnSync(process.execPath, ["--import", "tsx", "scripts/study-course-audit-review.ts", ...options], { encoding: "utf8", timeout: 60000 });

test("real sampler -> real review CLI retains full identities, gaps and literal review denominators", () => {
  const result = invoke(args);
  assert.equal(result.status, 0, result.stderr);
  console.log(`Real review CLI: ${result.stdout.trim()}`);
  assert.doesNotMatch(result.stdout + result.stderr + sampler.stdout + sampler.stderr, /PRIVATE|ZodError/);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.deepEqual(report.counts, { requirements: 3, mandatory: 2, optional: 1, population: 6, sampled: 5 });
  assert.deepEqual(report.reviewCounts.all, { total: 5, reviewed: 3, pending: 2, correct: 1, incorrect: 1, unjudgeable: 1 });
  assert.deepEqual(report.reviewCounts.mandatory, { total: mandatory.length, reviewed: 2, pending: mandatory.length - 2, correct: 1, incorrect: 1, unjudgeable: 0 });
  assert.deepEqual(report.reviewCounts.optional, { total: optional.length, reviewed: 1, pending: optional.length - 1, correct: 0, incorrect: 0, unjudgeable: 1 });
  assert.deepEqual(report.samples.map(courseAuditReviewIdentity), sample.samples.map(courseAuditReviewIdentity));
  assert.deepEqual(report.requirements, sample.requirements);
  assert.deepEqual(report.samplingFrame, sample.samplingFrame);
  assert.deepEqual(report.mandatory, { requirements: 2, eligible: 3, requirementsWithGaps: 1 });
  assert.deepEqual(report.optional, { requirements: 1, eligible: 3, requirementsWithGaps: 0 });
  assert.deepEqual(report.requirements[2].gaps, [{ reason: "source_unavailable" }, { reason: "missing_artifact" }]);
  for (const item of report.samples) {
    const record = reviews.results.find(row => row.identity.questionBlockId === item.questionBlockId);
    assert.equal(item.outcome, record?.outcome ?? "pending");
    assert.equal(item.reviewStatus, record?.outcome ?? "pending");
    assert.equal(item.note, record ? privateText : undefined);
    assert.equal(item.prompt, privateText);
    assert.equal(item.referenceAnswer, privateText);
    assert.deepEqual(item.sourceRefs, [{ sourceId: id(80), version: 2 }]);
  }
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.match(report.notice, /人工输入汇总，不证明审查独立性、整课通过、发布资格/);
  assert.equal(report.verified, undefined);
  assert.equal(report.releaseReady, undefined);
  assert.deepEqual(readFileSync(samplePath), originalSample);
  assert.deepEqual(readFileSync(reviewsPath), originalReviews);
});

test("strict review identity rejects stale, foreign, duplicate, out-of-sample and authority claims", () => {
  const mutations = [
    r => { r.courseId = id(999); },
    r => { r.results.push(structuredClone(r.results[0])); },
    r => { r.results[0].outcome = "verified"; },
    r => { r.results[0].verified = true; },
    r => { r.releaseReady = true; },
    r => { delete r.results[0].identity.answerBlockId; },
    r => { r.results[0].identity.extra = true; },
    r => { r.results[0].identity = courseAuditReviewIdentity(sample.samplingFrame.find(item => !sample.samples.some(selected => selected.questionBlockId === item.questionBlockId))); },
  ];
  for (const field of ["courseId", "activityId", "specId", "teachingUnitId", "documentId", "questionBlockId", "answerBlockId"]) mutations.push(r => { r.results[0].identity[field] = id(999); });
  for (const field of ["contentVersion", "revisionNumber"]) mutations.push(r => { r.results[0].identity[field] = 1; });
  for (const field of ["id", "courseId", "stableSkillId"]) mutations.push(r => { r.results[0].identity.requirement[field] = id(999); });
  mutations.push(r => { r.results[0].identity.requirement.revision = 1; }, r => { r.results[0].identity.requirement.requirementKey = "old"; },
    r => { r.results[0].identity.requirement.requirementKey = ` ${r.results[0].identity.requirement.requirementKey} `; });
  for (const mutate of mutations) {
    const data = structuredClone(reviews); mutate(data);
    assert.throws(() => createCourseAuditReview(sample, data));
  }
  const reordered = structuredClone(reviews);
  reordered.results[0].identity = Object.fromEntries(Object.entries(reordered.results[0].identity).reverse());
  assert.deepEqual(createCourseAuditReview(sample, reordered).reviewCounts.all, { total: 5, reviewed: 3, pending: 2, correct: 1, incorrect: 1, unjudgeable: 1 });
  assert.deepEqual(createCourseAuditReview(sample, { courseId: sample.courseId, results: [] }).reviewCounts.all,
    { total: 5, reviewed: 0, pending: 5, correct: 0, incorrect: 0, unjudgeable: 0 });
});

test("validates sampler counts, complete manifest, frame and exact selected bindings", () => {
  const mutations = [
    s => { s.format = "old"; }, s => { s.counts.sampled = 4; }, s => { s.counts.population = 7; },
    s => { s.requirements.pop(); }, s => { s.requirements[0].eligible++; },
    s => { s.mandatory.requirementsWithGaps = 0; }, s => { s.optional.eligible = 0; },
    s => { s.requirements[0].requirement.courseId = id(999); },
    s => { s.requirements[0].compilation.contentVersion = 1; },
    s => { s.samplingFrame.push(structuredClone(s.samplingFrame[0])); s.counts.population++; },
    s => { s.samplingFrame[0].requirement.revision = 1; },
    s => { s.samplingFrame[0].specId = id(999); },
    s => { s.samplingFrame[0].answerBlockId = s.samplingFrame[0].questionBlockId; },
    s => { s.samplingFrame[0].courseId = id(999); },
    s => { s.samples[0].contentVersion = 1; },
    s => { s.samples[0].answerBlockId = id(999); },
    s => { s.samples.push(s.samples[0]); s.counts.sampled++; },
    s => { s.samples[0].reviewStatus = "correct"; },
    s => { s.samples[0].questionBlockId = id(999); },
    s => { s.verified = true; }, s => { s.samples[0].requirement.verification.status = "bogus"; },
  ];
  for (const mutate of mutations) {
    const data = structuredClone(sample); mutate(data);
    assert.throws(() => createCourseAuditReview(data, reviews));
  }
});

test("wx filesystem boundaries preserve existing output and both inputs", async () => {
  const bytes = readFileSync(output);
  const result = invoke(args);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE|ZodError/);
  assert.deepEqual(readFileSync(output), bytes);
  for (const target of [samplePath, reviewsPath]) {
    await assert.rejects(runCourseAuditReview(["--sample", samplePath, "--reviews", reviewsPath, "--output", target]));
  }
  assert.deepEqual(readFileSync(samplePath), originalSample);
  assert.deepEqual(readFileSync(reviewsPath), originalReviews);
});

test("real CLI rejects malformed sensitive input without output or console disclosure", () => {
  const bad = join(dir, "bad.json"), target = join(dir, "must-not-exist.json");
  writeFileSync(bad, JSON.stringify({ ...reviews, results: [{ identity: privateText, outcome: privateText, note: privateText }] }));
  const result = invoke(["--sample", samplePath, "--reviews", bad, "--output", target]);
  assert.equal(result.status, 1);
  assert.equal(existsSync(target), false);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE|ZodError/);
});

test("help documents precise identities, pending denominator and local-only operation", () => {
  const help = invoke(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--sample FILE --reviews FILE --output NEW_FILE/);
  assert.match(help.stdout, /reviewed = correct \+ incorrect \+ unjudgeable/);
  assert.match(help.stdout, /0600/);
});
