import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { assertOpeningTestDatabase } from "@aistudy/config";
import { createSqlClient, hashSessionToken, type OpeningScope } from "@aistudy/database";
import { createSessionJwt } from "../../apps/web/src/lib/session";

export type OpeningFixture = {
  scope: OpeningScope;
  otherScope: OpeningScope;
  sql: Sql;
  cookie: string;
  /** Authenticated request against the running web app (OPENING_WEB_BASE_URL). */
  request(path: string, init?: RequestInit): Promise<Response>;
  requestAnonymous(path: string, init?: RequestInit): Promise<Response>;
  reset(): Promise<void>;
  close(): Promise<void>;
};

/**
 * Connects ONLY through the F01 guard (OPENING_TEST_DB=1 + loopback
 * aistudy_opening_test) and provisions an independent user with two
 * workspaces plus a valid session cookie. `request` requires a running web
 * app; repository-level tests never call it.
 */
export async function createOpeningFixture(): Promise<OpeningFixture> {
  const url = assertOpeningTestDatabase(
    process.env.OPENING_TEST_DATABASE_URL ?? "",
    process.env.OPENING_TEST_DB,
  );
  const sql = createSqlClient(url.toString());

  const userId = randomUUID();
  const otherUserId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  await sql`
    INSERT INTO users (id, email, display_name, password_hash) VALUES
      (${userId}, ${`${userId}@example.com`}, 'Opening fixture', 'test'),
      (${otherUserId}, ${`${otherUserId}@example.com`}, 'Other fixture', 'test')
  `;
  await sql`
    INSERT INTO workspaces (id, owner_user_id) VALUES
      (${workspaceId}, ${userId}),
      (${otherWorkspaceId}, ${otherUserId})
  `;

  const secret = process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret";
  const sessionId = randomUUID();
  const token = await createSessionJwt({ sub: userId, workspaceId, sid: sessionId }, secret, 3600);
  await sql`
    INSERT INTO sessions (id, user_id, token_hash, expires_at)
    VALUES (${sessionId}, ${userId}, ${hashSessionToken(token)}, now() + interval '1 hour')
  `;

  const base = process.env.OPENING_WEB_BASE_URL ?? "http://127.0.0.1:3000";
  const call = async (path: string, init: RequestInit, auth: boolean): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (auth) headers.set("cookie", `aistudy_session=${token}`);
    try {
      return await fetch(new URL(path, base), { ...init, headers });
    } catch (error) {
      throw new Error(
        `Opening API is unreachable at ${base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return {
    scope: { workspaceId, ownerUserId: userId },
    otherScope: { workspaceId: otherWorkspaceId, ownerUserId: otherUserId },
    sql,
    cookie: `aistudy_session=${token}`,
    request: (path, init = {}) => call(path, init, true),
    requestAnonymous: (path, init = {}) => call(path, init, false),
    reset: async () => {
      await sql`TRUNCATE opening_outbox, opening_jobs, opening_budget_reservations, opening_sources RESTART IDENTITY CASCADE`;
    },
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
