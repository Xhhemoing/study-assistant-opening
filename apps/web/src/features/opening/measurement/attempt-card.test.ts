import type { MeasurementAttempt } from "@aistudy/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MeasurementAttemptCard } from "./attempt-card";

const attempt = {
  id: "attempt", ordinal: 1, helpEvents: [], feedback: null,
  item: { phase: "practice", skillLabel: "选法", prompt: "如何选取 u？", options: [{ id: "A", label: "x" }, { id: "B", label: "1" }] },
} as unknown as MeasurementAttempt;

describe("measurement answer controls", () => {
  it("offers practice help and an explicit report of outside help", () => {
    const html = renderToStaticMarkup(createElement(MeasurementAttemptCard, { attempt, busy: false, onAction: vi.fn() }));
    expect(html).toContain("给我提示");
    expect(html).toContain("查看解析");
    expect(html).toContain("我看过相关答案");
    expect(html).toContain('type="radio"');
    expect(html).toContain("提交答案");
  });
  it("withholds hint and solution controls for a delayed independent probe", () => {
    const delayed = { ...attempt, item: { ...attempt.item, phase: "delay_48h" as const } };
    const html = renderToStaticMarkup(createElement(MeasurementAttemptCard, { attempt: delayed, busy: false, onAction: vi.fn() }));
    expect(html).not.toContain("给我提示");
    expect(html).not.toContain("查看解析");
    expect(html).toContain("3 题均提交或跳过后");
    expect(html).toContain("我看过相关答案");
  });
});
