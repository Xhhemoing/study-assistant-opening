import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createOpeningImportsRepository } from "./opening-imports";

const postgresMock = vi.hoisted(() => ({
  nextSession: null as unknown,
}));

vi.mock("postgres", () => ({
  default: vi.fn(() => postgresMock.nextSession),
}));
import {
  CONNECTOR_PUT_TIMEOUT_MS,
  CONNECTOR_RESERVATION_GRACE_MS,
  connectorReservationId,
  createOpeningSourceActionsRepository,
} from "./opening-source-actions";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const ownerUserId = "00000000-0000-4000-8000-0000000000aa";
const scope = { workspaceId, ownerUserId };
const identity = { connectionId: "00000000-0000-4000-8000-000000000002", container: "INBOX", generation: "42", remoteId: "11" };
const sourceId = "00000000-0000-4000-8000-000000000033";
const reservationId = connectorReservationId(sourceId);
const key = `opening/sources/${sourceId}/v0`;

function fakeImportsSql(opts: { committed?: boolean; notBefore: Date }) {
  let reservationPresent = !opts.committed;
  let cutoff = opts.notBefore;
  const tag = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?").replace(/\s+/g, " ").trim();
    if (query === "" || query === "FOR UPDATE") return Promise.resolve(query);
    if (query.startsWith("SELECT pg_advisory_xact_lock")) return Promise.resolve([]);
    if (query.startsWith("SELECT id FROM workspaces")) return Promise.resolve([{ id: workspaceId }]);
    if (query.startsWith("SELECT 1 FROM opening_sources")) return Promise.resolve(opts.committed ? [{ "?column?": 1 }] : []);
    if (query.startsWith("UPDATE opening_privacy_exclusions SET cleanup_not_before = GREATEST")) {
      if (!reservationPresent) return Promise.resolve([]);
      const candidate = values[1] instanceof Date ? values[1] : new Date(Date.now() + CONNECTOR_RESERVATION_GRACE_MS);
      if (candidate > cutoff) cutoff = candidate;
      return Promise.resolve([{ id: reservationId }]);
    }
    if (query.startsWith("SELECT id, cleanup_not_before FROM opening_privacy_exclusions")) {
      return Promise.resolve(reservationPresent ? [{ id: reservationId, cleanup_not_before: cutoff }] : []);
    }
    if (query.startsWith("DELETE FROM opening_source_versions")) return Promise.resolve([{ source_id: sourceId }]);
    if (query.startsWith("DELETE FROM opening_privacy_exclusions")) {
      reservationPresent = false;
      return Promise.resolve([]);
    }
    if (query.startsWith("SELECT id FROM opening_privacy_exclusions")) {
      return Promise.resolve(reservationPresent ? [{ id: reservationId }] : []);
    }
    if (query.startsWith("SELECT 1 FROM opening_source_versions")) {
      return Promise.resolve(reservationPresent ? [{ "?column?": 1 }] : []);
    }
    return Promise.reject(new Error(`unexpected sql: ${query}`));
  }) as unknown as Sql;
  tag.begin = (async (cb: (tx: Sql) => Promise<unknown>) => {
    const savedPresent = reservationPresent;
    const savedCutoff = new Date(cutoff.getTime());
    try {
      return await cb(tag);
    } catch (error) {
      reservationPresent = savedPresent;
      cutoff = savedCutoff;
      throw error;
    }
  }) as unknown as Sql["begin"];
  return {
    sql: tag,
    hasReservation: () => reservationPresent,
    getCutoff: () => cutoff,
  };
}

describe("opening imports reservation cutoff and removeUnpublishedSource grace window", () => {
  it("refreshes cleanup_not_before before storage.upload and rejects missing reservations", async () => {
    const start = new Date("2030-01-01T00:00:00.000Z");
    const db = fakeImportsSql({ notBefore: new Date("2030-01-01T00:00:05.000Z") });
    const repo = createOpeningImportsRepository(db.sql);

    const delayedUploadStart = new Date("2030-01-01T00:02:00.000Z");
    await repo.refreshConnectorReservationCutoff(scope, sourceId, key, { now: delayedUploadStart });
    expect(db.getCutoff()).toEqual(
      new Date(delayedUploadStart.getTime() + CONNECTOR_PUT_TIMEOUT_MS + CONNECTOR_RESERVATION_GRACE_MS),
    );
    expect(db.getCutoff().getTime()).toBeGreaterThan(start.getTime() + CONNECTOR_RESERVATION_GRACE_MS);

    const missing = fakeImportsSql({ committed: true, notBefore: start });
    await expect(createOpeningImportsRepository(missing.sql).refreshConnectorReservationCutoff(scope, sourceId, key))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

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

  it("extends cleanup_not_before on uncertain PUT abort and holds reservation until post-abort grace expires", async () => {
    const initialExpiry = new Date("2030-01-01T00:01:00.000Z");
    const db = fakeImportsSql({ notBefore: initialExpiry });
    const remove = vi.fn(async () => undefined);
    const repo = createOpeningImportsRepository(db.sql);
    const actions = createOpeningSourceActionsRepository(db.sql);

    // Uncertain PUT aborts near or after initial expiry -> must extend a full grace window past abortAt.
    const abortAt = new Date("2030-01-01T00:01:20.000Z");
    await repo.removeUnpublishedSource(
      scope, identity, sourceId, key, 128, remove, { putUncertain: true, now: abortAt },
    );
    expect(remove).toHaveBeenCalledTimes(1);
    expect(db.hasReservation()).toBe(true);
    expect(db.getCutoff()).toEqual(new Date(abortAt.getTime() + CONNECTOR_RESERVATION_GRACE_MS));

    // Sweeper inside post-abort grace window stays blocked; after grace expires, it releases cleanly.
    const insidePostAbortGrace = new Date(abortAt.getTime() + CONNECTOR_RESERVATION_GRACE_MS - 1_000);
    await expect(actions.cleaned(scope, sourceId, key, insidePostAbortGrace)).resolves.toBe(false);
    expect(db.hasReservation()).toBe(true);

    const afterPostAbortGrace = new Date(abortAt.getTime() + CONNECTOR_RESERVATION_GRACE_MS + 1_000);
    await expect(actions.cleaned(scope, sourceId, key, afterPostAbortGrace)).resolves.toBe(true);
    expect(db.hasReservation()).toBe(false);
  });

  it("commits extended cleanup_not_before on uncertain PUT even if immediate remove rejects, while preserving rollback for putUncertain=false", async () => {
    const initialExpiry = new Date("2030-01-01T00:01:00.000Z");
    const db = fakeImportsSql({ notBefore: initialExpiry });
    const repo = createOpeningImportsRepository(db.sql);
    const abortAt = new Date("2030-01-01T00:01:20.000Z");

    await expect(repo.removeUnpublishedSource(
      scope, identity, sourceId, key, 128, async () => { throw new Error("s3 unavailable"); },
      { putUncertain: true, now: abortAt },
    )).rejects.toThrow("s3 unavailable");
    expect(db.hasReservation()).toBe(true);
    expect(db.getCutoff()).toEqual(new Date(abortAt.getTime() + CONNECTOR_RESERVATION_GRACE_MS));

    // When putUncertain is false and S3 remove() fails, transaction rollback preserves the reservation.
    const rollbackDb = fakeImportsSql({ notBefore: initialExpiry });
    await expect(createOpeningImportsRepository(rollbackDb.sql).removeUnpublishedSource(
      scope, identity, sourceId, key, 128, async () => { throw new Error("s3 unavailable"); },
      { putUncertain: false, now: abortAt },
    )).rejects.toThrow("s3 unavailable");
    expect(rollbackDb.hasReservation()).toBe(true);
    expect(rollbackDb.getCutoff()).toEqual(initialExpiry);
  });

  it("never deletes objects belonging to a committed source", async () => {
    const db = fakeImportsSql({ committed: true, notBefore: new Date("2030-01-01T00:01:00.000Z") });
    const remove = vi.fn(async () => undefined);
    await createOpeningImportsRepository(db.sql).removeUnpublishedSource(
      scope, identity, sourceId, key, 128, remove, { putUncertain: false },
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it("runs refreshConnectorReservationCutoff on the lock-holding session inside publish without deadlocking a saturated shared pool", async () => {
    const initialCutoff = new Date("2030-01-01T00:00:00.000Z");
    let reservationPresent = false;
    let cutoff = initialCutoff;
    let lockHeld = false;
    let releaseLockWaiter: (() => void) | null = null;
    let poolInFlight = 0;
    const poolWaiters: (() => void)[] = [];

    const acquirePoolSlot = async () => {
      if (poolInFlight >= 1) {
        await new Promise<void>(resolve => poolWaiters.push(resolve));
      }
      poolInFlight += 1;
    };
    const releasePoolSlot = () => {
      poolInFlight -= 1;
      const next = poolWaiters.shift();
      next?.();
    };

    let cleanupWaitingResolve!: () => void;
    const cleanupWaitingOnLock = new Promise<void>(resolve => { cleanupWaitingResolve = resolve; });

    const makeConn = (isDedicated: boolean) => {
      const fn = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
        const query = parts.join("?").replace(/\s+/g, " ").trim();
        if (query === "" || query === "FOR UPDATE" || query === "FOR NO KEY UPDATE") return query;
        if (query.startsWith("SELECT pg_advisory_lock")) {
          lockHeld = true;
          return [];
        }
        if (query.startsWith("SELECT pg_advisory_xact_lock")) {
          if (lockHeld) {
            await new Promise<void>(resolve => {
              releaseLockWaiter = resolve;
              cleanupWaitingResolve();
            });
          }
          return [];
        }
        if (query.startsWith("SELECT id, source_id, connection_version FROM opening_import_receipts")) return [];
        if (query.startsWith("SELECT version, state FROM opening_connections")) return [{ version: 1, state: "ready" }];
        if (query.startsWith("SELECT id FROM workspaces")) return [{ id: workspaceId }];
        if (query.startsWith("WITH quota_objects AS")) return [{ bytes: "0", objects: "0" }];
        if (query.startsWith("SELECT 1 FROM opening_sources")) return [];
        if (query.startsWith("INSERT INTO opening_source_versions")) return [];
        if (query.startsWith("INSERT INTO opening_privacy_exclusions")) {
          reservationPresent = true;
          return [];
        }
        if (query.startsWith("UPDATE opening_privacy_exclusions SET cleanup_not_before = GREATEST")) {
          expect(isDedicated).toBe(true);
          if (!reservationPresent) return [];
          const candidate = values[1] instanceof Date ? values[1] : new Date(Date.now() + CONNECTOR_PUT_TIMEOUT_MS + CONNECTOR_RESERVATION_GRACE_MS);
          if (candidate > cutoff) cutoff = candidate;
          return [{ id: reservationId }];
        }
        if (query.startsWith("SELECT id, cleanup_not_before FROM opening_privacy_exclusions")) {
          return reservationPresent ? [{ id: reservationId, cleanup_not_before: cutoff }] : [];
        }
        if (query.startsWith("DELETE FROM opening_source_versions")) return [{ source_id: sourceId }];
        if (query.startsWith("DELETE FROM opening_privacy_exclusions")) {
          reservationPresent = false;
          return [];
        }
        if (query.startsWith("SELECT 1 FROM opening_source_versions")) return reservationPresent ? [{ "?column?": 1 }] : [];
        if (query.startsWith("SELECT id FROM opening_privacy_exclusions")) return reservationPresent ? [{ id: reservationId }] : [];
        throw new Error(`unexpected sql: ${query}`);
      }) as unknown as Sql & { options: { max: number }; end: () => Promise<void> };
      fn.options = { max: 1 };
      fn.end = async () => {
        if (isDedicated) {
          lockHeld = false;
          releaseLockWaiter?.();
          releaseLockWaiter = null;
        }
      };
      fn.begin = (async (cb: (tx: Sql) => Promise<unknown>) => {
        if (!isDedicated) await acquirePoolSlot();
        try {
          return await cb(fn);
        } finally {
          if (!isDedicated) releasePoolSlot();
        }
      }) as unknown as Sql["begin"];
      return fn;
    };

    const sharedPoolSql = makeConn(false);
    const dedicatedSessionSql = makeConn(true);
    postgresMock.nextSession = dedicatedSessionSql;
    const repo = createOpeningImportsRepository(sharedPoolSql);

    let markStageEntered!: () => void;
    const stageEntered = new Promise<void>(resolve => { markStageEntered = resolve; });
    const refreshTime = new Date("2030-01-01T00:05:00.000Z");

    const publishPromise = expect(repo.publish(scope, {
      connectionVersion: 1,
      identity,
      sourceId,
      key,
      quota: { maxBytes: 1024 * 1024, maxObjects: 10 },
      source: { name: "mail.eml", mime: "message/rfc822", bytes: 128, sha256: "a".repeat(64) },
    }, async (ctx) => {
      markStageEntered();
      // Wait until removeUnpublishedSource occupies the 1-connection shared pool on pg_advisory_xact_lock.
      await cleanupWaitingOnLock;
      expect(ctx?.session).toBe(dedicatedSessionSql);
      await repo.refreshConnectorReservationCutoff(scope, sourceId, key, { now: refreshTime, session: ctx?.session });
      throw new Error("simulated PUT error after refresh");
    })).rejects.toThrow("simulated PUT error after refresh");

    await stageEntered;
    const cleanupPromise = repo.removeUnpublishedSource(scope, identity, sourceId, key, 128, async () => undefined, {
      putUncertain: false,
      now: refreshTime,
    });

    await Promise.all([publishPromise, cleanupPromise]);
    expect(cutoff).toEqual(new Date(refreshTime.getTime() + CONNECTOR_PUT_TIMEOUT_MS + CONNECTOR_RESERVATION_GRACE_MS));
    expect(reservationPresent).toBe(false);
  });
});
