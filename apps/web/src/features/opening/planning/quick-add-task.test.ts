import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OpeningApiError } from "../client/api";
import {
  buildQuickAddInput,
  createQuickAddAttempt,
  dueWithinDayLabel,
  QuickAddTask,
  QUICK_ADD_DEFAULT_MINUTES,
  resolveQuickAddDueAt,
} from "./quick-add-task";

describe("resolveQuickAddDueAt", () => {
  it("returns null when no date is set (does not invent a deadline)", () => {
    expect(resolveQuickAddDueAt("", "")).toBeNull();
    expect(resolveQuickAddDueAt("  ", "")).toBeNull();
  });

  it("uses local end-of-day 23:59 when only a date is chosen", () => {
    const iso = resolveQuickAddDueAt("2026-10-09", "");
    expect(iso).toBeTruthy();
    const local = new Date(iso!);
    expect(local.getHours()).toBe(23);
    expect(local.getMinutes()).toBe(59);
    expect(local.getFullYear()).toBe(2026);
    expect(local.getMonth()).toBe(9);
    expect(local.getDate()).toBe(9);
  });

  it("uses the local date and time when both are set", () => {
    const iso = resolveQuickAddDueAt("2026-10-09", "14:30");
    const local = new Date(iso!);
    expect(local.getHours()).toBe(14);
    expect(local.getMinutes()).toBe(30);
  });
});

describe("dueWithinDayLabel", () => {
  it("is true only for date-only deadlines", () => {
    expect(dueWithinDayLabel("2026-10-09", "")).toBe(true);
    expect(dueWithinDayLabel("2026-10-09", "14:30")).toBe(false);
    expect(dueWithinDayLabel("", "")).toBe(false);
  });
});

describe("buildQuickAddInput", () => {
  it("builds a candidate-free create body with clientKey and default priority", () => {
    const input = buildQuickAddInput(
      { title: "  整理错题  ", minutes: QUICK_ADD_DEFAULT_MINUTES, dueDate: "", dueTime: "" },
      "quick-add-test-key-01",
    );
    expect(input).toEqual({
      title: "整理错题",
      minutes: 25,
      dueAt: null,
      priority: 1,
      candidateId: null,
      clientKey: "quick-add-test-key-01",
    });
  });

  it("rejects an empty title", () => {
    expect(() => buildQuickAddInput(
      { title: "   ", minutes: 25, dueDate: "", dueTime: "" },
      "quick-add-test-key-01",
    )).toThrow(/任务名称/);
  });
});

describe("createQuickAddAttempt", () => {
  const draft = { title: "练习", minutes: 25 as const, dueDate: "", dueTime: "" };

  it("reuses the same clientKey when the same intent is submitted again after an unknown outcome", async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new OpeningApiError(503, "upstream"))
      .mockResolvedValueOnce({
        id: "11111111-1111-4111-8111-111111111111",
        title: "练习",
        minutes: 25,
        dueAt: null,
        priority: 1,
        status: "pending" as const,
        version: 1,
      });
    const attempt = createQuickAddAttempt(create, () => "quick-add-fixed-key");
    expect(await attempt.submit(draft)).toEqual({ kind: "unknown" });
    expect(attempt.clientKey()).toBe("quick-add-fixed-key");
    expect(await attempt.submit(draft)).toEqual({
      kind: "created",
      task: expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]![0].clientKey).toBe("quick-add-fixed-key");
    expect(create.mock.calls[1]![0].clientKey).toBe("quick-add-fixed-key");
    expect(create.mock.calls[0]![0].candidateId).toBeNull();
  });

  it("clears the clientKey after a validation failure so a corrected payload is a new intent", async () => {
    let n = 0;
    const mint = () => `quick-add-key-${++n}`;
    const create = vi.fn()
      .mockRejectedValueOnce(new OpeningApiError(422, "invalid title"))
      .mockResolvedValueOnce({
        id: "11111111-1111-4111-8111-111111111111",
        title: "练习",
        minutes: 25,
        dueAt: null,
        priority: 1,
        status: "pending" as const,
        version: 1,
      });
    const attempt = createQuickAddAttempt(create, mint);
    expect(await attempt.submit(draft)).toEqual({ kind: "failed", message: "invalid title" });
    expect(await attempt.submit(draft)).toEqual({
      kind: "created",
      task: expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
    });
    expect(create.mock.calls[0]![0].clientKey).toBe("quick-add-key-1");
    expect(create.mock.calls[1]![0].clientKey).toBe("quick-add-key-2");
  });

  it("mints a fresh clientKey after a successful create", async () => {
    let n = 0;
    const mint = () => `quick-add-ok-${++n}`;
    const create = vi.fn().mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      title: "练习",
      minutes: 25,
      dueAt: null,
      priority: 1,
      status: "pending" as const,
      version: 1,
    });
    const attempt = createQuickAddAttempt(create, mint);
    await attempt.submit(draft);
    await attempt.submit(draft);
    expect(create.mock.calls[0]![0].clientKey).toBe("quick-add-ok-1");
    expect(create.mock.calls[1]![0].clientKey).toBe("quick-add-ok-2");
  });

  it("ignores overlapping submits while one request is in flight", async () => {
    let release: (() => void) | null = null;
    const create = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return {
        id: "11111111-1111-4111-8111-111111111111",
        title: "练习",
        minutes: 25,
        dueAt: null,
        priority: 1,
        status: "pending" as const,
        version: 1,
      };
    });
    const attempt = createQuickAddAttempt(create, () => "quick-add-inflight");
    const first = attempt.submit(draft);
    await Promise.resolve();
    expect(await attempt.submit(draft)).toBeNull();
    release?.();
    expect(await first).toMatchObject({ kind: "created" });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("QuickAddTask", () => {
  it("starts collapsed behind a Chinese quick-add affordance", () => {
    const html = renderToStaticMarkup(createElement(QuickAddTask, {
      api: { createTask: async () => { throw new Error("unused"); } },
    }));
    expect(html).toContain("快速添加任务");
    expect(html).not.toContain('aria-label="快速添加任务"');
  });
});
