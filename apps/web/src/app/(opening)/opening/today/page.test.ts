import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../../../features/auth/service";
import OpeningTodayPage from "./page";
import TodayLoading from "./loading";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(), authenticate: vi.fn(), resume: vi.fn(), preference: vi.fn(), reader: vi.fn(),
  scope: { workspaceId: "workspace", ownerUserId: "owner" }, sql: {},
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@aistudy/ai", () => ({ isTeachingCompilerEnabled: () => false }));
vi.mock("../../../../features/opening/planning/today-dashboard", () => ({ TodayDashboard: () => null }));
vi.mock("../../../../features/opening/runtime", () => ({ requireOpeningScope: mocks.authenticate }));
vi.mock("../../../../features/opening/planning/today-service", () => ({
  createTodayResumeReader: mocks.reader, loadTodayResumeState: mocks.resume,
}));
vi.mock("../../../../features/opening/server/data-services", () => ({
  getPlanningSettingsService: () => ({ get: mocks.preference }),
}));

const page = () => OpeningTodayPage({ searchParams: Promise.resolve({}) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({ scope: mocks.scope, sql: mocks.sql });
  mocks.resume.mockResolvedValue({ kind: "empty" });
  mocks.preference.mockResolvedValue({ settings: { timeZone: "America/New_York" } });
});

describe("Today server reads", () => {
  it("keeps old task links pointed at the scheduling page", async () => {
    mocks.redirect.mockImplementation(() => { throw new Error("redirect"); });
    await expect(OpeningTodayPage({ searchParams: Promise.resolve({ task: "task-1" }) })).rejects.toThrow("redirect");
    expect(mocks.redirect).toHaveBeenCalledWith("/opening/settings/planning?task=task-1");
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });
  it("starts both scoped reads without waiting for the resume query", async () => {
    let finishResume!: (value: { kind: "empty" }) => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    mocks.resume.mockImplementation(() => {
      markStarted();
      return new Promise(resolve => { finishResume = resolve; });
    });
    const pending = page();
    await started;
    const preferenceStarted = mocks.preference.mock.calls.length;
    finishResume({ kind: "empty" });
    const result = await pending;
    expect(preferenceStarted).toBe(1);
    expect(mocks.preference).toHaveBeenCalledWith(mocks.scope);
    expect(mocks.reader).toHaveBeenCalledWith(mocks.sql);
    expect(mocks.resume).toHaveBeenCalledWith(expect.objectContaining({ scope: mocks.scope }));
    expect(result.props).toMatchObject({ state: { kind: "empty" }, timeZone: "America/New_York" });
  });

  it("does not start either read before authentication completes", async () => {
    let authenticate!: (value: { scope: typeof mocks.scope; sql: object }) => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    mocks.authenticate.mockImplementation(() => {
      markStarted();
      return new Promise(resolve => { authenticate = resolve; });
    });
    const pending = page();
    await started;
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.preference).not.toHaveBeenCalled();
    authenticate({ scope: mocks.scope, sql: mocks.sql });
    await pending;
  });

  it("keeps the logged-out result and skips owner data on authentication failure", async () => {
    mocks.authenticate.mockRejectedValue(new ApiError("UNAUTHENTICATED", "Sign in", 401));
    expect((await page()).props.state).toEqual({ kind: "loggedOut" });
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.preference).not.toHaveBeenCalled();
  });

  it.each(["resume", "preference"] as const)("keeps the error state if %s fails", async key => {
    mocks[key].mockRejectedValue(new Error("database unavailable"));
    expect((await page()).props).toMatchObject({ state: { kind: "error" }, timeZone: "Asia/Shanghai" });
  });

  it("renders the pending start-page shell before the shared delayed loading announcement mounts", () => {
    const html = renderToStaticMarkup(createElement(TodayLoading));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-labelledby="today-loading-title"');
    expect(html).toMatch(/<h1\b[^>]*id="today-loading-title"[^>]*>开始<\/h1>/);
    // LoadingRows announces after its client-side delay; its timer and unmount
    // behavior are covered by the shared UI component's interaction tests.
    expect(html).not.toContain('role="status"');
  });
});
