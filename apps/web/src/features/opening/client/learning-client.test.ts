import { expect, it, vi } from "vitest";
import { createOpeningLearningClient } from "./learning-client";

const COURSE = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

it("does not fill a failed backend with demo learning results", async () => {
  const client = createOpeningLearningClient(async () => new Response("unavailable", { status: 503 }));
  await expect(client.getSummary(COURSE)).rejects.toThrow();
});

it("rejects submitObservation when the backend is unavailable", async () => {
  const client = createOpeningLearningClient(async () => new Response("unavailable", { status: 503 }));
  await expect(client.submitObservation({
    sessionId: SESSION,
    courseId: COURSE,
    skillLabel: "fractions",
    sourceIds: [],
    answer: "1/2",
    outcome: "unverified",
    assistance: "unknown",
    clientKey: "client-key-01",
  })).rejects.toThrow();
});

it("parses a genuine empty summary without inventing skills", async () => {
  const fetchImpl = vi.fn(async (url: string) => {
    expect(url).toBe(`/api/opening/courses/${COURSE}/learning`);
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  });
  const client = createOpeningLearningClient(fetchImpl as unknown as typeof fetch);
  await expect(client.getSummary(COURSE)).resolves.toEqual([]);
});

const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const OBSERVATION = "44444444-4444-4444-8444-444444444444";
const SOURCE = "55555555-5555-4555-8555-555555555555";
const ISO = "2026-09-28T10:00:00.000Z";
const attempt = {
  id: ATTEMPT, workspaceId: COURSE, sessionId: SESSION, courseId: COURSE, skillLabel: "fractions", requirementKey: null,
  problemId: null, itemVersionId: null, sourceIds: [SOURCE], sourceVersions: { [SOURCE]: 2 },
  startedAt: ISO, submittedAt: null, observationId: null, historyRevision: 1,
};

it("starts an attempt with server-returned identity and no invented source version", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(url.endsWith("learning-sessions") ? { id: SESSION } : attempt), { status: 201 });
  });
  const client = createOpeningLearningClient(fetchImpl as unknown as typeof fetch);
  const session = await client.createSession({ courseId: COURSE, skillLabel: "fractions", sourceIds: [SOURCE] });
  expect(await client.createAttempt({ sessionId: session.id, clientKey: "attempt-key", problem: { sourceId: SOURCE, stemSnapshot: "1/4 + 1/4?", artifactKind: "reference_item" } })).toEqual(attempt);
  expect(requests[1]).toEqual({ url: "/api/opening/attempts", body: { sessionId: SESSION, clientKey: "attempt-key", problem: { sourceId: SOURCE, stemSnapshot: "1/4 + 1/4?", artifactKind: "reference_item" } } });
});

it("submits a self-report while preserving unknown server qualifications", async () => {
  const eligibility = { independentAttempt: "unknown", verifiedCorrect: "unknown", usableForCurrentVersion: "unknown", usableForDelayedCheck: "unknown", reasonCodes: ["observation_identity_incomplete"], policyVersion: "opening-evidence-v1" };
  const input = { clientKey: "submission-key", answer: "1/2", outcome: "correct" as const, assistance: "independent" as const, verdictSource: "self_report" as const };
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe(`/api/opening/attempts/${ATTEMPT}/submit`);
    expect(JSON.parse(String(init?.body))).toEqual(input);
    return new Response(JSON.stringify({ ...input, sessionId: SESSION, courseId: COURSE, skillLabel: "fractions", sourceIds: [], id: OBSERVATION, workspaceId: COURSE, occurredAt: ISO, sourceTurnIds: [], referenceSourceId: null, evidenceVerdict: "MASTERY_NOT_ESTABLISHED", eligibility, allowsIndependent: false }), { status: 201 });
  });
  const result = await createOpeningLearningClient(fetchImpl as unknown as typeof fetch).submitAttempt(ATTEMPT, input);
  expect(result.outcome).toBe("correct");
  expect(result.eligibility).toEqual(eligibility);
  expect(result.allowsIndependent).toBe(false);
});

it("keeps submit errors observable and does not fabricate a record", async () => {
  const client = createOpeningLearningClient(async () => new Response(JSON.stringify({ error: { message: "attempt is already submitted" } }), { status: 409 }));
  await expect(client.submitAttempt(ATTEMPT, { clientKey: "submission-key", answer: "x", outcome: "unverified", assistance: "unknown" })).rejects.toThrow("attempt is already submitted");
});

it("preserves server conflict status and code for correction recovery", async () => {
  const client = createOpeningLearningClient(async () => new Response(JSON.stringify({ error: { code: "CONFLICT", message: "observation head changed" } }), { status: 409 }));
  await expect(client.reviseObservation({ rootObservationId: OBSERVATION, revisesObservationId: OBSERVATION, expectedHead: OBSERVATION, revisionKind: "retract", reason: "incorrect record", clientKey: "revision-key" })).rejects.toMatchObject({ status: 409, code: "CONFLICT", message: "observation head changed" });
});

it("reads real empty current-head records and courses through their server routes", async () => {
  const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/courses" ? { courses: [{ id: COURSE, title: "Fractions", ignored: true }] } : []), { status: 200 }));
  const client = createOpeningLearningClient(fetchImpl as unknown as typeof fetch);
  expect(await client.listObservations(COURSE)).toEqual([]);
  expect(fetchImpl).toHaveBeenCalledWith(`/api/opening/courses/${COURSE}/observations`, expect.objectContaining({ method: "GET" }));
  expect(await client.listRevisionCourses()).toEqual([{ id: COURSE, title: "Fractions" }]);
});
