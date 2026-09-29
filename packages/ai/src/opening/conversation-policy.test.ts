import { describe, expect, it } from "vitest";
import type { EphemeralTurnInput, TutorMode } from "@aistudy/contracts";
import {
  assertEphemeralInput,
  canProposeTask,
  ConversationPolicyError,
  EPHEMERAL_HISTORY_MAX_CHARS,
  EPHEMERAL_HISTORY_MAX_TURNS,
  stripEphemeralCandidates,
} from "./conversation-policy";

const uuid = "00000000-0000-4000-8000-000000000001";

function input(overrides: Partial<EphemeralTurnInput> = {}): EphemeralTurnInput {
  return {
    text: "I am tired",
    sourceIds: [],
    mode: "listen",
    history: [],
    ...overrides,
  };
}

describe("conversation policy", () => {
  it("does not turn listening into a task generator", () => {
    expect(canProposeTask("listen")).toBe(false);
    expect(canProposeTask("think_together")).toBe(true);
    expect(canProposeTask("hint")).toBe(false);
    expect(canProposeTask("explain")).toBe(false);
  });

  it("rejects history over 16 turns or 24000 characters", () => {
    expect(() => assertEphemeralInput(input())).not.toThrow();
    expect(EPHEMERAL_HISTORY_MAX_TURNS).toBe(16);
    expect(EPHEMERAL_HISTORY_MAX_CHARS).toBe(24_000);

    const turns = Array.from({ length: 17 }, () => ({
      role: "user" as const,
      text: "ok",
    }));
    expect(() => assertEphemeralInput(input({ history: turns }))).toThrow(
      ConversationPolicyError,
    );
    expect(() => assertEphemeralInput(input({ history: turns }))).toThrow(
      /16/,
    );

    const huge = Array.from({ length: 2 }, () => ({
      role: "user" as const,
      text: "x".repeat(12_001),
    }));
    expect(() => assertEphemeralInput(input({ history: huge }))).toThrow(
      /24000|24,000/,
    );
    const exact = Array.from({ length: 2 }, () => ({
      role: "user" as const,
      text: "x".repeat(12_000),
    }));
    expect(() => assertEphemeralInput(input({ history: exact }))).not.toThrow();
  });

  it("requires strict role and text on every history turn", () => {
    expect(() =>
      assertEphemeralInput(
        input({
          history: [{ role: "system" as "user", text: "hidden" }],
        }),
      ),
    ).toThrow(ConversationPolicyError);
    expect(() =>
      assertEphemeralInput(
        input({
          history: [{ role: "user", text: "" }],
        }),
      ),
    ).toThrow(ConversationPolicyError);
    expect(() =>
      assertEphemeralInput({
        ...input(),
        history: [{ role: "user", text: "ok", extra: true } as never],
      }),
    ).toThrow(ConversationPolicyError);
  });

  it("rejects empty text and non-uuid source ids", () => {
    expect(() => assertEphemeralInput(input({ text: "" }))).toThrow(
      ConversationPolicyError,
    );
    expect(() => assertEphemeralInput(input({ text: "   " }))).toThrow(
      ConversationPolicyError,
    );
    expect(() =>
      assertEphemeralInput(input({ sourceIds: ["not-a-source"] })),
    ).toThrow(ConversationPolicyError);
    expect(() =>
      assertEphemeralInput(input({ sourceIds: [uuid] })),
    ).not.toThrow();
  });

  it("strips every candidate even when think_together could propose one", () => {
    const mode: TutorMode = "think_together";
    expect(canProposeTask(mode)).toBe(true);
    const stripped = stripEphemeralCandidates({
      text: "let us think",
      citedChunkIds: [uuid],
      requestId: "req-1",
      candidates: [
        { kind: "task", title: "review", minutes: 10, dueText: null },
        { kind: "memory", text: "likes hints", temporary: true },
      ],
      inputTokens: 3,
      outputTokens: 2,
    });
    expect(stripped.candidates).toEqual([]);
    expect(stripped.text).toBe("let us think");
    expect(stripped.citedChunkIds).toEqual([uuid]);
  });
});

it("accepts a syntactically valid receipt while rejecting malformed client provenance", () => {
  expect(() => assertEphemeralInput(input({ history: [{ role: "assistant", text: "prior", provenanceId: uuid }] }))).not.toThrow();
  expect(() => assertEphemeralInput(input({ history: [{ role: "assistant", text: "prior", provenanceId: "not-a-receipt" }] }))).toThrow(ConversationPolicyError);
  expect(() => assertEphemeralInput({ ...input(), history: [{ role: "assistant", text: "prior", provenanceId: uuid, sourceRefs: [] }] })).toThrow(ConversationPolicyError);
});
