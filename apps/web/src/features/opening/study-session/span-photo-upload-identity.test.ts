// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LearningAttempt, LearningObservation } from "@aistudy/contracts";
import { getSpanProblem } from "@aistudy/domain";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";
import type { SpanLessonDetails } from "../teaching/span/span-session-client";
import { createSpanStudySession } from "./adapters/span";

const mocks = vi.hoisted(() => ({ read: vi.fn(), submit: vi.fn(), context: vi.fn() }));
vi.mock("../client/learning-client", async original => {
  const actual = await original<typeof import("../client/learning-client")>();
  return { ...actual, createOpeningLearningClient: () => ({ ...actual.createOpeningLearningClient(), submitAttempt: mocks.submit,
    getAttemptContext: mocks.context }) };
});
vi.mock("../learning/practice-draft", async original => ({
  ...await original<typeof import("../learning/practice-draft")>(), readPracticeRecord: mocks.read,
}));

const identity = { id: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const photoId = "33333333-3333-4333-8333-333333333333";
let courseId: string;
const sourceId = "55555555-5555-4555-8555-555555555555";
const attemptId = "66666666-6666-4666-8666-666666666666";
const sessionId = "77777777-7777-4777-8777-777777777777";
const activityId = "88888888-8888-4888-8888-888888888888";
const bytes = new Uint8Array([1, 4, 9]);
let releaseIdentity: () => void;
let events: string[];
let puts: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown; credentials: boolean }>;

beforeEach(() => {
  sessionStorage.clear(); vi.resetAllMocks(); events = []; puts = [];
  vi.stubGlobal("crypto", webcrypto);
  courseId = crypto.randomUUID(); // Practice drafts also have an in-memory cache; isolate each session scope.
  releaseIdentity = publishVerifiedSessionIdentity(identity);
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  vi.stubGlobal("XMLHttpRequest", class {
    method = ""; url = ""; headers: Record<string, string> = {}; withCredentials = false; status = 200;
    upload = { onprogress: null }; onload: (() => void) | null = null;
    open(method: string, url: string) { this.method = method; this.url = url; }
    setRequestHeader(name: string, value: string) { this.headers[name] = value; }
    send(body: unknown) {
      events.push("put");
      puts.push({ method: this.method, url: this.url, headers: this.headers, body, credentials: this.withCredentials });
      this.onload?.();
    }
  });
});
afterEach(() => { releaseIdentity(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function session() {
  const exercise = getSpanProblem("span-independent-3d")!;
  const attempt = { id: attemptId, workspaceId: identity.workspaceId, sessionId, courseId, sourceIds: [sourceId],
    sourceVersions: { [sourceId]: 1 }, skillLabel: "span", requirementKey: null, problemId: photoId, itemVersionId: photoId,
    startedAt: "2026-10-31T00:00:00.000Z", submittedAt: null, observationId: null, historyRevision: 0,
    spanExercise: exercise, contextAnchor: { courseId, activityId, sourceId } } as unknown as LearningAttempt;
  const details = { session: { activityId, sessionId, courseId, sourceIds: [sourceId], moveId: "self-independent", status: "active",
    revision: 1, retestId: null, intent: { purpose: "self_study", timeBudgetMinutes: 20, language: "zh", pace: "normal",
      continuous: true, selfReportedFatigue: "unknown" } }, estimateMinutes: 12, attempts: [attempt], observations: [],
    hintLevels: {}, assistance: {}, intentEvent: null } as unknown as SpanLessonDetails;
  mocks.context.mockResolvedValue({ attempt });
  const port = createSpanStudySession(details, async () => true, { photoEnabled: true });
  await port.load();
  return port;
}
function photo() {
  const arrayBuffer = vi.fn(async () => { events.push("read-file"); return bytes.slice().buffer; });
  return { file: Object.assign(new File(["synthetic"], "answer.png", { type: "image/png" }), { arrayBuffer }), arrayBuffer };
}

it("uploads under the verified identity through real API/private PUT and binds the ready photo only to the answer", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    if (path === "/api/auth/me") { events.push("verify"); return Response.json({ user: identity }); }
    const source = { id: photoId, workspaceId: identity.workspaceId, name: "answer.png", mime: "image/png", bytes: bytes.length,
      sha256: "a".repeat(64), version: 1, uploadState: "uploaded", parseState: "ready", error: null, createdAt: "2026-10-31T00:00:00.000Z" };
    if (path === "/api/opening/sources") {
      events.push("begin");
      expect(JSON.parse(String(init?.body))).toMatchObject({ name: "answer.png", mime: "image/png", bytes: bytes.length,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/), uploadId: expect.any(String) });
      return Response.json({ source: { ...source, uploadState: "pending", parseState: "not_started" },
        uploadUrl: "https://unused-storage.invalid/object", expiresAt: "2026-11-30T00:00:00.000Z" });
    }
    if (path === `/api/opening/sources/${photoId}/complete`) { events.push("complete"); return Response.json(source); }
    if (path === `/api/opening/attempts/${attemptId}/work-source`) {
      events.push("prepare");
      expect(JSON.parse(String(init?.body))).toEqual({ sourceId: photoId, sourceVersion: 1, physicalPage: 1 });
      return Response.json({ attemptId, courseId, state: "ready", parseState: "ready", workSource: { id: photoId, version: 1, physicalPage: 1 } });
    }
    throw new Error(`unexpected fetch: ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const port = await session(), { file, arrayBuffer } = photo();
  const view = await port.choosePhoto(file);
  expect(view.photo).toMatchObject({ status: "ready", workSource: { id: photoId, version: 1, physicalPage: 1 } });
  expect(arrayBuffer).toHaveBeenCalledOnce();
  expect(events).toEqual(["verify", "read-file", "begin", "put", "complete", "prepare"]);
  expect(fetcher.mock.calls.map(([path]) => String(path))).toEqual([
    "/api/auth/me", "/api/opening/sources", `/api/opening/sources/${photoId}/complete`, `/api/opening/attempts/${attemptId}/work-source`,
  ]); // No course-material membership request.
  for (const [, init] of fetcher.mock.calls.slice(1, 3)) {
    const headers = new Headers(init?.headers);
    expect(headers.get("x-upload-user-id")).toBe(identity.id);
    expect(headers.get("x-upload-workspace-id")).toBe(identity.workspaceId);
  }
  expect(puts).toHaveLength(1);
  expect(puts[0]).toMatchObject({ method: "PUT", url: `/api/opening/sources/${photoId}/staging`, credentials: true,
    headers: { "content-type": "image/png", "x-upload-user-id": identity.id, "x-upload-workspace-id": identity.workspaceId } });
  expect(puts[0]!.body).toEqual(bytes);
  port.edit({ membership: "in_span" });
  const record = { id: photoId, assistance: "independent", serverEvaluation: null } as unknown as LearningObservation;
  mocks.submit.mockResolvedValue(record);
  mocks.read.mockResolvedValue({ observation: record, deliveredAssistance: "none" });
  await port.primary();
  expect(mocks.submit).toHaveBeenCalledWith(attemptId, expect.objectContaining({ workSource: { id: photoId, version: 1, physicalPage: 1 } }));
});

it.each(["missing", "different-user", "different-workspace"] as const)("refuses %s identity before reading or uploading the local original", async kind => {
  const other = { ...identity, ...(kind === "different-user" ? { id: photoId } : { workspaceId: photoId }) };
  const fetcher = vi.fn<typeof fetch>(async input => {
    expect(String(input)).toBe("/api/auth/me");
    return Response.json({ user: other });
  });
  vi.stubGlobal("fetch", fetcher);
  const port = await session();
  if (kind === "missing") releaseIdentity();
  const { file, arrayBuffer } = photo();
  const view = await port.choosePhoto(file);
  expect(view.photo).toMatchObject({ status: "unavailable", message: expect.stringContaining("原账户和学习空间") });
  expect(arrayBuffer).not.toHaveBeenCalled();
  expect(puts).toHaveLength(0);
  expect(fetcher).toHaveBeenCalledTimes(kind === "missing" ? 0 : 1);
  expect(view.photo?.workSource).toBeUndefined();
});
