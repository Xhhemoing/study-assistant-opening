import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WeekSession } from "@aistudy/contracts";
import {
  cancelTimetablePreview,
  confirmTimetableImport,
  previewSessionRows,
  TimetableImport,
} from "./timetable-import";
import { parseTimetableSheets } from "./xlsx-reader";

const sampleSessions: WeekSession[] = [
  {
    courseName: "线性代数",
    weekday: 1,
    weeks: [1, 2, 3],
    startPeriod: 1,
    endPeriod: 2,
  },
];

describe("cancelTimetablePreview", () => {
  it("returns idle without writing", () => {
    expect(cancelTimetablePreview()).toEqual({ phase: "idle" });
  });
});

describe("confirmTimetableImport", () => {
  it("writes timetable only when confirm is called", async () => {
    const put = vi.fn(async (sessions: WeekSession[]) => sessions);
    const result = await confirmTimetableImport(sampleSessions, put);
    expect(result).toEqual({ ok: true, sessions: sampleSessions });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(sampleSessions);
  });

  it("does not call put when only canceling preview", () => {
    const put = vi.fn();
    cancelTimetablePreview();
    expect(put).not.toHaveBeenCalled();
  });

  it("surfaces put failures without claiming saved", async () => {
    const put = vi.fn(async () => {
      throw new Error("network");
    });
    expect(await confirmTimetableImport(sampleSessions, put)).toEqual({
      ok: false,
      message: "network",
    });
  });
});

describe("previewSessionRows", () => {
  it("labels week/weekday/period for preview", () => {
    expect(previewSessionRows(sampleSessions)).toEqual([
      {
        courseName: "线性代数",
        weekdayLabel: "周一",
        weeksLabel: "1-3 周",
        periodLabel: "第 1–2 节",
      },
    ]);
  });
});

describe("parseTimetableSheets for import preview", () => {
  it("builds preview sessions from synthetic sheets without uploading", () => {
    const parsed = parseTimetableSheets([
      {
        sheet: "Sheet1",
        data: [
          ["课程", "星期", "周次", "节"],
          ["物理(1-2周) 3-4节", "周三", null, null],
        ],
      },
    ]);
    expect(parsed.sessions[0]).toMatchObject({
      courseName: "物理",
      weekday: 3,
      startPeriod: 3,
      endPeriod: 4,
    });
  });
});

describe("TimetableImport", () => {
  it("renders Chinese import affordance and does not auto-confirm", () => {
    const put = vi.fn(async (sessions: WeekSession[]) => sessions);
    const html = renderToStaticMarkup(createElement(TimetableImport, { put }));
    expect(html).toContain("导入课表");
    expect(html).toContain("确认后才写入课表");
    expect(html).toContain("原始文件不会上传");
    expect(put).not.toHaveBeenCalled();
  });
});
