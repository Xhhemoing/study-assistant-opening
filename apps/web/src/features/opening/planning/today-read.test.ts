import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveTodayResume, todayConfirmHref } from "./today-read";

const lastConversation = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "线性代数答疑",
  lastUserText: "如何判断矩阵可逆？",
};

describe("resolveTodayResume", () => {
  it("returns loggedOut when there is no session", () => {
    expect(resolveTodayResume({ hasSession: false, loadFailed: false })).toEqual({
      kind: "loggedOut",
    });
  });

  it("returns error when loading failed", () => {
    expect(resolveTodayResume({ hasSession: true, loadFailed: true })).toEqual({
      kind: "error",
    });
  });

  it("returns empty when there is no conversation or pending confirmation", () => {
    expect(resolveTodayResume({ hasSession: true, loadFailed: false })).toEqual({
      kind: "empty",
    });
  });

  it("returns confirm when pending confirmations exist", () => {
    expect(
      resolveTodayResume({
        hasSession: true,
        loadFailed: false,
        pendingConfirmations: 2,
      }),
    ).toEqual({ kind: "confirm", confirmCount: 2 });
  });

  it("returns continue with material versions and reading position", () => {
    expect(
      resolveTodayResume({
        hasSession: true,
        loadFailed: false,
        lastConversation: {
          ...lastConversation,
          courseId: "22222222-2222-4222-8222-222222222222",
          sourceVersions: { "33333333-3333-4333-8333-333333333333": 4 },
          currentPage: 7,
        },
      }),
    ).toEqual({
      kind: "continue",
      continueItem: {
        conversationId: lastConversation.id,
        title: lastConversation.title,
        lastUserText: lastConversation.lastUserText,
        courseId: "22222222-2222-4222-8222-222222222222",
        sourceVersions: { "33333333-3333-4333-8333-333333333333": 4 },
        currentPage: 7,
      },
    });
  });

  it("prefers confirm over continue but keeps the continue item", () => {
    const state = resolveTodayResume({
      hasSession: true,
      loadFailed: false,
      lastConversation,
      pendingConfirmations: 1,
    });
    expect(state.kind).toBe("confirm");
    expect(state.confirmCount).toBe(1);
    expect(state.continueItem?.conversationId).toBe(lastConversation.id);
  });

  it("prefers error over empty", () => {
    expect(resolveTodayResume({ hasSession: true, loadFailed: true }).kind).toBe(
      "error",
    );
  });

  it("prefers error over continue", () => {
    expect(
      resolveTodayResume({
        hasSession: true,
        loadFailed: true,
        lastConversation,
      }).kind,
    ).toBe("error");
  });

  it("prefers loggedOut over error", () => {
    expect(
      resolveTodayResume({ hasSession: false, loadFailed: true }).kind,
    ).toBe("loggedOut");
  });
});

describe("today page wiring", () => {
  const page = readFileSync(new URL("../../../app/(opening)/opening/today/page.tsx", import.meta.url), "utf8");

  it("loads resume through the owner reader instead of listing conversations", () => {
    expect(page).toContain("loadTodayResumeState");
    expect(page).toContain("createTodayResumeReader(sql)");
    expect(page).not.toContain("getTutorService");
    expect(page).not.toContain("listConversations");
  });

  it("shows one primary action and the real continue facts", () => {
    expect(page).toContain("现在可以做什么");
    expect(page).toContain("assistant?conversation=");
    expect(page).toContain("courseId");
    expect(page).toContain("sourceVersions");
    expect(page).toContain("currentPage");
    for (const branch of page.split("if (state.kind").slice(1)) {
      const body = branch.split("return (")[1]?.split("if (state.kind")[0] ?? "";
      expect(body.match(/bg-indigo-600/g)?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });
});

describe("todayConfirmHref", () => {
  it("points a memory payload at the candidate memory decision route", () => {
    expect(todayConfirmHref([{ id: "m1", payload: { kind: "memory" } }])).toBe(
      "/api/opening/candidates/m1/memory-decision",
    );
  });

  it("points a task payload at the retest accept route", () => {
    expect(todayConfirmHref([{ id: "t1", payload: { kind: "task" } }])).toBe(
      "/api/opening/retests/t1/accept",
    );
  });

  it("does not pick a dead link when task and memory payloads are mixed", () => {
    expect(
      todayConfirmHref([
        { id: "m1", payload: { kind: "memory" } },
        { id: "t1", payload: { kind: "task" } },
      ]),
    ).toBe("/api/opening/candidates");
  });
});
