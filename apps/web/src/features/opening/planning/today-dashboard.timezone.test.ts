import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PR-B component-level zone test for TodayDashboard: it must hand the
 * workspace zone (server-resolved) to TodayPlanView even when the browser
 * zone differs, and fall back to the workspace default (Asia/Shanghai).
 */
const planViewProps: Array<Record<string, unknown>> = [];
vi.mock("./today-view", async () => {
  const actual = await vi.importActual<typeof import("./today-view")>("./today-view");
  return { ...actual, TodayPlanView: (props: Record<string, unknown>) => { planViewProps.push(props); return null; } };
});

// 冷启动导入（整页依赖图）与时区逻辑无关，预热后各用例只测渲染，避免慢机器上首个用例超时。
beforeAll(async () => { await import("./today-dashboard"); }, 30_000);

let originalTz: string | undefined;
beforeEach(() => {
  planViewProps.length = 0;
  originalTz = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
});
afterEach(() => { if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz; });

async function render(timeZone?: string) {
  const { TodayDashboard } = await import("./today-dashboard");
  renderToStaticMarkup(createElement(TodayDashboard, {
    state: { kind: "ready" },
    api: {} as never,
    teachingWorkspaceEnabled: false,
    teachingLoopEnabled: false,
    teachingLoopTrialEnabled: false,
    ...(timeZone ? { timeZone } : {}),
  }));
  return planViewProps.at(-1);
}

describe("TodayDashboard passes the workspace zone to TodayPlanView", () => {
  it("explicit workspace zone wins over the browser zone", async () => {
    expect((await render("Asia/Shanghai"))?.timeZone).toBe("Asia/Shanghai");
  });

  it("missing zone -> Asia/Shanghai default, not the browser's America/Los_Angeles", async () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("America/Los_Angeles");
    expect((await render())?.timeZone).toBe("Asia/Shanghai");
  });

  it("another valid workspace zone is passed through", async () => {
    expect((await render("America/New_York"))?.timeZone).toBe("America/New_York");
  });
});
