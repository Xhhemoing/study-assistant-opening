import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ scope: vi.fn(), apply: vi.fn() }));
vi.mock("../../../../../features/opening/runtime", () => ({ requireOpeningScope: mocks.scope }));
vi.mock("@aistudy/database", async original => ({
  ...await original<typeof import("@aistudy/database")>(),
  applyLearnerMisconceptionCorrection: mocks.apply,
}));

const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const correction = { edgeId: "123e4567-e89b-42d3-a456-426614174000", disposition: "disputed", summary: "重新做过题目" };
function request(body: unknown) {
  return new Request("http://localhost/api/opening/memory/bitemporal-correction", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.scope.mockResolvedValue({ sql: {}, scope, principal: { userId: "owner", workspaceId: "workspace" } });
});

it("applies a scoped learner correction and maps missing or foreign edges to 404", async () => {
  mocks.apply.mockResolvedValueOnce({ status: "learner_reported" })
    .mockRejectedValueOnce(Object.assign(new Error("edge not found"), { code: "NOT_FOUND" }));
  const response = await POST(request(correction));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "learner_reported" });
  expect(mocks.apply).toHaveBeenCalledWith({}, scope, correction);
  expect((await POST(request(correction))).status).toBe(404);
});

it("rejects status, evidence, owner escalation and invalid Unicode", async () => {
  for (const extras of [
    { status: "verified" }, { evidenceAttemptIds: [correction.edgeId] }, { ownerUserId: "foreign" }, { summary: "\uD800" },
  ]) {
    expect((await POST(request({ ...correction, ...extras }))).status).toBe(400);
  }
  expect(mocks.apply).not.toHaveBeenCalled();
});
