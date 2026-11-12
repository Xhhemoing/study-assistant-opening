import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import * as contracts from "@aistudy/contracts";
import * as adapter from "./material-course-package-adapter";
import { describe, expect, it } from "vitest";
import { assessMaterialCoursePackageReadiness as assess } from "./material-course-package-readiness";
import { asOf, different, exactHost, expectedRequests, fixture, leaves, purposes, readPrivatePackage, replaceAt, uuid, type Fixture, type Purpose } from "./material-readiness-host-contract-independent.fixture";

type Report = ReturnType<typeof assess>;

// Execute the complete actual module, changing only the requested defect. Dependencies
// are real imported modules, not a hand-written stand-in assessor. No source files edited.
function loadActualModule(mutant: "control" | "bypass-host" | "force-scope") {
  const source = readFileSync(new URL("./material-course-package-readiness.ts", import.meta.url), "utf8");
  const anchor = "return authority.verifyBinding({ ...request, candidate, scope, asOf: authorityTime.data }) === true;";
  if (source.split(anchor).length !== 2) throw new Error("Actual-module mutation anchor is not unique");
  const replacement = mutant === "bypass-host" ? "return true;" : mutant === "force-scope"
    ? `return authority.verifyBinding({ ...request, candidate, scope: ${JSON.stringify(fixture().bindings.scope)}, asOf: authorityTime.data }) === true;`
    : anchor;
  const text = source.replace(anchor, replacement);
  const output = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const compiled = { exports: {} as { assessMaterialCoursePackageReadiness: typeof assess } };
  const requireDependency = (id: string) => {
    if (id === "zod") return { z };
    if (id === "@aistudy/contracts") return contracts;
    if (id === "./material-course-package-adapter") return adapter;
    throw new Error(`Unexpected actual-module dependency: ${id}`);
  };
  const execute = runInThisContext(`(function(exports, require, module) { ${output.outputText}\n})`, { filename: `readiness-${mutant}.cjs` });
  execute(compiled.exports, requireDependency, compiled);
  return { assess: compiled.exports.assessMaterialCoursePackageReadiness, sha256: createHash("sha256").update(text).digest("hex") };
}

function capability(r: Report, purpose: Purpose, questionId = "host-q-0") {
  if (purpose === "route_submission") return r.routeSubmission;
  if (purpose === "plan_submission") return r.planSubmission;
  const q = r.questions.find(q => q.questionId === questionId)!;
  return purpose === "scoring" ? q.scoring : q.diagnostic;
}
function closed(r: Report) {
  expect(r.routeSubmission.status).toBe("not_ready");
  expect(r.planSubmission.status).toBe("not_ready");
  expect(r.import.status).toBe("not_ready");
  expect(r.questions.every(q => q.diagnostic.status === "not_ready" && q.scoring.status === "not_ready" && q.bkt.status === "not_ready")).toBe(true);
  expect(Object.values(r.permissions)).toEqual([false, false, false, false]);
}
function matched(f: Fixture) {
  const host = exactHost(expectedRequests(f));
  const r = assess(f.candidate, f.bindings, host.authority);
  expect(host.calls).toEqual(expectedRequests(f));
  for (const p of purposes) expect(capability(r, p).status).toBe("ready");
  return r;
}

// New tests call the actual exported module. The independent host oracle intentionally
// models trusted DI only; UUIDs/receipts and a passing oracle never certify a producer.
describe("card1: complete actual-module host request contract", () => {
  it("forwards EVERY candidate/scope/purpose/time/question/payload leaf and detaches caller records", () => {
    const f = fixture(), records = expectedRequests(f), host = exactHost(records);
    const r = assess(f.candidate, f.bindings, host.authority);
    expect(host.calls).toHaveLength(6);
    for (const [i, record] of records.entries()) {
      const actual = host.calls[i]!;
      expect(actual).toEqual(record);
      for (const leaf of leaves(record)) {
        let observed: unknown = actual;
        for (const k of leaf.path) observed = Reflect.get(observed as object, k);
        expect(observed, `${record.purpose}:${leaf.path.join(".")}`).toEqual(leaf.value);
      }
      expect(actual.candidate).not.toBe(f.candidate);
      expect(actual.scope).not.toBe(f.bindings.scope);
    }
    for (const p of purposes) expect(capability(r, p).status).toBe("ready");
    expect(r.import.status).toBe("not_ready");
    expect(Object.values(r.permissions)).toEqual([false, false, false, false]);
  });

  describe.each(purposes)("independent host leaf cases for %s", purpose => {
    // This suite owns one unmodified fixture/oracle. Only per-case oracle clones
    // are changed; no caller/request/call snapshot or production clone is removed.
    const f = fixture(), records = expectedRequests(f);
    const index = records.findIndex(r => r.purpose === purpose);
    it("accepts every purpose with a matched control", () => { matched(f); });
    // Keep the exact original non-candidate leaf domain. Candidate forwarding
    // remains covered by the complete all-record/all-leaf test above.
    const probes = leaves(records[index]!).filter(l => l.path[0] !== "candidate")
      .map(leaf => ({ path: leaf.path.join("."), leaf }));
    it.each(probes)("rejects an independent mismatch at $path", ({ leaf }) => {
      const changed = structuredClone(records);
      replaceAt(changed[index], leaf.path, different(leaf.value));
      const host = exactHost(changed), r = assess(f.candidate, f.bindings, host.authority);
      expect(host.calls, leaf.path.join(".")).toEqual(records);
      expect(capability(r, purpose).status, leaf.path.join(".")).toBe("not_ready");
      // Different external questions/purposes remain independent, not blanket denial.
      if (purpose === "scoring" || purpose === "diagnostic_execution") expect(capability(r, purpose, "host-q-1").status).toBe("ready");
    });
  });

  const mutations: { name: string; purpose: Purpose; change: (f: Fixture) => void }[] = [
    { name: "route knowledge node", purpose: "route_submission", change: f => { f.bindings.route.requirements[0]!.knowledgeNodeId = uuid(90); } },
    { name: "route evidence keys", purpose: "route_submission", change: f => { f.bindings.route.requirements[0]!.verification.exerciseKeys.push("host-q-1"); } },
    { name: "route source page", purpose: "route_submission", change: f => { f.bindings.route.requirements[0]!.sourceRefs[0]!.page = 3; } },
    { name: "route source id", purpose: "route_submission", change: f => { f.bindings.route.requirements[0]!.sourceRefs[0]!.sourceId = uuid(90); } },
    { name: "route revision", purpose: "route_submission", change: f => { f.bindings.route.expectedRevisions[0]!.revision++; } },
    { name: "plan task title", purpose: "plan_submission", change: f => { f.bindings.plan.draft.suggestedTasks[0]!.title = "Different title"; } },
    { name: "plan task id", purpose: "plan_submission", change: f => { f.bindings.plan.draft.suggestedTasks[0]!.id = uuid(90); } },
    { name: "plan task label", purpose: "plan_submission", change: f => { f.bindings.plan.draft.suggestedTasks[0]!.skillLabel = "Different label"; } },
    { name: "plan task budget", purpose: "plan_submission", change: f => { f.bindings.plan.draft.suggestedTasks[0]!.minutes++; } },
    { name: "plan unscheduled identities", purpose: "plan_submission", change: f => { f.bindings.plan.draft.unscheduledTaskIds = [uuid(90)]; } },
    { name: "plan date", purpose: "plan_submission", change: f => { f.bindings.plan.draft.date = "2026-11-12"; } },
    { name: "diagnostic task version", purpose: "diagnostic_execution", change: f => { f.bindings.questions[0]!.diagnostic.start.expectedTaskVersion++; } },
    { name: "diagnostic client key", purpose: "diagnostic_execution", change: f => { f.bindings.questions[0]!.diagnostic.start.clientKey = "other-client"; } },
    { name: "diagnostic chunk", purpose: "diagnostic_execution", change: f => { f.bindings.questions[0]!.diagnostic.problem.chunkId = uuid(90); } },
    { name: "diagnostic stem", purpose: "diagnostic_execution", change: f => { f.bindings.questions[0]!.diagnostic.problem.stemSnapshot = "Different private stem"; } },
    { name: "diagnostic key receipt", purpose: "diagnostic_execution", change: f => { f.bindings.questions[0]!.diagnostic.key.verification.receiptId = uuid(90); } },
    { name: "scoring source page", purpose: "scoring", change: f => { f.bindings.questions[0]!.scoring.identity.sourceRefs[0]!.page = 3; } },
    { name: "scoring additional source", purpose: "scoring", change: f => { f.bindings.questions[0]!.scoring.identity.sourceRefs.push({ sourceId: uuid(90), version: 3, page: 3 }); } },
    { name: "scoring condition version", purpose: "scoring", change: f => { f.bindings.questions[0]!.scoring.identity.conditionRefs[0]!.version++; } },
    { name: "scoring figure page", purpose: "scoring", change: f => { f.bindings.questions[0]!.scoring.identity.figureRefs[0]!.page = 3; } },
    { name: "scoring evaluator version", purpose: "scoring", change: f => { f.bindings.questions[0]!.scoring.verification.evaluatorVersion = "other-version"; } },
  ];
  it.each(mutations)("schema-valid changed input reaches host and is rejected: $name", ({ purpose, change }) => {
    const f = fixture(), records = expectedRequests(f);
    matched(f); change(f);
    const host = exactHost(records), r = assess(f.candidate, f.bindings, host.authority);
    const cap = capability(r, purpose);
    expect(cap.schemaChecks.every(c => c.valid)).toBe(true);
    expect(host.calls.some(c => c.purpose === purpose && c.externalQuestionId === (purpose === "scoring" || purpose === "diagnostic_execution" ? "host-q-0" : null))).toBe(true);
    expect(cap.status).toBe("not_ready");
    expect(host.calls).toEqual(expectedRequests(f));
  });

  it.each(purposes)("never reuses a previous approval for another purpose/question/request: %s", purpose => {
    const f = fixture(), records = expectedRequests(f), host = exactHost(records);
    matched(f);
    host.authority.verifyBinding = request => { host.calls.push(structuredClone(request)); return request.purpose === purpose && request.externalQuestionId !== "host-q-1"; };
    const first = assess(f.candidate, f.bindings, host.authority);
    expect(host.calls).toEqual(records);
    for (const p of purposes) expect(capability(first, p).status === "ready").toBe(p === purpose);
    expect(capability(first, "scoring", "host-q-1").status).toBe("not_ready");
    host.calls.length = 0;
    host.authority.verifyBinding = request => { host.calls.push(structuredClone(request)); return false; };
    closed(assess(f.candidate, f.bindings, host.authority));
    expect(host.calls).toEqual(records);
    closed(assess(f.candidate, f.bindings));
  });

  it("constant-true synthetic wiring does not replace missing authority on the next assessment", () => {
    const f = fixture();
    const wired = assess(f.candidate, f.bindings, { asOf, verifyBinding: () => true });
    for (const p of purposes) expect(capability(wired, p).status).toBe("ready");
    const absent = assess(f.candidate, f.bindings); closed(absent);
    for (const p of purposes) {
      expect(capability(absent, p).blockers).toContain("trusted_host_verifier_unavailable");
      expect(capability(wired, p).available).toContain("domain_contract_only_not_host_authentication");
    }
  });
});


describe("card2: time, trusted callbacks, privacy and mastery boundaries", () => {
  it.each([
    "2026-02-29T12:00:00Z", "2026-11-31T12:00:00Z", "2026-11-11T24:00:00Z", "2026-11-11T12:60:00Z",
    "2026-11-11T12:00:60Z", "2026-11-11T12:00:00+24:00", "2026-11-11T12:00:00", "", undefined,
  ])("invalid host time never invokes verifier: %s", time => {
    const f = fixture(), host = exactHost(expectedRequests(f));
    Object.assign(host.authority, { asOf: time });
    const r = assess(f.candidate, f.bindings, host.authority); closed(r);
    expect(host.calls).toEqual([]);
    expect(r.routeSubmission.blockers).toContain("trusted_host_assessment_time_missing_or_invalid");
  });

  it.each([
    "2024-02-29T00:00:00Z", "2026-11-11T23:59:59.999999999Z", "2026-11-11T12:00:00+14:00",
    "2026-11-11T12:00:00-12:00", "2000-01-01T00:00:00Z", "2099-12-31T23:59:59Z",
  ])("forwards valid time verbatim; host owns freshness (not a domain TTL): %s", time => {
    const f = fixture(), records = expectedRequests(f);
    for (const r of records) r.asOf = time;
    const host = exactHost(records); host.authority.asOf = time;
    const r = assess(f.candidate, f.bindings, host.authority);
    expect(host.calls).toEqual(records);
    for (const p of purposes) expect(capability(r, p).status).toBe("ready");
    // A host resolving a different instant must deny even schema-valid dates.
    const stale = exactHost(expectedRequests(f)); stale.authority.asOf = time;
    closed(assess(f.candidate, f.bindings, stale.authority));
  });

  it.each(["ownerUserId", "courseId", "routeVersion", "teachingVersion"] as const)("captured %s conflict prevents every host call", field => {
    const f = fixture(); matched(f);
    Object.assign(f.candidate, f.bindings.scope);
    Object.assign(f.candidate, { [field]: field.endsWith("Version") ? 99 : uuid(99) });
    const host = exactHost(expectedRequests(f)), r = assess(f.candidate, f.bindings, host.authority);
    closed(r); expect(host.calls).toEqual([]);
    expect(r.routeSubmission.blockers).toContain("candidate_runtime_scope_conflict");
  });

  it.each(["ownerUserId", "courseId", "routeVersion", "teachingVersion"] as const)("uncaptured %s is independently host-bound, not authenticated by schema", field => {
    const f = fixture(), host = exactHost(expectedRequests(f)); matched(f);
    Object.assign(f.bindings.scope, { [field]: field.endsWith("Version") ? 99 : uuid(99) });
    const r = assess(f.candidate, f.bindings, host.authority); closed(r);
    // Wrong course locally blocks plan only; all other requests reach host with wrong scope.
    const reached = field === "courseId" ? ["route_submission", "diagnostic_execution", "scoring", "diagnostic_execution", "scoring"] : ["route_submission", "plan_submission", "diagnostic_execution", "scoring", "diagnostic_execution", "scoring"];
    expect(host.calls.map(c => c.purpose)).toEqual(reached);
    expect(host.calls.every(c => c.scope[field] === f.bindings.scope[field])).toBe(true);
  });

  it("reads the host clock getter once, but resolves verifier getter per actual invocation", () => {
    const f = fixture(), host = exactHost(expectedRequests(f)); let clocks = 0, callbacks = 0;
    const authority = {
      get asOf() { clocks++; return clocks === 1 ? asOf : "2099-01-01T00:00:00Z"; },
      get verifyBinding() { callbacks++; return host.authority.verifyBinding; },
    };
    const r = assess(f.candidate, f.bindings, authority);
    expect(clocks).toBe(1); expect(callbacks).toBe(6);
    expect(host.calls).toEqual(expectedRequests(f));
    for (const p of purposes) expect(capability(r, p).status).toBe("ready");
  });

  it.each(purposes)("throwing verifier getter/implementation cannot return partial success: %s", purpose => {
    const f = fixture(), host = exactHost(expectedRequests(f));
    let next = 0;
    const failureIndex = expectedRequests(f).findIndex(r => r.purpose === purpose);
    const authority = { asOf, get verifyBinding() {
      if (next++ === failureIndex) throw new Error("trusted callback getter failed");
      return host.authority.verifyBinding;
    } };
    expect(() => assess(f.candidate, f.bindings, authority)).toThrow("trusted callback getter failed");
    expect(host.calls).toHaveLength(failureIndex);
    expect(() => assess(f.candidate, f.bindings, { asOf, verifyBinding(request) {
      if (request.purpose === purpose) throw new Error("host unavailable");
      return true;
    } })).toThrow("host unavailable");
    closed(assess(f.candidate, f.bindings));
  });

  it.each([undefined, null, 1, "true", {}, [], new Boolean(true), Promise.resolve(true)])("only primitive true grants capability, not %s", result => {
    const f = fixture(); matched(f); let calls = 0;
    const r = assess(f.candidate, f.bindings, { asOf, verifyBinding: () => { calls++; return result as boolean; } });
    closed(r); expect(calls).toBe(6);
  });

  it("detaches candidate/scope from caller changes made during trusted callback", () => {
    const f = fixture(), host = exactHost(expectedRequests(f)), expected = expectedRequests(f);
    const r = assess(f.candidate, f.bindings, { asOf, verifyBinding(request) {
      if (request.purpose === "route_submission") {
        f.candidate.postAttemptMetadata.questions[0]!.postAttemptNotes = "changed caller feedback";
        f.candidate.sourceManifestSha256 = "9".repeat(64); f.bindings.scope.ownerUserId = uuid(99);
      }
      return host.authority.verifyBinding(request);
    } });
    expect(host.calls).toEqual(expected);
    for (const p of purposes) expect(capability(r, p).status).toBe("ready");
  });

  it("raw future capability mutation is parsed when reached and rejected by exact host records", () => {
    const f = fixture(), expected = expectedRequests(f), host = exactHost(expected);
    const r = assess(f.candidate, f.bindings, { asOf, verifyBinding(request) {
      if (request.purpose === "route_submission") f.bindings.questions[0]!.scoring.verification.evaluatorVersion = "mutated-later";
      return host.authority.verifyBinding(request);
    } });
    expect(capability(r, "route_submission").status).toBe("ready");
    expect(capability(r, "scoring").status).toBe("not_ready");
    const scoring = host.calls.find(c => c.purpose === "scoring")!;
    expect(scoring).toEqual(expectedRequests(f).find(c => c.purpose === "scoring"));
    expect(scoring).not.toEqual(expected.find(c => c.purpose === "scoring"));
    expect(capability(r, "scoring", "host-q-1").status).toBe("ready");
  });

  it("trusted request mutation is not sandboxed; exact records still deny changed payload", () => {
    const f = fixture(), host = exactHost(expectedRequests(f));
    const r = assess(f.candidate, f.bindings, { asOf, verifyBinding(request) {
      if (request.purpose === "scoring") request.payload.verification.receiptId = uuid(99);
      return host.authority.verifyBinding(request);
    } });
    expect(capability(r, "scoring").status).toBe("not_ready");
    expect(capability(r, "diagnostic_execution").status).toBe("ready");
    expect(f.bindings.questions[0]!.scoring.verification.receiptId).toBe(uuid(12));
    // No assertion that the module can authenticate/sandbox malicious trusted code.
  });

  it("retained callback/report objects cannot mutate caller records or later assessments", () => {
    const f = fixture(), before = structuredClone(f);
    const retained: import("./material-course-package-readiness").MaterialBindingVerificationRequest[] = [];
    const host = exactHost(expectedRequests(f));
    const r = assess(f.candidate, f.bindings, { asOf, verifyBinding(request) {
      retained.push(request); return host.authority.verifyBinding(request);
    } });
    expect(retained).toHaveLength(6);
    retained[0]!.candidate.postAttemptMetadata.questions[0]!.postAttemptNotes = "retained change";
    retained[0]!.scope.ownerUserId = uuid(99);
    const scoring = retained.find(request => request.purpose === "scoring")!;
    if (scoring.purpose === "scoring") scoring.payload.verification.receiptId = uuid(99);
    r.questions[0]!.mappedSkillIds.push("invented-mastery"); r.routeSubmission.blockers.push("changed report");
    expect(f).toEqual(before);
    matched(f); closed(assess(f.candidate, f.bindings));
  });

  it("whole-item verified scoring for two-skill composites is never split into mastery", () => {
    const f = fixture(), r = matched(f);
    for (const q of r.questions) {
      expect(q.mappedSkillIds).toEqual(["host-alpha", "host-beta"]);
      expect(q.bkt.status).toBe("not_ready");
      expect(q.bkt.blockers).toContain("part_level_evidence_missing_no_multi_skill_credit");
    }
    expect(r.questions[0]!.scoring.available).toContain("exact_question_only_no_multi_skill_credit");
    expect(f.candidate.bktBoundary).toMatchObject({ calibrated: false, learnerStateCreated: false });
    expect(f.candidate.prerequisiteGuidance).toMatchObject({ masteryCredit: false, permanentPassGate: false });
    expect(Object.values(r.permissions)).toEqual([false, false, false, false]);
  });

  it.each(["partScores", "skillOutcomes", "reliablePartBindings"])("fake per-part evidence %s cannot enter scoring or first answer", field => {
    const f = fixture(); matched(f);
    Object.assign(f.bindings.questions[0]!.scoring, { [field]: [{ skillId: "host-beta", correct: true, independent: true }] });
    const host = exactHost(expectedRequests(f)), r = assess(f.candidate, f.bindings, host.authority);
    expect(capability(r, "scoring").status).toBe("not_ready");
    expect(host.calls.some(c => c.purpose === "scoring" && c.externalQuestionId === "host-q-0")).toBe(false);
    expect(r.questions.every(q => q.bkt.status === "not_ready")).toBe(true);
    expect(JSON.stringify(r)).not.toContain(field);
  });

  it("feedback/private prompt/evaluator getters validate privately, never project to report or first answer", () => {
    const f = fixture(), reads: string[] = [];
    const bind = (target: object, field: string, value: unknown) => Object.defineProperty(target, field, { enumerable: true, get() { reads.push(field); return value; } });
    bind(f.candidate.postAttemptMetadata.questions[0]!, "postAttemptNotes", "PRIVATE_FEEDBACK");
    bind(f.candidate.postAttemptMetadata.skills[0]!, "commonErrors", ["PRIVATE_ERROR"]);
    bind(f.bindings.questions[0]!.diagnostic.problem, "stemSnapshot", "PRIVATE_PROMPT");
    bind(f.bindings.questions[0]!.scoring.verification, "evaluatorId", "PRIVATE_EVALUATOR");
    const r = assess(f.candidate, f.bindings, { asOf, verifyBinding: () => true });
    expect(reads).toEqual(expect.arrayContaining(["postAttemptNotes", "commonErrors", "stemSnapshot", "evaluatorId"]));
    const publicText = JSON.stringify({ r, firstAnswer: f.candidate.safeFirstAnswerInput });
    for (const secret of ["PRIVATE_FEEDBACK", "PRIVATE_ERROR", "PRIVATE_OBJECTIVE", "PRIVATE_PROMPT", "PRIVATE_EVALUATOR", uuid(11), uuid(12)]) expect(publicText).not.toContain(secret);
    expect(f.candidate.safeFirstAnswerInput.questions[0]).toEqual({ questionId: "host-q-0", sourceRef: f.candidate.questionMappings[0]!.sourceRef });
    expect(f.candidate.postAttemptMetadata).toMatchObject({ role: "feedback_only", independentIfExposedBeforeAnswer: false, scoringEvidence: false });
  });

  it.each(["postAttemptNotes", "commonErrors"])("throwing private candidate getter %s fails before verification", field => {
    const f = fixture(), host = exactHost(expectedRequests(f));
    const target = field === "postAttemptNotes" ? f.candidate.postAttemptMetadata.questions[0]! : f.candidate.postAttemptMetadata.skills[0]!;
    Object.defineProperty(target, field, { enumerable: true, get() { throw new Error("private getter failed"); } });
    expect(() => assess(f.candidate, f.bindings, host.authority)).toThrow("private getter failed");
    expect(host.calls).toEqual([]);
  });

  it.each(["postAttemptNotes", "answer", "partScores"])("first-answer pollution %s cannot launder feedback into independent evidence", field => {
    const f = fixture(), host = exactHost(expectedRequests(f));
    Object.assign(f.candidate.safeFirstAnswerInput.questions[0]!, { [field]: "PRIVATE_FEEDBACK" });
    expect(() => assess(f.candidate, f.bindings, host.authority)).toThrow();
    expect(host.calls).toEqual([]);
  });
});

describe("card3: actual-module mutants with matched controls", () => {
  it.each(["bypass-host", "force-scope"] as const)("kills %s without changing original implementation", mutant => {
    const control = loadActualModule("control"), changed = loadActualModule(mutant);
    expect(control.sha256).not.toBe(changed.sha256);
    const f = fixture(), records = expectedRequests(f);
    // The SAME oracle checks green control and red mutant. Matching requests must
    // remain green in both, so a blanket-deny or broken loader cannot kill a mutant.
    const verifyMatched = (implementation: typeof assess) => {
      const host = exactHost(records), report = implementation(f.candidate, f.bindings, host.authority);
      expect(host.calls).toEqual(records);
      for (const p of purposes) expect(capability(report, p).status).toBe("ready");
    };
    if (mutant === "force-scope") verifyMatched(changed.assess);
    else {
      // Bypass intentionally omits callbacks, but must still yield ready for a
      // genuinely matching fixture; full request equality is the control's job.
      const report = changed.assess(f.candidate, f.bindings, exactHost(records).authority);
      for (const p of purposes) expect(capability(report, p).status).toBe("ready");
    }
    verifyMatched(control.assess); verifyMatched(assess);
    const probe = (implementation: typeof assess) => {
      const host = exactHost(records), wrong = structuredClone(f);
      if (mutant === "force-scope") wrong.bindings.scope.ownerUserId = uuid(99);
      else host.authority.verifyBinding = request => { host.calls.push(structuredClone(request)); return false; };
      const report = implementation(wrong.candidate, wrong.bindings, host.authority);
      // This assertion succeeds on actual/control, fails on mutated actual module.
      closed(report);
      expect(host.calls).toEqual(expectedRequests(wrong));
    };
    probe(assess); probe(control.assess);
    // Opt-in external red run lets the identical assertion fail uncaught, with a
    // matched control run beside it. Never enables mutation of files on disk.
    if (process.env.MATERIAL_READINESS_MUTANT === mutant) probe(changed.assess);
    else expect(() => probe(changed.assess)).toThrowError(/expected .*not_ready/);
    console.info(`ACTUAL_MODULE_MUTANT ${mutant} control=${control.sha256} mutant=${changed.sha256} matched=green probe=killed`);
  });
});

const privatePath = process.env.MATERIAL_READINESS_PRIVATE_INPUT;
const privateSha = process.env.MATERIAL_READINESS_PRIVATE_SHA256;
const privateConfigured = privatePath !== undefined || privateSha !== undefined;
describe("card3: explicit private replay (no private JSON committed)", () => {
  it.skipIf(!privateConfigured)("replays supplied input with exact SHA; absent env explicitly skips ONLY this case", () => {
    if (!privatePath || !privateSha) throw new Error("Both MATERIAL_READINESS_PRIVATE_INPUT and MATERIAL_READINESS_PRIVATE_SHA256 are required");
    const pack = readPrivatePackage(privatePath, privateSha);
    const candidate = adapter.adaptMaterialCourseFullPackage(pack, { deadlineAt: null });
    const report = assess(candidate);
    closed(report);
    expect(report.preview.questions).toBe(150);
    expect(report.preview.skills).toBe(pack.skills.length);
    expect(report.questions.map(q => q.questionId)).toEqual(pack.questions.map(q => q.id));
    expect(candidate.safeFirstAnswerInput.questions).toEqual(candidate.questionMappings.map(q => ({ questionId: q.id, sourceRef: q.sourceRef })));
    expect(report.questions.every(q => q.scoring.status === "not_ready" && q.bkt.status === "not_ready")).toBe(true);
    expect(report.routeSubmission.blockers).toContain("trusted_host_verifier_unavailable");
    // Replay is an offline fail-closed/privacy check, not a host producer certificate.
    expect(Object.values(report.permissions)).toEqual([false, false, false, false]);
    console.info(`PRIVATE_REPLAY sha256=${privateSha} questions=${report.preview.questions} skills=${report.preview.skills} MODULE_PENDING`);
  });
});
