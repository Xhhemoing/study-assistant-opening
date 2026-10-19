import { beforeEach, describe, expect, it, vi } from "vitest";
const { requireScope, sourceContent, deliver } = vi.hoisted(() => ({ requireScope: vi.fn(), sourceContent: vi.fn(), deliver: vi.fn() }));
vi.mock("../../../../../../features/opening/runtime", () => ({ requireOpeningScope: requireScope }));
vi.mock("../../../../../../features/opening/server/data-services", () => ({ openingQueries: () => ({ sourceContent }) }));
vi.mock("../../../../../../features/opening/server/content-delivery", () => ({ openingContentDelivery: () => ({ source: deliver }) }));
vi.mock("../../../../../../features/auth/service", () => ({ mapDomainError: () => ({ status: 503 }), jsonError: () => Response.json({ error: "unavailable" }, { status: 503 }) }));
import { GET } from "./route";
const id = "10000000-0000-4000-8000-000000000001";
const request = () => new Request(`http://local.test/api/opening/sources/${id}/content?version=2&page=7`, { headers: { "x-study-release-key": id } });
const context = { params: Promise.resolve({ id }) };
beforeEach(() => {
  vi.clearAllMocks();
  requireScope.mockResolvedValue({ scope: { workspaceId: id, ownerUserId: id }, sql: {} });
  sourceContent.mockResolvedValue({ sourceId: id, version: 2, currentVersion: 4, page: 7, text: "private old-version solution" });
  deliver.mockResolvedValue([{ id, releasedAt: "2026-10-19T00:00:00Z" }]);
});
describe("material HTTP content release boundary", () => {
  it("keeps the reader version-pinned and awaits the receipt before sending content", async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(sourceContent).toHaveBeenCalledWith({ workspaceId: id, ownerUserId: id }, id, { version: 2, page: 7 });
    expect(deliver).toHaveBeenCalledWith({ workspaceId: id, ownerUserId: id }, id, expect.objectContaining({ version: 2, currentVersion: 4, page: 7 }));
    expect(sourceContent.mock.invocationCallOrder[0]).toBeLessThan(deliver.mock.invocationCallOrder[0]!);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ text: "private old-version solution", exposureReceipts: [{ id }] });
  });
  it("never releases or leaks body text when content authorization fails", async () => {
    sourceContent.mockRejectedValueOnce(new Error("not owned"));
    const response = await GET(request(), context);
    expect(response.status).toBe(503);
    expect(deliver).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("private old-version solution");
  });
  it("never sends body text if durable release fails", async () => {
    deliver.mockRejectedValueOnce(new Error("history write failed"));
    const response = await GET(request(), context);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private old-version solution");
  });
});
