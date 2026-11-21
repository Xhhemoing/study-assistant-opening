// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WeekSession } from "@aistudy/contracts";
import { TimetableImport } from "./timetable-import";
import { parseTimetableFile } from "./xlsx-reader";

vi.mock("./xlsx-reader", () => ({ parseTimetableFile: vi.fn() }));

const sessions = [
  { courseName: "物理2", weeks: [1, 2], weekday: 3, startPeriod: 1, endPeriod: 2 },
  { courseName: "数学", weeks: [2], weekday: 1, startPeriod: 1, endPeriod: 2 },
];
const baseline = { sessions: [], revision: "empty" };
const newer = { sessions: [{ ...sessions[0]!, courseName: "历史" }], revision: "newer" };
const committed = { sessions: [...sessions].reverse().map(s => ({ ...s, courseId: null })), revision: "saved" };
const fetcher = vi.fn<typeof fetch>();
const host = document.createElement("div");
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher.mockReset().mockResolvedValueOnce(Response.json(baseline)));
  vi.mocked(parseTimetableFile).mockReset().mockResolvedValue({ sessions, warnings: [], raw: [] });
  root = createRoot(host);
  await act(async () => root.render(<TimetableImport />));
  const input = host.querySelector("input")!;
  Object.defineProperty(input, "files", { value: [new File([], "课表.xlsx")] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const confirm = () => host.querySelector("button")!;
const click = () => act(async () => confirm().click());
const writes = () => fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")
  .map(([, init]) => JSON.parse(String(init?.body)));

it("recognizes a committed import after losing its response", async () => {
  fetcher.mockRejectedValueOnce(new TypeError("connection lost")).mockResolvedValueOnce(Response.json(committed));
  await click();
  expect(host.querySelector('[role="status"]')?.textContent).toContain("已保存 2 条");
  expect(confirm()).toBeNull();
  expect(writes()).toEqual([{ sessions, expectedRevision: "empty" }]);
});

it("blocks the stale preview when a different timetable was imported", async () => {
  fetcher.mockRejectedValueOnce(new TypeError("connection lost")).mockResolvedValueOnce(Response.json(newer));
  await click();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("课表已更新");
  expect(confirm()).toBeNull();
  expect(writes()).toHaveLength(1);
});

it("only reads after failed reconciliation until it can verify the baseline", async () => {
  fetcher.mockRejectedValueOnce(new TypeError("connection lost")).mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(Response.json(baseline));
  await click();
  expect(confirm().textContent).toBe("核对保存结果");
  await click();
  expect(confirm().textContent).toBe("确认加入课表");
  expect(writes()).toHaveLength(1);

  // The other tab wins between reconciliation and confirmation.
  fetcher.mockResolvedValueOnce(Response.json({}, { status: 409 })).mockResolvedValueOnce(Response.json(newer));
  await click();
  expect(writes()).toEqual(Array(2).fill({ sessions, expectedRevision: "empty" }));
  expect(confirm()).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("课表已更新");
});

it("retries once against the original baseline when nothing was committed", async () => {
  let finish!: (rows: WeekSession[]) => void;
  fetcher.mockRejectedValueOnce(new TypeError("connection lost")).mockResolvedValueOnce(Response.json(baseline))
    .mockImplementationOnce(() => new Promise(resolve => { finish = rows => resolve(Response.json({ sessions: rows })); }));
  await click();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => { confirm().click(); confirm().click(); });
  expect(writes()).toEqual(Array(2).fill({ sessions, expectedRevision: "empty" }));
  expect(confirm().disabled).toBe(true);
  await act(async () => finish(sessions));
  expect(host.querySelector('[role="status"]')?.textContent).toContain("已保存 2 条");
  expect(parseTimetableFile).toHaveBeenCalledOnce();
});
