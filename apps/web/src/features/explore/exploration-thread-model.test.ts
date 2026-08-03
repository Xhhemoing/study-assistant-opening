import { describe, expect, it } from "vitest";
import type { ChatTurn } from "@aistudy/contracts";
import type { ExplorationMessageResult } from "../../lib/data/types";
import {
  appendMessageTurns,
  getRoleLabel,
  shouldSendOnEnter,
} from "./exploration-thread-model";

const userTurn: ChatTurn = {
  id: "11111111-1111-4111-8111-111111111111",
  explorationId: "22222222-2222-4222-8222-222222222222",
  author: "user",
  aiRole: null,
  content: "问题",
  simulated: false,
  createdAt: "2026-08-02T08:00:00.000Z",
};

const aiTurn: ChatTurn = {
  ...userTurn,
  id: "33333333-3333-4333-8333-333333333333",
  author: "ai",
  aiRole: "explainer",
  content: "解释",
  simulated: true,
};

describe("exploration thread model", () => {
  it("only submits an unmodified Enter key", () => {
    expect(shouldSendOnEnter("Enter", false)).toBe(true);
    expect(shouldSendOnEnter("Enter", true)).toBe(false);
    expect(shouldSendOnEnter("Tab", false)).toBe(false);
  });

  it("appends the user turn before an optional AI turn", () => {
    const result: ExplorationMessageResult = { userTurn, aiTurn, candidate: null };
    expect(appendMessageTurns([], result)).toEqual([userTurn, aiTurn]);
    expect(appendMessageTurns([userTurn], { ...result, aiTurn: null })).toEqual([userTurn, userTurn]);
  });

  it("exposes a stable Chinese label for every role", () => {
    expect(getRoleLabel("challenger")).toBe("质疑");
    expect(getRoleLabel("silent")).toBe("静默");
  });
});
