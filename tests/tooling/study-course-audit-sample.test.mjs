import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  const requirements = [1, 2, 3, 4].map(n => ({
    requirement: { id: id(n), courseId: id(90), revision: 2, stableSkillId: id(n + 10), knowledgeNodeId: null,
      requirementKey: `r${n}`, title: `Requirement ${n}`, position: n, mandatory: n !== 4, goalIds: [], prerequisiteIds: [], sourceRefs: [],
      verification: { kind: "manual", status: "needs_check", exerciseKeys: [], rubric: null, missingReasons: [] }, origin: "confirmed", lifecycle: "active", approvedAt: null },
    compilation: { activityId: id(n + 20), generateStatus: "ready", contentVersion: 3, saved: n !== 3,
      documentId: id(n + 30), revisionNumber: 2, verificationStatus: "needs_check" },
    referenceChecks: { matched: 0, mismatched: 1, unsupported: 1 }, status: "needs_correction", observationId: null, missingReasons: [], sourcesAvailable: true,
  }));
  const spec = { id: id(50), activityId: id(21), teachingUnitId: id(51), documentId: id(31), revisionNumber: 2,
    blockOrder: [60, 61, 62, 63, 64, 65].map((n, i) => ({ blockId: id(n), position: i, blockType: i % 2 ? "solution" : "question", role: i % 2 ? "answer_key" : "prompt" })),
    sourceRefs: [{ sourceId: id(80), version: 2 }], goals: [], verificationStatus: "needs_check", generationConfig: {}, version: 3,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  return { snapshot: { courseId: id(90), scopeState: "confirmed", requirements, suggestions: [],
    summary: { total: 4, mandatory: 3, verified: 0, blocked: 0 }, materials: [], currentActivity: null, currentRoute: null, observationId: null },
  artifacts: [{ spec, revision: { documentId: id(31), revisionNumber: 2, blocks: [
    { id: id(60), type: "question", position: 0, content: { text: "PRIVATE 1+1?", interaction: { kind: "numeric", unit: "米" } } },
    { id: id(61), type: "solution", position: 1, content: { text: "9" } },
    { id: id(62), type: "question", position: 2, content: { question: "PRIVATE explain why" } },
    { id: id(63), type: "solution", position: 3, content: { solution: "Unsupported reference" } },
    { id: id(64), type: "question", position: 4, content: { text: "PRIVATE no answer" } },
    { id: id(65), type: "solution", position: 5, content: { text: " " } },
    { id: id(66), type: "question", position: 6, content: { text: "OLD removed question" } },
  ] } }] };
}
function run(data = fixture(), size = "2", extra = []) {
  const dir = mkdtempSync(join(tmpdir(), "course-audit-test-"));
  const input = join(dir, "input.json"), output = join(dir, "output.json");
  writeFileSync(input, JSON.stringify(data), { mode: 0o600 });
  const args = ["--input", input, "--sample-size", size, "--output", output, ...extra];
  const invoke = (options = args) => spawnSync(process.execPath, ["--import", "tsx", "scripts/study-course-audit-sample.ts", ...options], { encoding: "utf8", timeout: 15000 });
  return { ...invoke(), input, output, invoke };
}

test("real CLI retains complete denominator, current version and all reference-bearing questions", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  console.log(`CLI stdout: ${result.stdout.trim()}`);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE|Unsupported reference/);
  const report = JSON.parse(readFileSync(result.output, "utf8"));
  assert.deepEqual(report.counts, { requirements: 4, mandatory: 3, optional: 1, population: 2, sampled: 2 });
  assert.equal(report.requirements.length, 4);
  assert.deepEqual(report.requirements.map(r => r.eligible), [2, 0, 0, 0]);
  assert.deepEqual(report.requirements.map(r => r.gaps.map(g => g.reason)), [["missing_reference_answer"], ["missing_artifact"], ["unsaved_compilation"], ["missing_artifact"]]);
  assert.deepEqual(report.samples.map(s => s.questionBlockId).sort(), [id(60), id(62)]);
  assert.equal(new Set(report.samples.map(s => s.questionBlockId)).size, 2);
  for (const sample of report.samples) {
    assert.equal(sample.reviewStatus, "pending");
    assert.equal(sample.contentVersion, 3);
    assert.equal(sample.revisionNumber, 2);
    assert.equal(sample.requirement.revision, 2);
    assert.equal(sample.documentId, id(31));
    assert.deepEqual(sample.sourceRefs, [{ sourceId: id(80), version: 2 }]);
  }
  assert.equal(report.samples.find(s => s.questionBlockId === id(60)).referenceAnswer, "9");
  assert.match(report.samples.find(s => s.questionBlockId === id(60)).prompt, /单位：米/);
  assert.equal(statSync(result.output).mode & 0o777, 0o600);
  const bytes = readFileSync(result.output);
  assert.equal(result.invoke().status, 1);
  assert.deepEqual(readFileSync(result.output), bytes);
  const inputBytes = readFileSync(result.input);
  assert.equal(result.invoke(["--input", result.input, "--sample-size", "1", "--output", result.input]).status, 1);
  assert.deepEqual(readFileSync(result.input), inputBytes);
});

test("sample subset remains without replacement", () => {
  const result = run(fixture(), "1");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(result.output, "utf8"));
  assert.equal(report.samples.length, 1);
  assert.ok([id(60), id(62)].includes(report.samples[0].questionBlockId));
  assert.equal(report.samplingFrame.length, 2);
});

test("reject invalid size before output", () => {
  for (const size of ["0", "-1", "1.5", "NaN", "9007199254740992", "3"]) {
    const result = run(fixture(), size);
    assert.equal(result.status, 1);
    assert.equal(existsSync(result.output), false);
    assert.doesNotMatch(result.stderr, /PRIVATE/);
  }
});

test("reject stale or foreign identities, malformed schemas and ambiguous bindings", () => {
  const mutations = [
    d => { d.artifacts[0].spec.version = 2; },
    d => { d.artifacts[0].spec.revisionNumber = 1; },
    d => { d.artifacts[0].revision.documentId = id(99); },
    d => { d.artifacts[0].spec.activityId = id(99); },
    d => { d.snapshot.requirements[0].requirement.courseId = id(99); },
    d => { d.snapshot.requirements.push(d.snapshot.requirements[0]); },
    d => { d.artifacts.push(d.artifacts[0]); },
    d => { d.artifacts[0].spec.blockOrder[1].blockId = id(60); },
    d => { d.artifacts[0].revision.blocks[0].type = "text"; },
    d => { d.artifacts[0].spec.unexpected = "PRIVATE"; },
    d => { d.snapshot.summary.total = 3; },
  ];
  for (const mutate of mutations) {
    const data = fixture(); mutate(data);
    const result = run(data);
    assert.equal(result.status, 1);
    assert.equal(existsSync(result.output), false);
    assert.doesNotMatch(result.stderr, /PRIVATE|ZodError/);
  }
});

test("unavailable source remains a requirement gap, never a sampled question", () => {
  const data = fixture();
  data.snapshot.requirements[0].sourcesAvailable = false;
  const available = structuredClone(data.artifacts[0]);
  available.spec.activityId = id(22);
  available.spec.documentId = id(32);
  available.revision.documentId = id(32);
  data.artifacts.push(available);
  const result = run(data, "2");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(result.output, "utf8"));
  assert.equal(report.requirements.length, 4);
  assert.deepEqual(report.requirements[0].gaps, [{ reason: "source_unavailable" }]);
  assert.equal(report.requirements[0].eligible, 0);
  assert.deepEqual(report.samples.map(s => s.activityId), [id(22), id(22)]);
  assert.deepEqual(report.mandatory, { requirements: 3, eligible: 2, requirementsWithGaps: 3 });
  assert.deepEqual(report.optional, { requirements: 1, eligible: 0, requirementsWithGaps: 1 });
});

test("help explains explicit local-only input and pending human review", () => {
  const result = run();
  const help = result.invoke(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--input FILE --sample-size N --output NEW_FILE/);
  assert.match(help.stdout, /pending/);
});
