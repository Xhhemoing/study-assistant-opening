import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PR-B component-level zone test: the browser/process zone (America/Los_Angeles)
 * differs from the workspace zone (Asia/Shanghai). At 2026-10-12T16:30Z it is
 * 10-12 09:30 in LA but 10-13 00:30 in Shanghai; Today must read the 13th.
 *
 * No DOM library is installed, so effects are captured during SSR and invoked
 * afterwards to observe which date TodayPlanView requests from the API.
 */
const effects: Array<() => unknown> = [];
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, useEffect: (fn: () => unknown) => { effects.push(fn); } };
});

const INSTANT = new Date("2026-10-12T16:30:00.000Z");
let originalTz: string | undefined;

beforeEach(() => {
  effects.length = 0;
  originalTz = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(INSTANT);
  // Captured effects run under Node; the retest clock effect only needs inert window timers.
  vi.stubGlobal("window", { setInterval: () => 0, clearInterval: () => {}, addEventListener: () => {}, removeEventListener: () => {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;
});

function fakeApi() {
  return {
    listTasks: vi.fn(async () => ({ tasks: [] })),
    getToday: vi.fn(async (date: string) => ({ date, acceptedVersion: 0, blocks: [], hardBlocks: [] })),
    listReminders: vi.fn(async () => ({ reminders: [] })),
  };
}

async function requestedDate(props: Record<string, unknown>) {
  const { TodayPlanView } = await import("./today-view");
  const api = fakeApi();
  renderToStaticMarkup(createElement(TodayPlanView, { api: api as never, ...props }));
  for (const fn of effects) fn();
  await Promise.resolve();
  return api.getToday.mock.calls[0]?.[0];
}

describe("TodayPlanView uses the workspace zone, not the browser zone", () => {
  it("sanity: browser-local date is the 12th at this instant", async () => {
    const { localDateKey } = await import("./today-view");
    expect(localDateKey(new Date())).toBe("2026-10-12");
  });

  it("workspace Asia/Shanghai -> requests 2026-10-13", async () => {
    expect(await requestedDate({ timeZone: "Asia/Shanghai" })).toBe("2026-10-13");
  });

  it("no zone supplied -> workspace default Asia/Shanghai, never the browser zone", async () => {
    expect(await requestedDate({})).toBe("2026-10-13");
  });

  it("workspace America/New_York -> requests 2026-10-12", async () => {
    expect(await requestedDate({ timeZone: "America/New_York" })).toBe("2026-10-12");
  });

  it("invalid workspace zone fails explicitly", async () => {
    await expect(requestedDate({ timeZone: "Mars/Olympus_Mons" })).rejects.toBeInstanceOf(RangeError);
  });
});
