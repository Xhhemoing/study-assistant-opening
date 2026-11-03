import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { require as tsxRequire } from "tsx/cjs/api";
const module = tsxRequire("../../scripts/study-course-audit-review.ts", import.meta.url);
const { createCourseAuditReview, courseAuditReviewIdentity, runCourseAuditReview } = module.default ?? module;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dir = mkdtempSync(join(tmpdir(), "solver-evidence-"));
const samplePath = join(dir, "sample.json"), solutionsPath = join(dir, "solutions.json"), reviewsPath = join(dir, "reviews.json");
const requirement = { id: id(1), courseId: id(90), revision: 2, stableSkillId: id(11), knowledgeNodeId: null,
  requirementKey: "r1", title: "SECRET-TITLE", position: 1, mandatory: true, goalIds: [], prerequisiteIds: [], sourceRefs: [],
  verification: { kind: "manual", status: "needs_check", exerciseKeys: [], rubric: null, missingReasons: [] }, origin: "confirmed", lifecycle: "active", approvedAt: null };
const cases = Array.from({ length: 12 }, (_, i) => {
  const kind = i % 6;
  return { kind, prompt: kind === 2 ? `Prove SECRET-${i}` : `calculate ${i}+1`, reference: kind === 1 ? "999" : kind === 2 ? "SECRET-PROOF" : String(i + 1),
    solution: kind === 2 ? { status: "unjudgeable", answer: "", reason: "SECRET-missing conditions" }
      : { status: "solved", answer: kind === 0 ? "999" : `${i + 1}/1`, reason: "SECRET-derivation" } };
});
const blocks = cases.flatMap((c, i) => ["question", "solution"].map((type, j) => ({ id: id(100 + 2 * i + j), type, position: 2 * i + j, content: { text: j ? c.reference : c.prompt } })));
const fixture = { snapshot: { courseId: id(90), scopeState: "confirmed", requirements: [{ requirement,
  compilation: { activityId: id(21), generateStatus: "ready", contentVersion: 3, saved: true, documentId: id(31), revisionNumber: 2, verificationStatus: "needs_check" },
  status: "needs_correction", observationId: null, missingReasons: [], sourcesAvailable: true }], suggestions: [], summary: { total: 1, mandatory: 1, verified: 0, blocked: 0 }, materials: [], currentActivity: null, currentRoute: null, observationId: null },
artifacts: [{ spec: { id: id(51), activityId: id(21), teachingUnitId: id(41), documentId: id(31), revisionNumber: 2,
  blockOrder: blocks.map(b => ({ blockId: b.id, position: b.position, blockType: b.type, role: b.position % 2 ? "answer_key" : "prompt" })), sourceRefs: [], goals: [], verificationStatus: "needs_check", generationConfig: {}, version: 3,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, revision: { documentId: id(31), revisionNumber: 2, blocks } }] };
const input = join(dir, "input.json");
writeFileSync(input, JSON.stringify(fixture));
const sampler = spawnSync(process.execPath, ["--import", "tsx", "scripts/study-course-audit-sample.ts", "--input", input, "--sample-size", "12", "--output", samplePath], { encoding: "utf8", timeout: 60000 });
assert.equal(sampler.status, 0, sampler.stderr);
const sample = JSON.parse(readFileSync(samplePath));
const reviews = { courseId: sample.courseId, results: sample.samples.slice(0, 3).map((s, i) => ({ identity: courseAuditReviewIdentity(s), outcome: ["incorrect", "correct", "unjudgeable"][i], note: "SECRET-NOTE" })) };
writeFileSync(reviewsPath, JSON.stringify(reviews));
const invoke = (script, args, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", `scripts/study-course-audit-${script}.ts`, ...args], { env: { ...process.env, ...env }, signal: AbortSignal.timeout(60000) });
  let stdout = "", stderr = "";
  child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
  child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
});
const args = output => ["--sample", samplePath, "--reviews", reviewsPath, "--output", output, "--solutions", solutionsPath];
let collection;
test("sampler -> HTTP solve -> review preserves literal human counts and adds finite arithmetic evidence", async () => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    const request = JSON.parse(body); requests++;
    assert.equal(req.headers.authorization, "Bearer SECRET-FAKE");
    const c = cases.find(c => c.prompt === JSON.parse(request.messages[1].content).question);
    if (c.kind === 4) { res.writeHead(503); res.end("SECRET-ERROR"); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "mock", choices: [{ message: { content: JSON.stringify(c.kind === 3 ? { ...c.solution, verified: true } : c.solution) }, finish_reason: "stop" }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let solved;
  try {
    solved = await invoke("solve", ["--sample", samplePath, "--model", "mock-only", "--base-url-env", "EVIDENCE_URL", "--api-key-env", "EVIDENCE_KEY", "--max-requests", "11", "--output", solutionsPath],
      { NODE_ENV: "test", OPENING_PROVIDER_ALLOW_LOCAL: "1", EVIDENCE_URL: `http://127.0.0.1:${server.address().port}`, EVIDENCE_KEY: "SECRET-FAKE" });
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal(solved.code, 0, solved.stderr); assert.equal(requests, 11);
  collection = JSON.parse(readFileSync(solutionsPath));
  const bytes = [samplePath, reviewsPath, solutionsPath].map(p => readFileSync(p));
  const output = join(dir, "report.json"), result = await invoke("review", args(output));
  assert.equal(result.code, 0, result.stderr);
  console.log(`Solve: ${solved.stdout.trim()}\nReview: ${result.stdout.trim()}`);
  assert.doesNotMatch(sampler.stdout + sampler.stderr + solved.stdout + solved.stderr + result.stdout + result.stderr, /SECRET|ZodError/);
  const report = JSON.parse(readFileSync(output));
  const withoutEvidence = createCourseAuditReview(sample, reviews);
  assert.deepEqual(report.samples.map(({ solverEvidence: _evidence, ...item }) => item), withoutEvidence.samples);
  assert.deepEqual(report.counts, { requirements: 1, mandatory: 1, optional: 0, population: 12, sampled: 12 });
  assert.deepEqual(report.reviewCounts.all, { total: 12, reviewed: 3, pending: 9, correct: 1, incorrect: 1, unjudgeable: 1 });
  assert.deepEqual(report.samples.map(s => s.outcome), ["incorrect", "correct", "unjudgeable", ...Array(9).fill("pending")]);
  assert.deepEqual(report.samples.map(s => s.reviewStatus), ["incorrect", "correct", "unjudgeable", ...Array(9).fill("pending")]);
  assert.deepEqual(report.requirements, sample.requirements); assert.deepEqual(report.samplingFrame, sample.samplingFrame);
  assert.deepEqual(report.mandatory, sample.mandatory); assert.deepEqual(report.optional, sample.optional);
  for (const [i, s] of report.samples.entries()) {
    const c = cases.find(c => c.prompt === s.prompt), record = collection.results[i];
    assert.equal(s.note, i < 3 ? "SECRET-NOTE" : undefined);
    assert.deepEqual(s.solverEvidence.result, record);
    assert.equal(s.solverEvidence.referenceArithmetic, c.kind === 1 ? "incorrect" : c.kind === 2 ? "unsupported" : "correct");
    assert.equal(s.solverEvidence.solverArithmetic, record.status !== "valid_output" || c.kind === 2 ? "unknown" : c.kind === 0 ? "incorrect" : "correct");
  }
  for (const kind of [0, 1, 2, 3, 4, 5]) assert.ok(report.samples.slice(0, 11).some(s => cases.find(c => c.prompt === s.prompt).kind === kind));
  assert.equal(statSync(output).mode & 0o777, 0o600);
  await assert.rejects(runCourseAuditReview(args(solutionsPath)));
  for (const [i, p] of [samplePath, reviewsPath, solutionsPath].entries()) assert.deepEqual(readFileSync(p), bytes[i]);
  const bad = join(dir, "bad.json"), target = join(dir, "absent.json");
  writeFileSync(bad, '{"SECRET":');
  const badArgs = args(target); badArgs[7] = bad;
  const failed = await invoke("review", badArgs);
  assert.equal(failed.code, 1); assert.equal(existsSync(target), false); assert.doesNotMatch(failed.stdout + failed.stderr, /SECRET|ZodError/);
  writeFileSync(bad, JSON.stringify({ ...collection, requestCount: 0 }));
  await assert.rejects(runCourseAuditReview(badArgs));
  assert.equal(existsSync(target), false);
});

test("exact collection boundary rejects stale bindings, forged counts and status authority", () => {
  assert.ok(collection);
  const valid = collection.results.findIndex(r => r.status === "valid_output");
  const invalid = collection.results.findIndex(r => r.status === "invalid_model_output");
  const mutations = [
    c => { c.format = "old"; }, c => { c.instructionVersion = "v0"; }, c => { c.verified = true; },
    c => { c.sample.courseId = id(999); }, c => { c.sample.samples.reverse(); }, c => { c.sample.samples[0].prompt += " replaced"; },
    c => { c.sample.samples[0].referenceAnswer += " replaced"; }, c => { c.sample.samples[0].contentVersion++; },
    c => { c.sample.samplingFrame.reverse(); }, c => { c.sample.requirements[0].requirement.title += " changed"; },
    c => { c.sample.samples[0].requirement.requirementKey = " r1 "; },
    c => { c.results.pop(); }, c => { c.results.push(c.results[0]); }, c => { c.statusCounts.valid_output++; },
    c => { c.requestCount--; }, c => { c.maxRequests = 0; }, c => { c.maxRequests = 1001; }, c => { c.maxRequests = 12; },
    c => { c.results[valid].solution.verified = true; }, c => { c.results[valid].solution.status = "verified"; },
    c => { c.results[invalid].solution = c.results[valid].solution; }, c => { c.results[11].solution = c.results[valid].solution; },
    c => { c.results[valid].status = "provider_error"; }, c => { c.results[valid].inputTokens = -1; },
    c => { delete c.results[valid].requestId; },
  ];
  for (const mutate of mutations) { const c = structuredClone(collection); mutate(c); assert.throws(() => createCourseAuditReview(sample, reviews, c)); }
  const pending = structuredClone(collection);
  pending.results = pending.results.map((r, i) => i < 11 ? { status: "not_started" } : r);
  pending.requestCount = 0;
  pending.statusCounts = { not_started: 11, valid_output: 0, invalid_model_output: 0, provider_error: 0, request_limit_reached: 1 };
  const report = createCourseAuditReview(sample, reviews, pending);
  assert.equal(report.samples[0].solverEvidence.solverArithmetic, "unknown");
  assert.deepEqual(report.reviewCounts.all, { total: 12, reviewed: 3, pending: 9, correct: 1, incorrect: 1, unjudgeable: 1 });
  const bothWrong = structuredClone(collection), wrongSample = structuredClone(sample);
  wrongSample.samples[valid].prompt = "1+1"; wrongSample.samples[valid].referenceAnswer = "3";
  bothWrong.sample = wrongSample; bothWrong.results[valid].solution = { status: "solved", answer: "4", reason: "local" };
  const wrongEvidence = createCourseAuditReview(wrongSample, reviews, bothWrong).samples[valid].solverEvidence;
  assert.equal(wrongEvidence.referenceArithmetic, "incorrect"); assert.equal(wrongEvidence.solverArithmetic, "incorrect");
  const max = structuredClone(collection);
  max.results[valid].solution = { status: "solved", answer: "a".repeat(12000), reason: "r".repeat(8000) };
  assert.equal(createCourseAuditReview(sample, reviews, max).samples[valid].solverEvidence.solverArithmetic, "unsupported");
  max.results[valid].solution.answer += "a";
  assert.throws(() => createCourseAuditReview(sample, reviews, max));
  for (const [prompt, answer] of [["1/0", "0"], ["1+1", "2 cm"], ["Choose 1+1: A/B", "A"], ["Prove x=x", "x=x"]]) {
    const s = structuredClone(sample), c = structuredClone(collection);
    s.samples[valid].prompt = prompt; s.samples[valid].referenceAnswer = answer; c.sample = s;
    c.results[valid].solution = { status: "solved", answer, reason: "local" };
    const evidence = createCourseAuditReview(s, reviews, c).samples[valid].solverEvidence;
    assert.equal(evidence.referenceArithmetic, "unsupported"); assert.equal(evidence.solverArithmetic, "unsupported");
  }
});
