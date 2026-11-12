import { beforeEach, expect, it, vi } from "vitest";
import { TEACHING_EXAMPLE_CONSENT_VERSION } from "@aistudy/contracts";
const id = "11111111-1111-4111-8111-111111111111";
const target = { activityId: id, documentId: id, blockId: id, revisionNumber: 1, contentVersion: 1 };
const stubs = vi.hoisted(() => ({ request: vi.fn(), read: vi.fn(), find: vi.fn(), findTarget: vi.fn(), estimate: vi.fn() }));
vi.mock("../../../../../features/opening/runtime", () => ({ requireOpeningScope: async () => ({ scope: { workspaceId: "w", ownerUserId: "u" }, sql: {} }) }));
vi.mock("../../../../../server/opening-config", () => ({ teachingLoopApiDenied: () => null }));
vi.mock("../../../../../features/opening/teaching/teaching-example-service", () => ({ createTeachingExampleService: () => stubs }));
import { GET, POST } from "./route";
beforeEach(() => { vi.clearAllMocks(); stubs.find.mockResolvedValue(null); stubs.findTarget.mockResolvedValue(null); stubs.estimate.mockResolvedValue({ estimate: "safe" }); });
it("status and target recovery are read-only and do not submit", async () => {
  const response = await GET(new Request("https://localhost/api/opening/teaching/examples?clientKey=example-01"));
  expect(response.status).toBe(200); expect(stubs.find).toHaveBeenCalledOnce(); expect(stubs.request).not.toHaveBeenCalled();
  const query = new URLSearchParams(Object.entries(target).map(([key, value]) => [key, String(value)]));
  expect((await GET(new Request(`https://localhost/api/opening/teaching/examples?${query}&lookup=target`))).status).toBe(200);
  expect(stubs.findTarget).toHaveBeenCalledOnce(); expect(stubs.estimate).not.toHaveBeenCalled();
});
it("rejects client-supplied question/price and missing consent before any write", async () => {
  for (const extra of [{ prompt: "untrusted" }, { price: 0 }, { acceptPaidGeneration: false }]) {
    const response = await POST(new Request("https://localhost/api/opening/teaching/examples", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientKey: "example-01", target, consentVersion: TEACHING_EXAMPLE_CONSENT_VERSION, acceptPaidGeneration: true, ...extra }) }));
    expect(response.status).toBe(400);
  }
  expect(stubs.request).not.toHaveBeenCalled();
});
