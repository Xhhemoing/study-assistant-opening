/**
 * P04 action-digest durable overlay (migration 0052 opening_action_digest_decisions).
 * Experience swaps createInMemoryActionCandidateStore → createOpeningActionDigestDecisionsRepository(sql).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ActionCandidate } from "@aistudy/contracts";
import { buildActionDigest } from "@aistudy/domain";
import { createOpeningActionDigestDecisionsRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const enabled =
  process.env.OPENING_TEST_DB === "1" && Boolean(process.env.OPENING_TEST_DATABASE_URL);

let f: OpeningFixture;

function candidate(overrides: Partial<ActionCandidate> = {}): ActionCandidate {
  return {
    id: overrides.id ?? randomUUID(),
    dedupeKey: overrides.dedupeKey ?? "p04:math:hw",
    title: overrides.title ?? "Finish chapter exercises",
    minutes: overrides.minutes ?? 40,
    dueAt: overrides.dueAt === undefined ? "2026-10-12T08:00:00.000Z" : overrides.dueAt,
    priority: overrides.priority ?? 70,
    sourceIds: overrides.sourceIds ?? [],
    status: overrides.status ?? "pending",
    needsConfirmation: overrides.needsConfirmation ?? true,
  };
}

async function seedConnection(state: "ready" | "revoked" = "ready") {
  const id = randomUUID();
  await f.sql`INSERT INTO opening_connections
    (id, workspace_id, owner_user_id, version, kind, label, state, create_client_key)
    VALUES (${id}, ${f.scope.workspaceId}, ${f.scope.ownerUserId}, 1, 'imap', 'Digest mail', ${state}, ${"ck-" + id})`;
  return id;
}

async function seedSourceWithReceipt(connectionId: string) {
  const sourceId = randomUUID();
  const receiptId = randomUUID();
  await f.sql`INSERT INTO opening_sources
    (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
    VALUES (${sourceId}, ${f.scope.workspaceId}, 'digest.pdf', 'application/pdf', 1, ${"a".repeat(64)}, 0, 'uploaded', 'ready')`;
  await f.sql`INSERT INTO opening_import_receipts
    (id, workspace_id, owner_user_id, connection_id, connection_version, identity_key, source_id)
    VALUES (${receiptId}, ${f.scope.workspaceId}, ${f.scope.ownerUserId}, ${connectionId}, 1, ${"id-" + sourceId}, ${sourceId})`;
  return sourceId;
}

describe.skipIf(!enabled)("opening-action-digest integration", () => {
  beforeAll(async () => {
    f = await createOpeningFixture();
  });

  beforeEach(async () => {
    await f.sql`DELETE FROM opening_action_digest_decisions
      WHERE workspace_id IN (${f.scope.workspaceId}, ${f.otherScope.workspaceId})`;
    await f.sql`DELETE FROM opening_import_receipts
      WHERE workspace_id IN (${f.scope.workspaceId}, ${f.otherScope.workspaceId})`;
    await f.sql`DELETE FROM opening_sources
      WHERE workspace_id IN (${f.scope.workspaceId}, ${f.otherScope.workspaceId})`;
    await f.sql`DELETE FROM opening_connections
      WHERE workspace_id IN (${f.scope.workspaceId}, ${f.otherScope.workspaceId})`;
  });

  afterAll(async () => {
    if (!f) return;
    await f.sql`DELETE FROM opening_action_digest_decisions
      WHERE workspace_id IN (${f.scope.workspaceId}, ${f.otherScope.workspaceId})`;
    await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId}, ${f.otherScope.workspaceId})`;
    await f.close();
  });

  it("accept is idempotent and rejected suggestions are not re-prompted", async () => {
    const repo = createOpeningActionDigestDecisionsRepository(f.sql);
    const pending = candidate({ status: "pending", needsConfirmation: true });

    const first = await repo.recordDecision(f.scope, {
      decision: "accept",
      candidate: pending,
      clientKey: "accept-idempotent-key-01",
    });
    expect(first.status).toBe("accepted");
    const second = await repo.recordDecision(f.scope, {
      decision: "accept",
      candidate: pending,
      clientKey: "accept-idempotent-key-01",
    });
    expect(second).toEqual(first);
    expect(await repo.list(f.scope)).toHaveLength(1);

    const rejectable = candidate({
      id: randomUUID(),
      dedupeKey: "p04:english:essay",
      title: "Draft English essay",
      status: "pending",
    });
    await repo.recordDecision(f.scope, { decision: "reject", candidate: rejectable });

    const extractedPending = candidate({
      id: randomUUID(),
      dedupeKey: "p04:english:essay",
      title: "Draft English essay (re-extract)",
      status: "pending",
      needsConfirmation: true,
    });
    const decisions = await repo.list(f.scope);
    const merged = [
      ...decisions,
      extractedPending,
      candidate({
        id: randomUUID(),
        dedupeKey: "p04:physics:lab",
        title: "Prep physics lab",
        status: "pending",
        needsConfirmation: false,
        priority: 90,
      }),
    ];
    const digest = buildActionDigest(merged);
    expect(digest.primary.every((c) => c.dedupeKey !== "p04:english:essay")).toBe(true);
    expect(digest.primary.some((c) => c.dedupeKey === "p04:physics:lab")).toBe(true);
  });

  it("source correction supersedes pending and proposes delta-only draft", async () => {
    const repo = createOpeningActionDigestDecisionsRepository(f.sql);
    const originalId = randomUUID();
    const pending = candidate({
      id: originalId,
      dedupeKey: "p04:history:notes",
      title: "Review history notes",
      status: "pending",
    });

    // Overlay only stores decisions — mark prior pending as superseded (source correction).
    const superseded = await repo.upsert(f.scope, {
      ...pending,
      status: "superseded",
      needsConfirmation: false,
    });
    expect(superseded.status).toBe("superseded");

    const revisedPending = candidate({
      id: randomUUID(),
      dedupeKey: "p04:history:notes",
      title: "Review history notes (corrected due)",
      dueAt: "2026-10-15T08:00:00.000Z",
      status: "pending",
      needsConfirmation: true,
    });

    const decisions = await repo.list(f.scope);
    const digest = buildActionDigest([...decisions, revisedPending]);
    expect(digest.primary).toHaveLength(1);
    expect(digest.primary[0]?.id).toBe(revisedPending.id);
    expect(digest.primary[0]?.needsConfirmation).toBe(true);
    // Delta-only: superseded history stays in overlay; new pending is the only prompt.
    expect(decisions.some((d) => d.id === originalId && d.status === "superseded")).toBe(true);
  });

  it("revoked connection late suggestions are refused", async () => {
    const connectionId = await seedConnection("ready");
    const sourceId = await seedSourceWithReceipt(connectionId);
    await f.sql`UPDATE opening_connections SET state = 'revoked', version = 2 WHERE id = ${connectionId}`;

    const repo = createOpeningActionDigestDecisionsRepository(f.sql);
    const late = candidate({
      status: "pending",
      sourceIds: [sourceId],
      dedupeKey: "p04:late:from-revoked",
    });

    await expect(
      repo.recordDecision(f.scope, { decision: "accept", candidate: late }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/revoked/i) });

    // Reject remains allowed so the key can be suppressed without accepting.
    const rejected = await repo.recordDecision(f.scope, {
      decision: "reject",
      candidate: late,
    });
    expect(rejected.status).toBe("rejected");
  });
});
