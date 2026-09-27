import type { Sql, TransactionSql } from "postgres";
import type { OpeningScope } from "./opening-sources";
import { OpeningMemoryError } from "./opening-memory-types";

type Db = Sql | TransactionSql;

/** Workspace row lock first. Callers must not touch memory rows before this. */
export async function lockOwnedWorkspace(db: Db, scope: OpeningScope): Promise<void> {
  const owners = await db`
    SELECT id FROM workspaces
    WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
    FOR UPDATE`;
  if (!owners.length) throw new OpeningMemoryError("NOT_FOUND", "workspace not found");
}

/**
 * Non-empty sources must each be a turn in an owner-held conversation of this workspace.
 * Binds scope in SQL and does not select turn text.
 */
export async function assertSourceTurnsOwned(
  db: Db,
  scope: OpeningScope,
  sourceTurnIds: readonly string[],
): Promise<void> {
  if (!sourceTurnIds.length) return;
  const unique = [...new Set(sourceTurnIds)];
  const rows = await db`
    SELECT t.id FROM opening_turns t
    INNER JOIN opening_conversations c ON c.id = t.conversation_id
    WHERE t.workspace_id = ${scope.workspaceId}
      AND c.workspace_id = ${scope.workspaceId}
      AND c.owner_user_id = ${scope.ownerUserId}
      AND t.id = ANY(${unique}::uuid[])`;
  if (rows.length !== unique.length) {
    throw new OpeningMemoryError("VALIDATION", "source turns must belong to an owned conversation");
  }
}

/** courses has workspace_id only; ownership is the already-locked workspace owner. */
export async function assertCourseInWorkspace(
  db: Db,
  scope: OpeningScope,
  courseId: string | null | undefined,
): Promise<void> {
  if (courseId == null) return;
  const rows = await db`
    SELECT id FROM courses
    WHERE id = ${courseId} AND workspace_id = ${scope.workspaceId}
    LIMIT 1`;
  if (!rows.length) {
    throw new OpeningMemoryError("VALIDATION", "course is not in this workspace");
  }
}
