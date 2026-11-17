import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  requireScope: vi.fn(),
  findUserById: vi.fn(),
  quickStart: vi.fn(),
}));
vi.mock("../../../../../features/opening/runtime", () => ({ requireOpeningScope: deps.requireScope }));
vi.mock("../../../../../features/opening/exam-sprint/midterm-quick-start", () => ({
  startMidtermSprint: deps.quickStart,
}));

import { GET, POST } from "./route";

const request = (payload?: unknown) => new Request("http://localhost/api/opening/exam-sprint/quick-start", payload === undefined ? undefined : {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
});

describe("private Math I midterm quick start", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("AISTUDY_WEB_PREVIEW", "1");
    vi.stubEnv("AISTUDY_MIDTERM_QUICK_START_EMAIL", "learner@example.test");
    vi.stubEnv("AISTUDY_MIDTERM_QUICK_START_DIR", process.cwd());
    deps.requireScope.mockResolvedValue({ principal: { userId: "session-owner" }, runtime: { identity: { findUserById: deps.findUserById } } });
    deps.findUserById.mockResolvedValue({ email: "learner@example.test" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("hides the private launcher from another signed-in account", async () => {
    deps.findUserById.mockResolvedValue({ email: "someone-else@example.test" });
    const get = await GET(request());
    expect(await get.json()).toEqual({ available: false });
    expect(get.headers.get("Cache-Control")).toBe("no-store");
    expect((await POST(request({}))).status).toBe(404);
    expect(deps.quickStart).not.toHaveBeenCalled();
  });

  it("normalizes whitespace and case when matching the allowlisted account email", async () => {
    vi.stubEnv("AISTUDY_MIDTERM_QUICK_START_EMAIL", "  Learner@Example.Test ");
    deps.findUserById.mockResolvedValue({ email: " LEARNER@example.TEST " });
    deps.quickStart.mockResolvedValueOnce({ pending: true });
    expect(await (await GET(request())).json()).toEqual({ available: true });
    expect(await (await POST(request({}))).json()).toEqual({ pending: true });
    expect(deps.quickStart).toHaveBeenCalledTimes(1);

    deps.findUserById.mockResolvedValue({ email: null });
    expect(await (await GET(request())).json()).toEqual({ available: false });
    expect((await POST(request({}))).status).toBe(404);
  });

  it("leaves the launcher disabled without private process configuration", async () => {
    vi.stubEnv("AISTUDY_MIDTERM_QUICK_START_DIR", "");
    expect(await (await GET(request())).json()).toEqual({ available: false });
    expect((await POST(request({}))).status).toBe(404);
    expect(deps.quickStart).not.toHaveBeenCalled();
  });

  it("disables the launcher outside the preview runtime", async () => {
    vi.stubEnv("AISTUDY_WEB_PREVIEW", "0");
    expect(await (await GET(request())).json()).toEqual({ available: false });
    expect((await POST(request({}))).status).toBe(404);
    expect(deps.quickStart).not.toHaveBeenCalled();
  });

  it("rejects client-selected paths and scopes", async () => {
    for (const input of [{ directory: "outside" }, { workspaceId: "outside" }, { courseId: "outside" }]) {
      expect((await POST(request(input))).status).toBe(400);
    }
    expect(deps.quickStart).not.toHaveBeenCalled();
  });

  it("returns pending and ready results without leaking the configured directory", async () => {
    const courseId = "b8c18c5c-c2b9-4a46-8e85-e901214afc32";
    const target = { courseId, href: `/opening/courses/${courseId}?mode=sprint` };
    deps.quickStart.mockResolvedValueOnce({ pending: true }).mockResolvedValueOnce(target);
    expect(await (await GET(request())).json()).toEqual({ available: true });
    expect(await (await POST(request({}))).json()).toEqual({ pending: true });
    expect(await (await POST(request({}))).json()).toEqual(target);
  });
});
