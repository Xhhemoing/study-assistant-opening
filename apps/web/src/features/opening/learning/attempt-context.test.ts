import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LearningAttempt, StudyContextAnchor } from "@aistudy/contracts";
import type { Sql } from "postgres";
const mocks = vi.hoisted(() => ({ assertAccess: vi.fn(), resolve: vi.fn(), exposures: vi.fn(), sql: vi.fn(), scope: vi.fn(), getContext: vi.fn(), insert: vi.fn() }));
vi.mock("@aistudy/database", () => ({
  createOpeningLearningAttemptRepository: () => ({ assertAccess: mocks.assertAccess }),
  createOpeningLearningRepository: () => ({ listDeliveredExposures: mocks.exposures, insertObservation: mocks.insert }),
  createOpeningKnowledgeRepository: () => ({}),
  createOpeningStudyContextRepository: () => ({ resolve: mocks.resolve }),
}));
vi.mock("../runtime", () => ({ requireOpeningScope: mocks.scope, getAttemptService: () => ({ getContext: mocks.getContext }) }));
import { createOpeningAttemptService } from "./attempt-service";
import { createOpeningLearningClient } from "../client/learning-client";
import { GET } from "../../../app/api/opening/attempts/[id]/context/route";
import { ApiError } from "../../auth/service";

const id = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const scope = { workspaceId: id, ownerUserId: id };
const anchor: StudyContextAnchor = { attemptId: id, courseId: id, activityId: id, itemVersionId: id, sourceId, sourceVersion: 2, page: 1, purpose: "learning_help" };
const attempt: LearningAttempt = { id, workspaceId: id, sessionId: id, courseId: id, skillLabel: "span", requirementKey: "span:v1", problemId: id, itemVersionId: id,
  sourceIds: [sourceId], sourceVersions: { [sourceId]: 2 }, startedAt: "2026-10-21T00:00:00Z", submittedAt: "2026-10-21T00:01:00Z", observationId: id, historyRevision: 3 };
const service = createOpeningAttemptService(mocks.sql as unknown as Sql);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertAccess.mockResolvedValue(attempt);
  mocks.resolve.mockResolvedValue(anchor);
  mocks.exposures.mockResolvedValue(["hinted", "revealed"]);
  mocks.scope.mockResolvedValue({ scope, sql: mocks.sql });
  mocks.getContext.mockImplementation((owner, attemptId) => service.getContext(owner, attemptId));
});
describe("canonical assistant attempt restoration", () => {
  it("passes the real service response through the route and client without reading or exposing the saved answer", async () => {
    const transport = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => GET(new Request(`https://study.example${String(url)}`, init), { params: Promise.resolve({ id }) }));
    const result = await createOpeningLearningClient(transport).getAttemptContext(id);
    expect(result).toEqual({ attempt: { ...attempt, contextAnchor: anchor }, deliveredAssistance: "revealed" });
    expect(transport).toHaveBeenCalledWith(`/api/opening/attempts/${id}/context`, expect.objectContaining({ method: "GET", cache: "no-store" }));
    expect(mocks.assertAccess).toHaveBeenCalledWith(scope, id);
    expect(mocks.resolve).toHaveBeenCalledWith(scope, { purpose: "learning_help" }, { attemptId: id, sessionId: id, courseId: id, sourceIds: [sourceId] });
    expect(mocks.exposures).toHaveBeenCalledWith(scope, id, { attemptId: id, assessmentDomain: "math" });
    expect(result.attempt).not.toHaveProperty("answer");
    expect(result).not.toHaveProperty("observation");
    expect(mocks.sql).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it.each(["NOT_FOUND", "CONFLICT"])("preserves owner/source/version denial %s before releasing any context", async code => {
    mocks.resolve.mockRejectedValueOnce(Object.assign(new Error("selected version unavailable"), { code }));
    await expect(service.getContext(scope, id)).rejects.toMatchObject({ code });
    expect(mocks.exposures).not.toHaveBeenCalled();
  });

  it("requires scoped attempt access before resolving its context", async () => {
    mocks.assertAccess.mockRejectedValueOnce(Object.assign(new Error("not owned"), { code: "NOT_FOUND" }));
    await expect(service.getContext(scope, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each([{ sourceIds: [] }, { sourceVersions: {} }, { itemVersionId: null, problemId: null }])("blocks an incomplete legacy attempt without inventing a version: %j", async change => {
    mocks.assertAccess.mockResolvedValueOnce({ ...attempt, ...change });
    await expect(service.getContext(scope, id)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("returns 401 from the authenticated route without looking up an attempt", async () => {
    mocks.scope.mockRejectedValueOnce(new ApiError("UNAUTHENTICATED", "Authentication required", 401));
    expect((await GET(new Request("https://study.example/api/opening/attempts/id/context"), { params: Promise.resolve({ id }) })).status).toBe(401);
    expect(mocks.getContext).not.toHaveBeenCalled();
  });

  it("the client rejects the old exposure-only shape instead of treating it as a bound attempt", async () => {
    const client = createOpeningLearningClient(async () => Response.json({ attemptId: id, sessionId: id, deliveredAssistance: "none" }));
    await expect(client.getAttemptContext(id)).rejects.toThrow();
  });
});
