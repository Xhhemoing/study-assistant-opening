import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "../../../../../features/auth/service";
import { POST, PUT } from "./route";

const mocks = vi.hoisted(() => ({ scope: vi.fn(), redeem: vi.fn(), getAuthRuntime: vi.fn(), clock: vi.fn() }));
vi.mock("../../../../../features/opening/runtime", () => ({ requireOpeningScope: mocks.scope }));
vi.mock("../../../../../server/runtime", () => ({ getAuthRuntime: mocks.getAuthRuntime }));
vi.mock("@aistudy/database", async original => ({
  ...await original<typeof import("@aistudy/database")>(),
  redeemTryMisconceptionHandoff: mocks.redeem,
  readTryMisconceptionHandoffClock: mocks.clock,
}));

const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const headers = { "Content-Type": "application/json" };
function request(method: string, body: string | Uint8Array<ArrayBuffer>) {
  return new Request("http://localhost/api/opening/public-try/misconception-handoff", { method, headers, body });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getAuthRuntime.mockReturnValue({ sql: {} });
  mocks.clock.mockResolvedValue({ nowMs: 10_000, issueSeq: 42 });
  mocks.scope.mockResolvedValue({ sql: {}, scope, principal: { userId: "owner", workspaceId: "workspace" } });
});

it("issues anonymously, redeems on login, then respects the repository replay status", async () => {
  vi.stubEnv("AUTH_SECRET", "synthetic-signing-secret-with-32-characters");
  vi.stubEnv("OPENING_PUBLIC_TRY", "1");
  try {
    const issuance = await PUT(request("PUT", '{"challenge":"limit","step":0,"reason":0}'));
    expect(issuance.status).toBe(201);
    expect(issuance.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.scope).not.toHaveBeenCalled();
    const { receipt } = await issuance.json();
    const body = JSON.stringify({ receipt });
    mocks.redeem.mockResolvedValueOnce({ edgeId: "edge", revisionId: "rev", replayed: false })
      .mockResolvedValueOnce({ edgeId: "edge", revisionId: "rev", replayed: true });
    expect((await POST(request("POST", body))).status).toBe(201);
    const replay = await POST(request("POST", body));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ edgeId: "edge", revisionId: "rev", replayed: true });
    expect(mocks.redeem).toHaveBeenCalledWith({}, scope, expect.objectContaining({
      conceptKey: "limit", issuedAt: 10_000, issueSeq: 42, expiresAt: 910_000,
    }));
    mocks.redeem.mockRejectedValueOnce(Object.assign(new Error("receipt expired"), { code: "CONFLICT" }));
    expect((await POST(request("POST", body))).status).toBe(409);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("validates selection and configuration before opening the issuance runtime", async () => {
  vi.stubEnv("OPENING_PUBLIC_TRY", "1");
  vi.stubEnv("AUTH_SECRET", undefined);
  try {
    expect((await PUT(request("PUT", '{"challenge":"limit","step":7,"reason":0}'))).status).toBe(400);
    expect((await PUT(request("PUT", '{"challenge":"limit","step":0,"reason":0}'))).status).toBe(503);
    vi.stubEnv("AUTH_SECRET", "synthetic-signing-secret-with-32-characters");
    const correct = await PUT(request("PUT", '{"challenge":"limit","step":2,"reason":0}'));
    expect(correct.status).toBe(200);
    expect(await correct.json()).toEqual({ receipt: null });
    expect(mocks.getAuthRuntime).not.toHaveBeenCalled();
    expect(mocks.clock).not.toHaveBeenCalled();
    expect(mocks.scope).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it("rejects unauthenticated access, tampered tokens, fields and malformed bodies before writing", async () => {
  vi.stubEnv("AUTH_SECRET", "synthetic-signing-secret-with-32-characters");
  try {
    mocks.scope.mockRejectedValueOnce(new ApiError("UNAUTHENTICATED", "Authentication required", 401));
    expect((await POST(request("POST", '{"receipt":"bad"}'))).status).toBe(401);
    expect((await POST(request("POST", '{"receipt":"bad"}'))).status).toBe(401);
    expect((await POST(request("POST", '{"receipt":"bad","rubric":[]}'))).status).toBe(400);
    expect((await POST(request("POST", new Uint8Array([0xc3, 0x28])))).status).toBe(400);
    expect((await POST(request("POST", " ".repeat(16 * 1024 + 1)))).status).toBe(413);
    mocks.scope.mockResolvedValueOnce({ sql: {}, scope, principal: { userId: "owner", workspaceId: "foreign" } });
    expect((await POST(request("POST", '{"receipt":"bad"}'))).status).toBe(403);
    expect(mocks.redeem).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});
