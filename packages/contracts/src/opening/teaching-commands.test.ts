import { describe, expect, it } from "vitest";
import {
  TEACHING_BRANCH_STACK_MAX,
  TEACHING_COMMAND_LOG_MAX,
  isTeachingPathKind,
  isTeachingRewriteKind,
  teachingCommandConflictSchema,
  teachingCommandKindSchema,
  teachingCommandRequestSchema,
  teachingCommandResponseSchema,
  teachingCommandSuccessSchema,
} from "./teaching-commands";

const uuid = "11111111-1111-4111-8111-111111111111";
const uuid2 = "22222222-2222-4222-8222-222222222222";

describe("teaching-commands contracts (T1)", () => {
  it("accepts all 7 kinds and rejects unknown kind", () => {
    for (const kind of [
      "why",
      "rephrase",
      "expand",
      "example",
      "skip",
      "branch",
      "return",
    ] as const) {
      expect(teachingCommandKindSchema.parse(kind)).toBe(kind);
    }
    expect(teachingCommandKindSchema.safeParse("next").success).toBe(false);
    expect(teachingCommandKindSchema.safeParse("chat").success).toBe(false);
  });

  it("rejects short clientKey and missing expectedVersion", () => {
    expect(
      teachingCommandRequestSchema.safeParse({
        clientKey: "short",
        kind: "skip",
        blockId: uuid,
        expectedVersion: 0,
      }).success,
    ).toBe(false);
    expect(
      teachingCommandRequestSchema.safeParse({
        clientKey: "long-enough-key",
        kind: "skip",
        blockId: uuid,
      }).success,
    ).toBe(false);
  });

  it("requires blockId except for return", () => {
    expect(
      teachingCommandRequestSchema.safeParse({
        clientKey: "long-enough-key",
        kind: "why",
        expectedVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      teachingCommandRequestSchema.parse({
        clientKey: "long-enough-key",
        kind: "return",
        expectedVersion: 1,
      }).kind,
    ).toBe("return");
    expect(
      teachingCommandRequestSchema.parse({
        clientKey: "long-enough-key",
        kind: "rephrase",
        blockId: uuid,
        expectedVersion: 2,
        prompt: "simpler",
      }).prompt,
    ).toBe("simpler");
  });

  it("rejects unknown request keys (strict)", () => {
    expect(
      teachingCommandRequestSchema.safeParse({
        clientKey: "long-enough-key",
        kind: "skip",
        blockId: uuid,
        expectedVersion: 0,
        blocksPatch: [{ html: "<b>x</b>" }],
      }).success,
    ).toBe(false);
  });

  it("parses success / conflict response union", () => {
    const ok = teachingCommandSuccessSchema.parse({
      ok: true,
      kind: "skip",
      activityId: uuid,
      contentVersion: 3,
      pathVersion: 2,
      checkpointJson: { skippedBlockIds: [uuid2] },
      replayed: false,
    });
    expect(ok.ok).toBe(true);
    const conflict = teachingCommandConflictSchema.parse({
      ok: false,
      conflict: "stale_content_version",
      message: "reread clientInit",
      currentContentVersion: 4,
      currentPathVersion: 2,
    });
    expect(conflict.conflict).toBe("stale_content_version");
    expect(teachingCommandResponseSchema.parse(ok).ok).toBe(true);
    expect(teachingCommandResponseSchema.parse(conflict).ok).toBe(false);
  });

  it("classifies rewrite vs path kinds and ring caps", () => {
    expect(isTeachingRewriteKind("rephrase")).toBe(true);
    expect(isTeachingRewriteKind("why")).toBe(false);
    expect(isTeachingPathKind("skip")).toBe(true);
    expect(isTeachingPathKind("example")).toBe(false);
    expect(TEACHING_COMMAND_LOG_MAX).toBe(32);
    expect(TEACHING_BRANCH_STACK_MAX).toBe(16);
  });
});
