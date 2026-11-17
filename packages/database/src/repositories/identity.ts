import { randomUUID, createHash } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";

export type IdentityErrorCode =
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "FORBIDDEN";

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
  }
}

export type UserRecord = {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
  disabledAt: Date | null;
};

export type SessionRecord = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  lastSeenAt: Date;
};

export type WorkspaceOwnerRecord = {
  id: string;
  ownerUserId: string;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
};

export type IdentityRepository = {
  createUserWithWorkspace(input: {
    email: string;
    displayName: string;
    passwordHash: string;
    userId?: string;
    workspaceId?: string;
  }): Promise<{ user: UserRecord; workspace: WorkspaceOwnerRecord }>;

  findUserByEmail(email: string): Promise<UserRecord | null>;

  findUserById(userId: string): Promise<UserRecord | null>;

  getWorkspaceForUser(userId: string): Promise<WorkspaceOwnerRecord>;

  createSession(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    sessionId?: string;
  }): Promise<SessionRecord>;

  findValidSession(sessionId: string): Promise<SessionRecord | null>;

  revokeSession(sessionId: string): Promise<void>;

  touchSession(sessionId: string): Promise<void>;
};

function assertUuid(value: string, field: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new IdentityError("VALIDATION", `Invalid UUID for ${field}`);
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function mapUser(row: Record<string, unknown>): UserRecord {
  return {
    id: row.id as string,
    email: row.email as string,
    displayName: row.display_name as string,
    passwordHash: row.password_hash as string,
    schemaVersion: row.schema_version as number,
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
    disabledAt: row.disabled_at
      ? new Date(row.disabled_at as string | Date)
      : null,
  };
}

function mapSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    tokenHash: row.token_hash as string,
    expiresAt: new Date(row.expires_at as string | Date),
    revokedAt: row.revoked_at
      ? new Date(row.revoked_at as string | Date)
      : null,
    createdAt: new Date(row.created_at as string | Date),
    lastSeenAt: new Date(row.last_seen_at as string | Date),
  };
}

function mapWorkspace(row: Record<string, unknown>): WorkspaceOwnerRecord {
  return {
    id: row.id as string,
    ownerUserId: row.owner_user_id as string,
    schemaVersion: row.schema_version as number,
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
  };
}

/** Hash opaque token material for storage (never store raw cookie secret bits). */
export function hashSessionToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Server-internal input, not a grant; object shape never confers authority. */
export type ServerSessionWriteCredential = {
  userId: string;
  workspaceId: string;
  sessionId: string;
  tokenHash: string;
  jwtExpiresAtSeconds: number;
};

/**
 * Caller must first acquire history/required existing fences, in the SAME
 * READ COMMITTED transaction, and retain all locks through its commit.
 * Call before writes and again after final writes/projection. Every call takes
 * the real locks (including a standalone final call); no cached authority.
 *
 * Only guarantees validity at this call's last DB clock cut t, with revocation
 * row writes ordered by locks. NOT expiry validity at commit, global deadlock
 * freedom, or privacy/membership authorization. Native lock/SQL errors escape:
 * abort the whole transaction; never continue via savepoint or auto-retry.
 */
export async function assertIdentitySessionForWriteInTx(
  tx: TransactionSql,
  credential: ServerSessionWriteCredential,
): Promise<void> {
  const isolation = await tx`SHOW transaction_isolation`;
  if (isolation[0]?.transaction_isolation !== "read committed") {
    throw new IdentityError("FORBIDDEN", "Write session requires READ COMMITTED");
  }
  const denied = () => new IdentityError("UNAUTHORIZED", "Invalid write session");
  // Separate statements establish the lock order, unlike a joined locking read.
  const users = await tx`
    SELECT id FROM users WHERE id = ${credential.userId} FOR SHARE NOWAIT
  `;
  if (!users.length) throw denied();
  const sessions = await tx`
    SELECT id FROM sessions
    WHERE id = ${credential.sessionId} AND user_id = ${credential.userId}
    FOR SHARE NOWAIT
  `;
  if (!sessions.length) throw denied();
  const workspaces = await tx`
    SELECT id FROM workspaces
    WHERE id = ${credential.workspaceId} AND owner_user_id = ${credential.userId}
    FOR SHARE NOWAIT
  `;
  if (!workspaces.length) throw denied();
  // One materialized clock for BOTH expiries, after all locks are acquired.
  // No JS Date mapping and no transaction-start now(). Re-read current state on
  // every invocation, even when this transaction already owns the row locks.
  if (!Number.isFinite(credential.jwtExpiresAtSeconds)) throw denied();
  const valid = await tx`
    WITH cut AS MATERIALIZED (SELECT clock_timestamp() AS t)
    SELECT s.id FROM users u
    JOIN sessions s ON s.user_id = u.id
    JOIN workspaces w ON w.owner_user_id = u.id
    CROSS JOIN cut
    WHERE u.id = ${credential.userId} AND u.disabled_at IS NULL
      AND s.id = ${credential.sessionId} AND s.revoked_at IS NULL
      AND s.token_hash = ${credential.tokenHash}
      AND w.id = ${credential.workspaceId}
      AND s.expires_at > cut.t
      AND to_timestamp(${credential.jwtExpiresAtSeconds}) > cut.t
  `;
  if (!valid.length) throw denied();
}

export function createIdentityRepository(sql: Sql): IdentityRepository {
  return {
    async createUserWithWorkspace(input) {
      const email = normalizeEmail(input.email);
      if (!email.includes("@")) {
        throw new IdentityError("VALIDATION", "Invalid email");
      }
      if (!input.displayName?.trim()) {
        throw new IdentityError("VALIDATION", "Display name is required");
      }
      if (!input.passwordHash?.trim()) {
        throw new IdentityError("VALIDATION", "Password hash is required");
      }

      const userId = input.userId ?? randomUUID();
      const workspaceId = input.workspaceId ?? randomUUID();
      assertUuid(userId, "userId");
      assertUuid(workspaceId, "workspaceId");

      try {
        const result = await sql.begin(async (tx) => {
          const users = await tx`
            INSERT INTO users (id, email, display_name, password_hash)
            VALUES (${userId}, ${email}, ${input.displayName.trim()}, ${input.passwordHash})
            RETURNING *
          `;
          const workspaces = await tx`
            INSERT INTO workspaces (id, owner_user_id)
            VALUES (${workspaceId}, ${userId})
            RETURNING *
          `;
          return {
            user: mapUser(users[0] as Record<string, unknown>),
            workspace: mapWorkspace(workspaces[0] as Record<string, unknown>),
          };
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("users_email_lower_uidx") || message.includes("unique")) {
          throw new IdentityError("CONFLICT", "Email already registered");
        }
        throw error;
      }
    },

    async findUserByEmail(email) {
      const normalized = normalizeEmail(email);
      const rows = await sql`
        SELECT * FROM users WHERE lower(email) = ${normalized} LIMIT 1
      `;
      if (!rows.length) return null;
      return mapUser(rows[0] as Record<string, unknown>);
    },

    async findUserById(userId) {
      assertUuid(userId, "userId");
      const rows = await sql`
        SELECT * FROM users WHERE id = ${userId} LIMIT 1
      `;
      if (!rows.length) return null;
      return mapUser(rows[0] as Record<string, unknown>);
    },

    async getWorkspaceForUser(userId) {
      assertUuid(userId, "userId");
      const rows = await sql`
        SELECT * FROM workspaces WHERE owner_user_id = ${userId} LIMIT 1
      `;
      if (!rows.length) {
        throw new IdentityError(
          "NOT_FOUND",
          `Workspace not found for user ${userId}`,
        );
      }
      return mapWorkspace(rows[0] as Record<string, unknown>);
    },

    async createSession(input) {
      assertUuid(input.userId, "userId");
      if (!input.tokenHash?.trim()) {
        throw new IdentityError("VALIDATION", "tokenHash is required");
      }
      const sessionId = input.sessionId ?? randomUUID();
      assertUuid(sessionId, "sessionId");

      const rows = await sql`
        INSERT INTO sessions (id, user_id, token_hash, expires_at)
        VALUES (
          ${sessionId},
          ${input.userId},
          ${input.tokenHash},
          ${input.expiresAt}
        )
        RETURNING *
      `;
      return mapSession(rows[0] as Record<string, unknown>);
    },

    async findValidSession(sessionId) {
      assertUuid(sessionId, "sessionId");
      const rows = await sql`
        SELECT s.* FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.id = ${sessionId}
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND u.disabled_at IS NULL
        LIMIT 1
      `;
      if (!rows.length) return null;
      return mapSession(rows[0] as Record<string, unknown>);
    },

    async revokeSession(sessionId) {
      assertUuid(sessionId, "sessionId");
      await sql`
        UPDATE sessions
        SET revoked_at = now()
        WHERE id = ${sessionId} AND revoked_at IS NULL
      `;
    },

    async touchSession(sessionId) {
      assertUuid(sessionId, "sessionId");
      await sql`
        UPDATE sessions
        SET last_seen_at = now()
        WHERE id = ${sessionId} AND revoked_at IS NULL
      `;
    },
  };
}
