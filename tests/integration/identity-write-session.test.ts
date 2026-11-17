import { randomUUID } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertIdentitySessionForWriteInTx, createIdentityRepository, hashSessionToken,
  type ServerSessionWriteCredential,
} from "@aistudy/database";
import { lockWorkspaceLearningHistory } from "../../packages/database/src/repositories/opening-learning-facts";

// Only synthetic identity rows and a transaction sentinel; NO issuance path.
let sql: Sql;
let credential: ServerSessionWriteCredential;
const sentinel = `synthetic_auth_write_${randomUUID().replaceAll("-", "")}`;
const clients: Sql[] = [];
const users: string[] = [];
const scope = () => ({ workspaceId: credential.workspaceId, ownerUserId: credential.userId });
function barrier() {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release };
}
async function connection() {
  const client = postgres(process.env.DATABASE_URL!, {
    max: 1, onnotice: () => {}, connection: { statement_timeout: 5000, idle_in_transaction_session_timeout: 10000 },
  });
  clients.push(client);
  const [row] = await client`SELECT pg_backend_pid() AS pid`;
  return { sql: client, pid: Number(row!.pid) };
}
async function history(tx: TransactionSql) { await lockWorkspaceLearningHistory(tx, scope()); }
async function mark(tx: TransactionSql) { await tx`INSERT INTO ${tx(sentinel)} (id) VALUES (${randomUUID()})`; }
async function count() { return Number((await sql`SELECT count(*) AS n FROM ${sql(sentinel)}`)[0]!.n); }
async function blocked(writer: number, holder: number) {
  const deadline = Date.now() + 2000;
  do {
    const rows = await sql`SELECT 1 FROM pg_stat_activity a WHERE a.pid=${writer}
      AND ${holder}=ANY(pg_blocking_pids(a.pid))
      AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted)`;
    if (rows.length) return;
  } while (Date.now() < deadline);
  throw new Error("synthetic writer did not wait on expected transaction");
}

beforeAll(async () => {
  sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await sql`CREATE TABLE ${sql(sentinel)} (id uuid PRIMARY KEY)`;
});
beforeEach(async () => {
  const identity = createIdentityRepository(sql);
  const { user, workspace } = await identity.createUserWithWorkspace({
    email: `synthetic-${randomUUID()}@example.invalid`, displayName: "Synthetic auth race", passwordHash: "not-a-login-hash",
  });
  users.push(user.id);
  const session = await identity.createSession({ userId: user.id, tokenHash: hashSessionToken(randomUUID()), expiresAt: new Date(Date.now() + 60000) });
  credential = { userId: user.id, workspaceId: workspace.id, sessionId: session.id,
    tokenHash: session.tokenHash, jwtExpiresAtSeconds: Date.now() / 1000 + 60 };
  await sql`TRUNCATE ${sql(sentinel)}`;
});
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.end({ timeout: 5 }))); });
afterAll(async () => {
  if (!sql) return;
  try {
    await sql`DROP TABLE IF EXISTS ${sql(sentinel)}`;
    for (const id of users) {
      await sql`DELETE FROM opening_workspace_history_revisions WHERE owner_user_id=${id}`;
      await sql`DELETE FROM users WHERE id=${id}`;
    }
  } finally { await sql.end({ timeout: 5 }); }
});

describe("synthetic write-session PostgreSQL transaction checks", () => {
  it("uses real READ COMMITTED, locks on standalone/final calls, and retains locks to commit", async () => {
    const a = await connection(), b = await connection();
    const held = barrier(), release = barrier();
    const issuing = a.sql.begin("isolation level read committed", async tx => {
      expect((await tx`SHOW transaction_isolation`)[0]!.transaction_isolation).toBe("read committed");
      await history(tx);
      await mark(tx);
      // No prior auth call: this final-only invocation must acquire the locks.
      await assertIdentitySessionForWriteInTx(tx, credential);
      held.release(); await release.ready;
    });
    issuing.catch(held.release);
    let writing: Promise<unknown> | undefined;
    try {
      await Promise.race([held.ready, issuing]);
      writing = b.sql`UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=${credential.sessionId}`.then(r => r);
      await blocked(b.pid, a.pid);
      expect(await count()).toBe(0);
      release.release(); await issuing; await writing;
      expect(await count()).toBe(1);
      await expect(sql.begin("isolation level read committed", async tx => {
        await history(tx); await assertIdentitySessionForWriteInTx(tx, credential);
      })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally { release.release(); await Promise.allSettled([issuing, writing]); }
  });

  it.each(["revoke", "disable"])("rejects committed %s before issuer, rolls back sentinel", async mode => {
    if (mode === "revoke") await sql`UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=${credential.sessionId}`;
    else await sql`UPDATE users SET disabled_at=clock_timestamp() WHERE id=${credential.userId}`;
    await expect(sql.begin("isolation level read committed", async tx => {
      await history(tx); await mark(tx); await assertIdentitySessionForWriteInTx(tx, credential);
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await count()).toBe(0);
  });

  it("issuer-first user SHARE makes disable wait until commit", async () => {
    const a = await connection(), b = await connection();
    const held = barrier(), release = barrier();
    const issuing = a.sql.begin("isolation level read committed", async tx => {
      await history(tx); await assertIdentitySessionForWriteInTx(tx, credential);
      await mark(tx); await assertIdentitySessionForWriteInTx(tx, credential);
      held.release(); await release.ready;
    });
    issuing.catch(held.release);
    let disabling: Promise<unknown> | undefined;
    try {
      await Promise.race([held.ready, issuing]);
      disabling = b.sql`UPDATE users SET disabled_at=clock_timestamp() WHERE id=${credential.userId}`.then(r => r);
      await blocked(b.pid, a.pid);
      expect(await count()).toBe(0);
      release.release(); await issuing; await disabling;
      expect(await count()).toBe(1);
      await expect(sql.begin("isolation level read committed", async tx => {
        await history(tx); await assertIdentitySessionForWriteInTx(tx, credential);
      })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally { release.release(); await Promise.allSettled([issuing, disabling]); }
  });

  it.each(["revoke", "disable", "touch", "workspace"])("uncommitted %s lock is native NOWAIT failure and whole-tx rollback", async mode => {
    const b = await connection();
    const held = barrier(), release = barrier();
    const holding = b.sql.begin(async tx => {
      if (mode === "disable") await tx`UPDATE users SET disabled_at=clock_timestamp() WHERE id=${credential.userId}`;
      else if (mode === "workspace") await tx`UPDATE workspaces SET updated_at=clock_timestamp() WHERE id=${credential.workspaceId}`;
      else if (mode === "touch") await tx`UPDATE sessions SET last_seen_at=clock_timestamp() WHERE id=${credential.sessionId}`;
      else await tx`UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=${credential.sessionId}`;
      held.release(); await release.ready;
    });
    holding.catch(held.release);
    try {
      await Promise.race([held.ready, holding]);
      await expect(sql.begin("isolation level read committed", async tx => {
        await history(tx); await mark(tx); await assertIdentitySessionForWriteInTx(tx, credential);
      })).rejects.toMatchObject({ code: "55P03" });
      expect(await count()).toBe(0);
    } finally { release.release(); await holding; }
  });

  it("sessions→users maintenance inversion is cut by session NOWAIT, not retried", async () => {
    const a = await connection(), b = await connection();
    const sessionHeld = barrier(), startUser = barrier();
    const maintenance = b.sql.begin(async tx => {
      await tx`UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=${credential.sessionId}`;
      sessionHeld.release(); await startUser.ready;
      await tx`UPDATE users SET disabled_at=NULL WHERE id=${credential.userId}`;
    });
    maintenance.catch(sessionHeld.release);
    let userLocks = 0;
    try {
      await Promise.race([sessionHeld.ready, maintenance]);
      await expect(a.sql.begin("isolation level read committed", async tx => {
        await history(tx); await mark(tx);
        // Instrument scheduling only; every lock and error executes on PG.
        const observed = new Proxy(tx, { apply(target, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
          return (async () => {
            const rows = await Reflect.apply(target, thisArg, args);
            if (args[0].join("?").includes("SELECT id FROM users")) {
              userLocks++; startUser.release(); await blocked(b.pid, a.pid);
            }
            return rows;
          })();
        } });
        await assertIdentitySessionForWriteInTx(observed, credential);
      })).rejects.toMatchObject({ code: "55P03" });
      await maintenance;
      expect(userLocks).toBe(1);
      expect(await count()).toBe(0);
      expect((await sql`SELECT revoked_at FROM sessions WHERE id=${credential.sessionId}`)[0]!.revoked_at).not.toBeNull();
    } finally { startUser.release(); await Promise.allSettled([maintenance]); }
  });

  it.each(["hash", "session-user", "workspace", "missing-session", "missing-user", "missing-workspace", "jwt-expiry", "db-expiry"])("rejects current %s (shape alone is not authority)", async mode => {
    const candidate = { ...credential };
    if (mode === "hash") candidate.tokenHash = hashSessionToken("different synthetic token");
    if (mode === "session-user") {
      const other = await createIdentityRepository(sql).createUserWithWorkspace({ email: `${randomUUID()}@example.invalid`, displayName: "Other", passwordHash: "synthetic" });
      users.push(other.user.id); candidate.userId = other.user.id; candidate.workspaceId = other.workspace.id;
    }
    if (mode === "workspace" || mode === "missing-workspace") candidate.workspaceId = randomUUID();
    if (mode === "missing-session") candidate.sessionId = randomUUID();
    if (mode === "missing-user") candidate.userId = randomUUID();
    if (mode === "jwt-expiry") candidate.jwtExpiresAtSeconds = Date.now() / 1000 - 1;
    if (mode === "db-expiry") await sql`UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${credential.sessionId}`;
    await expect(sql.begin("isolation level read committed", async tx => {
      await history(tx); await mark(tx); await assertIdentitySessionForWriteInTx(tx, candidate);
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await count()).toBe(0);
  });

  it.each(["user", "workspace"])("rejects deleted %s and rolls back earlier sentinel", async mode => {
    if (mode === "user") await sql`DELETE FROM users WHERE id=${credential.userId}`;
    else await sql`DELETE FROM workspaces WHERE id=${credential.workspaceId}`;
    await expect(sql.begin("isolation level read committed", async tx => {
      // Synthetic rollback check only: deleted scope cannot acquire history.
      await mark(tx); await assertIdentitySessionForWriteInTx(tx, credential);
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await count()).toBe(0);
  });

  it("requires exact workspace owner even when the workspace exists", async () => {
    const other = await createIdentityRepository(sql).createUserWithWorkspace({ email: `${randomUUID()}@example.invalid`, displayName: "Other", passwordHash: "synthetic" });
    users.push(other.user.id);
    await expect(sql.begin("isolation level read committed", async tx => {
      await history(tx); await mark(tx);
      await assertIdentitySessionForWriteInTx(tx, { ...credential, workspaceId: other.workspace.id });
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await count()).toBe(0);
  });

  it.each(["jwt", "db"])("final %s expiry uses fresh clock, not transaction-start now(), and rolls back writes", async mode => {
    await expect(sql.begin("isolation level read committed", async tx => {
      await history(tx);
      const [cut] = await tx`SELECT extract(epoch FROM clock_timestamp()+interval '0.3 second')::float8 AS exp`;
      const candidate = { ...credential, jwtExpiresAtSeconds: mode === "jwt" ? Number(cut!.exp) : credential.jwtExpiresAtSeconds };
      if (mode === "db") await tx`UPDATE sessions SET expires_at=to_timestamp(${Number(cut!.exp)}) WHERE id=${credential.sessionId}`;
      await assertIdentitySessionForWriteInTx(tx, candidate); await mark(tx);
      await tx`SELECT pg_sleep(0.4)`;
      const [clock] = await tx`SELECT now()<to_timestamp(${Number(cut!.exp)}) AS old_valid,
        clock_timestamp()>to_timestamp(${Number(cut!.exp)}) AS expired`;
      expect(clock).toMatchObject({ old_valid: true, expired: true });
      await assertIdentitySessionForWriteInTx(tx, candidate);
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await count()).toBe(0);
  });

  it("rechecks state changed by its own tx on the final call", async () => {
    await expect(sql.begin("isolation level read committed", async tx => {
      await history(tx); await assertIdentitySessionForWriteInTx(tx, credential); await mark(tx);
      await tx`UPDATE sessions SET token_hash=${hashSessionToken("rotated")} WHERE id=${credential.sessionId}`;
      await assertIdentitySessionForWriteInTx(tx, credential);
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await count()).toBe(0);
    expect((await sql`SELECT token_hash FROM sessions WHERE id=${credential.sessionId}`)[0]!.token_hash).toBe(credential.tokenHash);
  });

  it.each(["repeatable read", "serializable"])("fails closed in actual %s even for an otherwise valid session", async isolation => {
    await expect(sql.begin(`isolation level ${isolation}`, async tx => {
      expect((await tx`SHOW transaction_isolation`)[0]!.transaction_isolation).toBe(isolation);
      await mark(tx); await assertIdentitySessionForWriteInTx(tx, credential);
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await count()).toBe(0);
  });

  it("propagates native invalid UUID SQL error and rolls back without retry", async () => {
    let calls = 0;
    await expect(sql.begin("isolation level read committed", async tx => {
      calls++; await history(tx); await mark(tx);
      await assertIdentitySessionForWriteInTx(tx, { ...credential, sessionId: "invalid-uuid" });
    })).rejects.toMatchObject({ code: "22P02" });
    expect(calls).toBe(1); expect(await count()).toBe(0);
  });

  it("demonstrates the explicit non-guarantee: expiry may pass after last check but before commit", async () => {
    let exp = 0;
    await sql.begin("isolation level read committed", async tx => {
      await history(tx); await mark(tx);
      exp = Number((await tx`SELECT extract(epoch FROM clock_timestamp()+interval '0.3 second')::float8 AS exp`)[0]!.exp);
      await assertIdentitySessionForWriteInTx(tx, { ...credential, jwtExpiresAtSeconds: exp });
      // Deliberate synthetic scheduling delay, NOT a recommended production callsite.
      await tx`SELECT pg_sleep(0.4)`;
    });
    expect(await count()).toBe(1);
    expect((await sql`SELECT clock_timestamp()>to_timestamp(${exp}) AS expired`)[0]!.expired).toBe(true);
  });
});
