import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ scope: vi.fn(), preview: vi.fn() }));
vi.mock("../../../../../features/opening/runtime", () => ({ requireOpeningScope: mocks.scope }));
vi.mock("../../../../../features/opening/concepts/preview-service", () => ({ conceptPreviewService: () => ({ preview: mocks.preview }) }));
import { POST } from "./route";
import { conceptPreviewRequestSchema } from "../../../../../features/opening/concepts/preview-contract";
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("OPENING_EXPLORE_PREVIEW", "1"); mocks.scope.mockResolvedValue({scope:{workspaceId:"w",ownerUserId:"u"},sql:{}}); });
afterEach(() => vi.unstubAllEnvs());
it.each([undefined, "0", "false"])("rejects unset/OFF %s before scope or exposure delivery", async value => {
  vi.stubEnv("OPENING_EXPLORE_PREVIEW", value);
  const response = await POST(new Request("http://local/api/opening/concepts/preview", { method: "POST", body: "not json" }));
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.scope).not.toHaveBeenCalled();
  expect(mocks.preview).not.toHaveBeenCalled();
});
it("rechecks server OFF for a stale ON client", async () => {
  mocks.preview.mockResolvedValue({ status: "unavailable" });
  const request = () => new Request("http://local/api/opening/concepts/preview", { method: "POST", body: "{}" });
  expect((await POST(request())).status).toBe(200);
  mocks.preview.mockClear(); vi.stubEnv("OPENING_EXPLORE_PREVIEW", "0");
  expect((await POST(request())).status).toBe(403);
  expect(mocks.preview).not.toHaveBeenCalled();
});
it("returns a no-store restricted domain result without content", async () => {
  mocks.preview.mockResolvedValue({status:"restricted",reason:"reader_preview_restricted_material_or_open_attempt"});
  const response=await POST(new Request("http://local/api/opening/concepts/preview",{method:"POST",body:"{}"}));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({status:"restricted"});
});
it("maps validation errors to 400, not a fake unavailable success", async () => {
  mocks.preview.mockImplementation((_scope,raw)=>conceptPreviewRequestSchema.parse(raw));
  const response=await POST(new Request("http://local/api/opening/concepts/preview",{method:"POST",body:"{}"}));
  expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("no-store");
});
it("does not read or deliver when authorization fails", async () => {
  mocks.scope.mockRejectedValue(Object.assign(new Error("not found"),{code:"NOT_FOUND"}));
  const response=await POST(new Request("http://local/api/opening/concepts/preview",{method:"POST",body:"{}"}));
  expect(response.ok).toBe(false); expect(mocks.preview).not.toHaveBeenCalled();
});
it("infrastructure errors remain errors", async () => {
  mocks.preview.mockRejectedValue(new Error("db down"));
  expect((await POST(new Request("http://local/api/opening/concepts/preview",{method:"POST",body:"{}"}))).status).toBe(500);
});
