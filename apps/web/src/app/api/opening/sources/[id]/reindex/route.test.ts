import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ scope: vi.fn(), config: vi.fn(), reindex: vi.fn() }));
vi.mock("../../../../../../features/opening/runtime", () => ({ requireOpeningScope: mocks.scope }));
vi.mock("@aistudy/config", async original => ({ ...(await original<typeof import("@aistudy/config")>()), loadOpeningEmbeddingConfig: mocks.config }));
vi.mock("@aistudy/database", async original => ({ ...(await original<typeof import("@aistudy/database")>()),
  createOpeningSourceEmbeddingsRepository: () => ({ reindex: mocks.reindex }) }));
import { POST } from "./route";
const id = "00000000-0000-4000-8000-000000000001";
const scope = { workspaceId: "owned", ownerUserId: "owner" };
beforeEach(() => { vi.resetAllMocks(); mocks.scope.mockResolvedValue({ scope, sql: {} }); mocks.config.mockReturnValue({}); mocks.reindex.mockResolvedValue({ jobId: "index-job" }); });
describe("explicit material search rebuild", () => {
  it("uses the authenticated owner scope and schedules rather than sending from HTTP", async () => {
    const response = await POST(new Request(`http://localhost/${id}`, { method: "POST" }), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ jobId: "index-job" });
    expect(mocks.reindex).toHaveBeenCalledWith(scope, id);
  });
  it("explains unavailable embedding configuration without queuing futile work", async () => {
    mocks.config.mockReturnValue(null);
    const response = await POST(new Request(`http://localhost/${id}`, { method: "POST" }), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(409);
    expect(mocks.reindex).not.toHaveBeenCalled();
  });
  it("does not disclose foreign sources", async () => {
    mocks.reindex.mockRejectedValue(Object.assign(new Error("source unavailable"), { code: "NOT_FOUND" }));
    expect((await POST(new Request(`http://localhost/${id}`, { method: "POST" }), { params: Promise.resolve({ id }) })).status).toBe(404);
  });
});
