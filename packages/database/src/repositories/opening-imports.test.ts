import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createOpeningImportsRepository } from "./opening-imports";
import { connectorReservationId } from "./opening-source-actions";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const ownerUserId = "00000000-0000-4000-8000-0000000000aa";
const scope = { workspaceId, ownerUserId };
const identity = { connectionId: "00000000-0000-4000-8000-000000000002", container: "INBOX", generation: "42", remoteId: "11" };
const sourceId = "00000000-0000-4000-8000-000000000033";
const reservationId = connectorReservationId(sourceId);
const key = `opening/sources/${sourceId}/v0`;

function fakeImportsSql(opts: { committed?: boolean; notBefore: Date }) {
  let reservationPresent = !opts.committed;
  const tag = (async (parts: TemplateStringsArray) => {
    const query = parts.join("?").replace(/\s+/g, " ").trim();
    if (query.startsWith("SELECT pg_advisory_xact_lock")) return [];
    if (query.startsWith("SELECT id FROM workspaces")) return [{ id: workspaceId }];
    if (query.startsWith("SELECT 1 FROM opening_sources")) return opts.committed ? [{ "?column?": 1 }] : [];
    if (query.startsWith("SELECT id, cleanup_not_before FROM opening_privacy_exclusions")) {
      return reservationPresent ? [{ id: reservationId, cleanup_not_before: opts.notBefore }] : [];
    }
    if (query.startsWith("DELETE FROM opening_source_versions")) return [{ source_id: sourceId }];
    if (query.startsWith("DELETE FROM opening_privacy_exclusions")) {
      reservationPresent = false;
      return [];
    }
    if (query.startsWith("SELECT id FROM opening_privacy_exclusions")) {
      return reservationPresent ? [{ id: reservationId }] : [];
    }
    if (query.startsWith("SELECT 1 FROM opening_source_versions")) {
      return reservationPresent ? [{ "?column?": 1 }] : [];
    }
    throw new Error(`unexpected sql: ${query}`);
  }) as unknown as Sql;
  tag.begin = (async (cb: (tx: Sql) => Promise<unknown>) => cb(tag)) as unknown as Sql["begin"];
  return {
    sql: tag,
    hasReservation: () => reservationPresent,
  };
}

describe("opening imports removeUnpublishedSource grace window", () => {
  it("releases immediately when putUncertain is false even inside cleanup_not_before", async () => {
    const clock = new Date("2030-01-01T00:00:10.000Z");
    const db = fakeImportsSql({ notBefore: new Date("2030-01-01T00:01:00.000Z") });
    const remove = vi.fn(async () => undefined);
    await createOpeningImportsRepository(db.sql).removeUnpublishedSource(
      scope, identity, sourceId, key, 128, remove, { putUncertain: false, now: clock },
    );
    expect(remove).toHaveBeenCalledOnce();
    expect(db.hasReservation()).toBe(false);
  });

  it("attempts immediate S3 remove while keeping the reservation durable inside cleanup_not_before on uncertain PUT", async () => {
    const clock = new Date("2030-01-01T00:00:10.000Z");
    const db = fakeImportsSql({ notBefore: new Date("2030-01-01T00:01:00.000Z") });
    const remove = vi.fn(async () => undefined);
    const repo = createOpeningImportsRepository(db.sql);

    await repo.removeUnpublishedSource(
      scope, identity, sourceId, key, 128, remove, { putUncertain: true, now: clock },
    );
    expect(remove).toHaveBeenCalledTimes(1);
    expect(db.hasReservation()).toBe(true);

    const afterGrace = new Date("2030-01-01T00:01:01.000Z");
    await repo.removeUnpublishedSource(
      scope, identity, sourceId, key, 128, remove, { putUncertain: true, now: afterGrace },
    );
    expect(remove).toHaveBeenCalledTimes(2);
    expect(db.hasReservation()).toBe(false);
  });

  it("never deletes objects belonging to a committed source", async () => {
    const db = fakeImportsSql({ committed: true, notBefore: new Date("2030-01-01T00:01:00.000Z") });
    const remove = vi.fn(async () => undefined);
    await createOpeningImportsRepository(db.sql).removeUnpublishedSource(
      scope, identity, sourceId, key, 128, remove, { putUncertain: false },
    );
    expect(remove).not.toHaveBeenCalled();
  });
});
