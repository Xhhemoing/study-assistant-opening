import { afterEach, describe, expect, it, vi } from "vitest";
import { startPracticeSession } from "./practice-session-client";

const itemId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const publicItem = {
  id: itemId,
  contentVersion: 1,
  syllabusPointId: "33333333-3333-4333-8333-333333333333",
  kind: "short_answer" as const,
  stem: "导数的定义是什么？",
  abilitySlice: "recall" as const,
  estimatedMinutes: 5,
  availableHintCount: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startPracticeSession", () => {
  it("rejects a start payload that leaks answerRule", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            sessionId,
            item: { ...publicItem, answerRule: { type: "exact", accepted: ["极限"] } },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    await expect(startPracticeSession(itemId)).rejects.toThrow();
  });

  it("returns a public item and session id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ sessionId, item: publicItem }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(startPracticeSession(itemId)).resolves.toEqual({ sessionId, item: publicItem });
  });
});
