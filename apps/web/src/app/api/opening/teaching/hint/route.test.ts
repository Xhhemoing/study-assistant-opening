import { beforeEach, expect, it, vi } from "vitest";
const { read, readReleased, gate, requireScope } = vi.hoisted(() => ({ read: vi.fn(), readReleased: vi.fn(), gate: vi.fn(), requireScope: vi.fn() }));
vi.mock("../../../../../server/opening-config", () => ({ teachingLoopApiDenied: gate }));
vi.mock("../../../../../features/opening/runtime", () => ({ requireOpeningScope: requireScope }));
vi.mock("../../../../../features/opening/teaching/teaching-hint-service", () => ({ createTeachingHintService: () => ({ read, readReleased }) }));
import { GET, POST } from "./route";
import { ApiError } from "../../../../../features/auth/service";
const id = "11111111-1111-4111-8111-111111111111", scope = { workspaceId: id, ownerUserId: id };
beforeEach(() => { vi.clearAllMocks(); requireScope.mockResolvedValue({ scope, sql: {} }); readReleased.mockResolvedValue([]); gate.mockReturnValue(null); });
it("returns only an owned released-hint read with no-store and leaves POST delivery separate", async () => {
  const response = await GET(new Request(`http://localhost/api/opening/teaching/hint?attemptId=${id}`));
  expect(await response.json()).toEqual({ hints: [] }); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(readReleased).toHaveBeenCalledExactlyOnceWith(scope, { attemptId: id }); expect(read).not.toHaveBeenCalled();
  read.mockResolvedValue({ receipt: "original POST" });
  await POST(new Request("http://localhost/api/opening/teaching/hint", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attemptId: id, level: 1 }) }));
  expect(read).toHaveBeenCalledExactlyOnceWith(scope, { attemptId: id, level: 1 });
});
it.each(["", "?attemptId=invalid", `?attemptId=${id}&attemptId=${id}`, `?attemptId=${id}&level=4`])("rejects malformed or ambiguous recovery query %s", async query => {
  const response = await GET(new Request(`http://localhost/api/opening/teaching/hint${query}`));
  expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("no-store"); expect(readReleased).not.toHaveBeenCalled();
});
it("preserves authentication and rollout denial before reading any hint", async () => {
  gate.mockReturnValue(Response.json({ error: { code: "UNAVAILABLE" } }, { status: 403 }));
  const response = await GET(new Request(`http://localhost/api/opening/teaching/hint?attemptId=${id}`));
  expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("no-store"); expect(readReleased).not.toHaveBeenCalled();
  gate.mockReturnValue(null); requireScope.mockRejectedValue(new ApiError("UNAUTHENTICATED", "unauthorized", 401));
  expect((await GET(new Request(`http://localhost/api/opening/teaching/hint?attemptId=${id}`))).status).toBe(401);
});
