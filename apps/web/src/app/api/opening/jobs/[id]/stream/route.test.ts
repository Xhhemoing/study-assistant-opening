import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ scope: vi.fn(), get: vi.fn(), open: vi.fn() }));
vi.mock("../../../../../../features/opening/runtime", () => ({ requireOpeningScope: mocks.scope }));
vi.mock("../../../../../../features/opening/server/data-services", () => ({ getTutorJobService: () => ({ get: mocks.get }) }));
vi.mock("../../../../../../features/opening/server/job-stream", () => ({ openTutorJobStream: mocks.open }));
import { ApiError } from "../../../../../../features/auth/service";
import { GET } from "./route";

const scope = { workspaceId: "workspace-1", ownerUserId: "owner-1" };
const context = { params: Promise.resolve({ id: "job-1" }) };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.scope.mockResolvedValue({ scope, sql: "sql" });
});

it("authorizes the owned job before connecting to the stream transport", async () => {
  const job = { id: "job-1", status: "running", assistantTurnId: "turn-1", conversationId: "conversation-1" };
  mocks.get.mockResolvedValue(job);
  mocks.open.mockResolvedValue(new Response("event: snapshot\n\ndata: {}\n\n", { headers: { "Content-Type": "text/event-stream" } }));
  const request = new Request("http://test/api/opening/jobs/job-1/stream");
  const response = await GET(request, context);
  expect(response.status).toBe(200);
  expect(mocks.get).toHaveBeenCalledWith(scope, "job-1");
  expect(mocks.open).toHaveBeenCalledWith("sql", scope, job, request.signal);
  expect(response.headers.get("Content-Type")).toBe("text/event-stream");
});

it("does not connect Redis for a missing or foreign job", async () => {
  mocks.get.mockResolvedValue(null);
  const response = await GET(new Request("http://test/api/opening/jobs/job-1/stream"), context);
  expect(response.status).toBe(404);
  expect(mocks.open).not.toHaveBeenCalled();
});

it("requires a valid session before reading job or Redis state", async () => {
  mocks.scope.mockRejectedValue(new ApiError("UNAUTHENTICATED", "login required", 401));
  const response = await GET(new Request("http://test/api/opening/jobs/job-1/stream"), context);
  expect(response.status).toBe(401);
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
});
