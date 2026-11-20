// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { WeekSession } from "@aistudy/contracts";
import { TimetableImport } from "./timetable-import";
import { parseTimetableFile } from "./xlsx-reader";

vi.mock("./xlsx-reader", () => ({ parseTimetableFile: vi.fn() }));

it("retries the same preview after a save error and sends once while saving", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const sessions = [{ courseName: "物理2", weeks: [1, 2], weekday: 3, startPeriod: 1, endPeriod: 2 }];
  vi.mocked(parseTimetableFile).mockResolvedValue({ sessions, warnings: [], raw: [] });
  let finish!: (rows: WeekSession[]) => void;
  const put = vi.fn<() => Promise<WeekSession[]>>().mockRejectedValueOnce(new Error("保存失败"))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<TimetableImport put={put} />));
    const input = host.querySelector("input")!;
    Object.defineProperty(input, "files", { value: [new File([], "课表.xlsx")] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    const confirm = host.querySelector("button")!;
    await act(async () => confirm.click());
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => { confirm.click(); confirm.click(); });
    expect(put.mock.calls).toEqual([[sessions], [sessions]]);
    expect(confirm.disabled).toBe(true);
    await act(async () => finish(sessions));
    expect(host.querySelector('[role="status"]')?.textContent).toContain("已保存 1 条");
    expect(parseTimetableFile).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
