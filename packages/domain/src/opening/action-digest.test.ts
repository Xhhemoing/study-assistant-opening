import { describe, expect, it } from "vitest";
import {
  applySourceRevision,
  assertDigestHasNoMasteryPercentage,
  blockerToDigestCandidate,
  buildActionDigest,
  deltaTaskIdsForRevision,
  type DigestActionCandidate,
} from "./action-digest";

const base = (
  overrides: Partial<DigestActionCandidate> & Pick<DigestActionCandidate, "id" | "dedupeKey">,
): DigestActionCandidate => ({
  title: "作业",
  minutes: 30,
  dueAt: null,
  priority: 1,
  sourceIds: ["s"],
  status: "pending",
  needsConfirmation: true,
  ...overrides,
});

describe("buildActionDigest", () => {
  it("does not re-prompt a rejected suggestion", () => {
    const c = {
      id: "c",
      dedupeKey: "mail-1:deadline",
      title: "作业",
      minutes: 30,
      dueAt: null,
      priority: 1,
      sourceIds: ["s"],
      status: "rejected" as const,
      needsConfirmation: true,
    };
    expect(buildActionDigest([c])).toEqual({ primary: [], pendingConfirmationCount: 0 });
  });

  it("returns empty digest for an empty list", () => {
    expect(buildActionDigest([])).toEqual({ primary: [], pendingConfirmationCount: 0 });
  });

  it("omits accepted and superseded candidates", () => {
    const digest = buildActionDigest([
      base({ id: "a", dedupeKey: "k-a", status: "accepted" }),
      base({ id: "b", dedupeKey: "k-b", status: "superseded" }),
      base({ id: "c", dedupeKey: "k-c", title: "仍待确认", priority: 9 }),
    ]);
    expect(digest.primary.map((c) => c.id)).toEqual(["c"]);
    expect(digest.pendingConfirmationCount).toBe(1);
  });

  it("merges duplicate sources by dedupeKey without inventing a merge across keys", () => {
    const digest = buildActionDigest([
      base({
        id: "m1",
        dedupeKey: "mail-1:deadline",
        sourceIds: ["src-mail"],
        priority: 2,
        dueAt: "2026-09-20T12:00:00.000Z",
      }),
      base({
        id: "m2",
        dedupeKey: "mail-1:deadline",
        sourceIds: ["src-ding"],
        priority: 5,
        dueAt: "2026-09-18T12:00:00.000Z",
        title: "同一作业（钉钉重复）",
      }),
      base({
        id: "other",
        dedupeKey: "mail-2:other-hw",
        title: "另一份作业",
        sourceIds: ["src-other"],
        needsConfirmation: true,
        priority: 1,
      }),
    ]);
    expect(digest.primary).toHaveLength(2);
    const merged = digest.primary.find((c) => c.dedupeKey === "mail-1:deadline");
    expect(merged?.sourceIds.sort()).toEqual(["src-ding", "src-mail"]);
    expect(merged?.id).toBe("m2");
    expect(digest.primary.map((c) => c.dedupeKey)).toContain("mail-2:other-hw");
    expect(digest.pendingConfirmationCount).toBe(2);
  });

  it("keeps unclear cross-source duplicates as separate confirmation items", () => {
    const digest = buildActionDigest([
      base({ id: "a", dedupeKey: "mail:hw-a", title: "作业A", sourceIds: ["mail"] }),
      base({ id: "b", dedupeKey: "ding:hw-b", title: "作业B?", sourceIds: ["ding"] }),
    ]);
    expect(digest.primary).toHaveLength(2);
    expect(digest.pendingConfirmationCount).toBe(2);
  });

  it("caps primary at 3 while retaining full pendingConfirmationCount", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      base({
        id: `id-${i}`,
        dedupeKey: `key-${i}`,
        priority: i,
        needsConfirmation: true,
        dueAt: `2026-09-${String(10 + i).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    const digest = buildActionDigest(many);
    expect(digest.primary).toHaveLength(3);
    expect(digest.pendingConfirmationCount).toBe(5);
    expect(digest.primary.map((c) => c.id)).toEqual(["id-0", "id-1", "id-2"]);
  });

  it("sorts by due date then priority then id", () => {
    const digest = buildActionDigest([
      base({ id: "z", dedupeKey: "z", dueAt: null, priority: 99 }),
      base({ id: "b", dedupeKey: "b", dueAt: "2026-09-15T00:00:00.000Z", priority: 1 }),
      base({ id: "a", dedupeKey: "a", dueAt: "2026-09-15T00:00:00.000Z", priority: 1 }),
      base({ id: "c", dedupeKey: "c", dueAt: "2026-09-14T00:00:00.000Z", priority: 0 }),
    ]);
    expect(digest.primary.map((c) => c.id)).toEqual(["c", "a", "b"]);
    expect(digest.pendingConfirmationCount).toBe(4);
  });

  it("includes K02 blockers when mapped to candidates", () => {
    const blocker = blockerToDigestCandidate({
      id: "blocker-1",
      nodeId: "node-1",
      kind: "clarify",
      reason: "先澄清分数乘法卡点",
      evidenceIds: ["ev-1"],
      priority: 80,
    });
    const digest = buildActionDigest([blocker]);
    expect(digest.primary).toHaveLength(1);
    expect(digest.primary[0]?.dedupeKey).toBe("k02:node-1:clarify");
    expect(digest.pendingConfirmationCount).toBe(1);
    assertDigestHasNoMasteryPercentage({ ...digest.primary[0]! } as Record<string, unknown>);
  });

  it("rejected key suppresses a later pending duplicate", () => {
    const digest = buildActionDigest([
      base({ id: "old", dedupeKey: "mail-1:deadline", status: "rejected" }),
      base({ id: "again", dedupeKey: "mail-1:deadline", status: "pending" }),
    ]);
    expect(digest).toEqual({ primary: [], pendingConfirmationCount: 0 });
  });
});

describe("applySourceRevision", () => {
  it("supersedes prior pending and forces confirmation after accepted schedule", () => {
    const existing = [
      base({ id: "old", dedupeKey: "mail-1:deadline", status: "accepted", needsConfirmation: false }),
      base({ id: "stale", dedupeKey: "mail-1:deadline", status: "pending" }),
    ];
    const revised = base({
      id: "new",
      dedupeKey: "mail-1:deadline",
      title: "更正后的作业",
      needsConfirmation: false,
      sourceIds: ["src-v2"],
    });
    const next = applySourceRevision(existing, revised);
    expect(next.find((c) => c.id === "stale")?.status).toBe("superseded");
    expect(next.find((c) => c.id === "old")?.status).toBe("accepted");
    const pending = next.find((c) => c.id === "new");
    expect(pending?.status).toBe("pending");
    expect(pending?.needsConfirmation).toBe(true);
    const digest = buildActionDigest(next);
    expect(digest.primary.map((c) => c.id)).toEqual(["new"]);
  });
});

describe("deltaTaskIdsForRevision", () => {
  it("only returns task ids not already on the accepted schedule", () => {
    expect(
      deltaTaskIdsForRevision({
        previouslyAcceptedTaskIds: ["t1", "t2"],
        revisedCandidateTaskIds: ["t2", "t3"],
      }),
    ).toEqual(["t3"]);
  });
});
