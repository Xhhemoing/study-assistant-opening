import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../../../features/auth/service";
import OpeningTodayPage from "./page";
import TodayLoading from "./loading";
import { TodayDashboard } from "../../../../features/opening/planning/today-dashboard";
import { OpeningCapabilitiesContext } from "../../../../features/opening/capabilities/capabilities-provider";
import { CLOSED_CAPABILITIES } from "@aistudy/config/public";
import { assistantEntry } from "../../../../features/opening/assistant/assistant-entry";

function markup(result: Awaited<ReturnType<typeof OpeningTodayPage>>) {
  return renderToStaticMarkup(createElement(OpeningCapabilitiesContext.Provider, {
    value: { ...CLOSED_CAPABILITIES, teachingLoop: { api: true, ui: true } },
  }, result));
}

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(), authenticate: vi.fn(), resume: vi.fn(), preference: vi.fn(), reader: vi.fn(),
  scope: { workspaceId: "workspace", ownerUserId: "owner" }, sql: {},
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@aistudy/ai", () => ({ isTeachingCompilerEnabled: () => false }));

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
  it.each([
    { conversation: "conversation-a", ai: "1", extra: ["first", "second"] },
    { source: "11111111-1111-4111-8111-111111111111", version: "0", page: "3", fragment: "α + β", returnTo: "/opening/library" },
    { courseId: "11111111-1111-4111-8111-111111111111" },
    { version: "2" },
    { attemptId: "bad" },
    { context: "none", conversation: "ignored" },
    { conversation: ["conversation-a", "conversation-b"], label: ["保留首项", "次项"] },
  ])("canonicalizes legacy assistant intent without reading Today: %j", async query => {
    mocks.redirect.mockImplementation(() => { throw new Error("redirect"); });
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) value.forEach(item => params.append(key, item));
      else if (value !== undefined) params.append(key, value);
    }
    const expectedHref = `/opening/assistant?${params}`;
    const originalEntry = assistantEntry(expectedHref);
    expect(Boolean(originalEntry.conversation || originalEntry.context || originalEntry.error || originalEntry.fresh)).toBe(true);
    await expect(OpeningTodayPage({ searchParams: Promise.resolve(query) })).rejects.toThrow("redirect");
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith(expectedHref);
    expect(assistantEntry(mocks.redirect.mock.calls[0][0])).toEqual(originalEntry);
    if (query.version === "2" || query.attemptId === "bad") expect(originalEntry.error).toContain("已停止发送");
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it.each([{}, { ai: "1" }, { unrelated: "value" }])("keeps ordinary Today queries on the dashboard: %j", async query => {
    const result = await OpeningTodayPage({ searchParams: Promise.resolve(query) });
    expect(result.type).toBe(TodayDashboard);
    expect(markup(result)).toContain("今日学习");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it.each(["empty", "ready"])("renders %s with no courses as Today, preserving creation and mentor input", async kind => {
    mocks.resume.mockResolvedValue({ kind, courses: { status: "ready", items: [] } });
    const result = await page();
    expect(result.type).toBe(TodayDashboard);
    const html = markup(result);
    expect(html).toContain("今日学习");
    expect(html).toContain('href="/opening/courses/new"');
    expect(html).toContain("添加第一门课");
    expect(html).toContain('aria-label="向 AI 提问"');
    expect(html.match(/data-today-primary-cta="true"/g)).toHaveLength(1);
  });

  it.each(["task", "focusTask"])("redirects %s ahead of assistant intent", async key => {
    mocks.redirect.mockImplementation(() => { throw new Error("redirect"); });
    await expect(OpeningTodayPage({ searchParams: Promise.resolve({ [key]: "task /1", conversation: "old" }) })).rejects.toThrow("redirect");
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/opening/settings/planning?task=task%20%2F1");
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });
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

  it("keeps the one-click learning dashboard for an existing course", async () => {
    mocks.resume.mockResolvedValue({ kind: "ready", courses: { status: "ready", items: [{ id: "course", title: "线性代数", archivedAt: null }] } });
    const result = await page();
    expect(result.type).toBe(TodayDashboard);
    expect(result.props).toMatchObject({ state: { kind: "ready" }, teachingCompileEnabled: false });
    const html = markup(result);
    expect(html).toContain("线性代数");
    expect(html).toContain('href="/opening/courses/course/study"');
    expect(html.match(/data-today-primary-cta="true"/g)).toHaveLength(1);
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
    const result = await page();
    expect(result.type).toBe(TodayDashboard);
    expect(result.props.state).toEqual({ kind: "loggedOut" });
    expect(markup(result)).toContain("尚未登录");
    expect(markup(result)).toContain('href="/login"');
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.preference).not.toHaveBeenCalled();
  });

  it.each(["resume", "preference"] as const)("keeps the error state if %s fails", async key => {
    mocks[key].mockRejectedValue(new Error("database unavailable"));
    const result = await page();
    expect(result.type).toBe(TodayDashboard);
    expect(result.props).toMatchObject({ state: { kind: "error" }, timeZone: "Asia/Shanghai" });
    const html = markup(result);
    expect(html).toContain("学习记录暂时无法读取");
    expect(html).toContain("重新读取");
    expect(html).not.toContain("添加第一门课");
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
