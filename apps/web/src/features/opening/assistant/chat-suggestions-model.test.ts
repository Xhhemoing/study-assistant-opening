import { describe, it, expect } from "vitest";
import type { AssistantCandidateRecord } from "@aistudy/contracts";
import { chatCandidateItems } from "./chat-suggestions-model";
describe("chat suggestions", () => {
  it("only returns pending suggestions from visible persisted turns", () => {
    const rows = [ { id: "a", sourceTurnId: "turn1", status: "pending" }, { id: "b", sourceTurnId: "turn2", status: "pending" },
      { id: "c", sourceTurnId: "turn1", status: "accepted" } ] as AssistantCandidateRecord[];
    expect(chatCandidateItems(rows, ["turn1"]).map(row => row.id)).toEqual(["a"]);
    expect(chatCandidateItems(rows, [])).toEqual([]);
  });
});
