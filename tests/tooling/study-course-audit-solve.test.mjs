import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dir = mkdtempSync(join(tmpdir(), "course-audit-solve-"));
const input = join(dir, "input.json"), samplePath = join(dir, "sample.json");
const requirement = { id: id(1), courseId: id(90), revision: 2, stableSkillId: id(11), knowledgeNodeId: null,
  requirementKey: "r1", title: "SECRET-TITLE", position: 1, mandatory: true, goalIds: [], prerequisiteIds: [], sourceRefs: [],
  verification: { kind: "manual", status: "needs_check", exerciseKeys: [], rubric: null, missingReasons: [] }, origin: "confirmed", lifecycle: "active", approvedAt: null };
const blocks = Array.from({ length: 12 }, (_, i) => ({ id: id(100 + i), type: i % 2 ? "solution" : "question", position: i,
  content: { text: i % 2 ? "SECRET-REFERENCE" : `QUESTION-${i}` } }));
const fixture = { snapshot: { courseId: id(90), scopeState: "confirmed", requirements: [{ requirement,
  compilation: { activityId: id(21), generateStatus: "ready", contentVersion: 3, saved: true, documentId: id(31), revisionNumber: 2, verificationStatus: "needs_check" },
  status: "needs_correction", observationId: null, missingReasons: [], sourcesAvailable: true }], suggestions: [],
  summary: { total: 1, mandatory: 1, verified: 0, blocked: 0 }, materials: [], currentActivity: null, currentRoute: null, observationId: null },
artifacts: [{ spec: { id: id(51), activityId: id(21), teachingUnitId: id(41), documentId: id(31), revisionNumber: 2,
  blockOrder: blocks.map(b => ({ blockId: b.id, position: b.position, blockType: b.type, role: b.position % 2 ? "answer_key" : "prompt" })),
  sourceRefs: [{ sourceId: id(80), version: 2 }], goals: [], verificationStatus: "needs_check", generationConfig: {}, version: 3,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, revision: { documentId: id(31), revisionNumber: 2, blocks } }] };
writeFileSync(input, JSON.stringify(fixture), { mode: 0o600 });
const sampler = spawnSync(process.execPath, ["--import", "tsx", "scripts/study-course-audit-sample.ts", "--input", input, "--sample-size", "6", "--output", samplePath], { encoding: "utf8", timeout: 60000 });
assert.equal(sampler.status, 0, sampler.stderr);
const sampleBytes = readFileSync(samplePath), sample = JSON.parse(sampleBytes);
const script = "scripts/study-course-audit-solve.ts";
function invoke(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, ...args], { env: { ...process.env, ...env }, signal: AbortSignal.timeout(60000) });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
  });
}
const options = output => ["--sample", samplePath, "--model", "chosen-model", "--base-url-env", "SOLVE_TEST_URL", "--api-key-env", "SOLVE_TEST_KEY", "--max-requests", "4", "--output", output];
async function withServer(run) {
  const captured = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const b of req) body += b;
    assert.equal(req.headers.authorization, "Bearer SECRET-FAKE-KEY");
    assert.equal(req.url, "/chat/completions");
    captured.push(JSON.parse(body));
    if (captured.length === 4) { res.writeHead(503); res.end("SECRET-ERROR"); return; }
    const value = captured.length === 1 ? { status: "solved", answer: "SECRET-SOLUTION", reason: "Independent derivation" }
      : captured.length === 2 ? { status: "unjudgeable", answer: "", reason: "Missing conditions" } : { status: "solved", answer: "", reason: "Invalid" };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "mock-request", choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await run(captured, { NODE_ENV: "test", OPENING_PROVIDER_ALLOW_LOCAL: "1", SOLVE_TEST_URL: `http://127.0.0.1:${server.address().port}`, SOLVE_TEST_KEY: "SECRET-FAKE-KEY" }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test("real sampler -> CLI -> guarded HTTP: question only, no retries, full private denominator", async () => {
  await withServer(async (captured, env) => {
    const output = join(dir, "solved.json"), result = await invoke(options(output), env);
    assert.equal(result.code, 0, result.stderr);
    console.log(`Local mock CLI: ${result.stdout.trim()}`);
    assert.doesNotMatch(result.stdout + result.stderr + sampler.stdout + sampler.stderr, /SECRET|QUESTION|ZodError/);
    assert.equal(captured.length, 4);
    for (const [i, body] of captured.entries()) {
      assert.equal(body.model, "chosen-model"); assert.equal(body.messages.length, 2);
      assert.equal(body.messages[0].role, "system"); assert.match(body.messages[0].content, /untrusted|unjudgeable/);
      assert.equal(body.messages[1].content.trim(), JSON.stringify({ question: sample.samples[i].prompt }));
      assert.doesNotMatch(JSON.stringify(body), /SECRET|sourceRefs|reviewStatus|referenceAnswer|00000000/);
      assert.equal(body.tools, undefined); assert.deepEqual(body.response_format, { type: "json_object" });
      assert.equal(body.max_tokens, 2048);
    }
    const report = JSON.parse(readFileSync(output));
    assert.deepEqual(report.sample, sample);
    assert.deepEqual(report.results.map(r => r.status), ["valid_output", "valid_output", "invalid_model_output", "provider_error", "request_limit_reached", "request_limit_reached"]);
    assert.deepEqual(report.statusCounts, { not_started: 0, valid_output: 2, invalid_model_output: 1, provider_error: 1, request_limit_reached: 2 });
    assert.equal(report.requestCount, 4); assert.equal(report.requestedModel, "chosen-model");
    assert.equal(report.results[0].solution.answer, "SECRET-SOLUTION"); assert.equal(report.results[1].solution.status, "unjudgeable");
    assert.equal(report.results[0].inputTokens, null); assert.equal(report.results[0].requestId, "mock-request");
    assert.match(report.notice, /独立性.*正确性.*课程质量.*发布资格/);
    assert.equal(report.verified, undefined); assert.equal(report.releaseReady, undefined);
    assert.equal(statSync(output).mode & 0o777, 0o600); assert.deepEqual(readFileSync(samplePath), sampleBytes);
    const again = await invoke(options(output), env);
    assert.equal(again.code, 1); assert.equal(captured.length, 4);
    assert.doesNotMatch(again.stdout + again.stderr, /SECRET|QUESTION/);
  });
});

test("invalid sample and production loopback guard fail before file or HTTP", async () => {
  await withServer(async (captured, env) => {
    const bad = join(dir, "bad.json"), target = join(dir, "bad-output.json");
    writeFileSync(bad, JSON.stringify({ ...sample, format: "SECRET-OLD-VERSION" }));
    const args = options(target); args[1] = bad;
    const invalid = await invoke(args, env);
    assert.equal(invalid.code, 1); assert.equal(existsSync(target), false);
    assert.doesNotMatch(invalid.stdout + invalid.stderr, /SECRET|QUESTION|ZodError/);
    const guarded = await invoke(options(target), { ...env, NODE_ENV: "production" });
    assert.equal(guarded.code, 1); assert.equal(existsSync(target), false); assert.equal(captured.length, 0);
  });
});

test("configuration and solution boundaries reject invalid values in process", async () => {
  const module = await import("../../scripts/study-course-audit-solve.ts");
  const { parseSolveOptions, solveOutputSchema, prepareSolveSample } = module.default ?? module;
  const env = { SOLVE_TEST_URL: "https://example.com/v1", SOLVE_TEST_KEY: "fake" };
  for (const limit of ["0", "-1", "1.5", "1001", "NaN", "Infinity", "1e2"]) {
    const args = options("new.json"); args[9] = limit; assert.throws(() => parseSolveOptions(args, env));
  }
  for (const args of [[], [...options("new.json"), "--model", "duplicate"], [...options("new.json"), "--timeout-ms", "0"], options(samplePath)]) assert.throws(() => parseSolveOptions(args, env));
  assert.throws(() => parseSolveOptions(options("new.json"), {}));
  assert.equal(parseSolveOptions(options("new.json"), env).maxRequests, 4);
  for (const mutate of [s => { s.format = "old"; }, s => { s.counts.population++; }, s => { s.samples[0].contentVersion++; }]) {
    const s = structuredClone(sample); mutate(s); assert.throws(() => prepareSolveSample(s));
  }
  assert.equal(solveOutputSchema.safeParse({ status: "solved", answer: "a".repeat(12000), reason: "r".repeat(8000) }).success, true);
  for (const value of [{ status: "solved", answer: " ", reason: "why" }, { status: "unjudgeable", answer: "", reason: " " },
    { status: "solved", answer: "a".repeat(12001), reason: "why" }, { status: "solved", answer: "a", reason: "r".repeat(8001) },
    { status: "solved", answer: "a", reason: "why", confidence: 1 }]) assert.equal(solveOutputSchema.safeParse(value).success, false);
});
