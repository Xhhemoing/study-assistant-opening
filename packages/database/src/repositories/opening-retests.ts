import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { RetestCandidate } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";

/**
 * L02 retest proposals as opening_jobs (kind=retest). No new migration.
 * Accept stores a due entry only — not P02 calendar scheduling.
 */
export function createOpeningRetestRepository(sql: Sql) {
  return {
    async saveCandidates(
      scope: OpeningScope,
      candidates: RetestCandidate[],
    ): Promise<RetestCandidate[]> {
      const saved: RetestCandidate[] = [];
      for (const candidate of candidates) {
        const id = candidate.id || randomUUID();
        const row: RetestCandidate = { ...candidate, id, accepted: false };
        await sql`
          INSERT INTO opening_jobs (
            id, workspace_id, owner_user_id, key, kind, payload, privacy_epoch, state
          ) VALUES (
            ${id}, ${scope.workspaceId}, ${scope.ownerUserId},
            ${`retest:${id}`}, ${"retest"}, ${sql.json(row as never)}, ${0}, ${"succeeded"}
          )
          ON CONFLICT (workspace_id, key) DO UPDATE
            SET payload = EXCLUDED.payload, updated_at = now()
        `;
        saved.push(row);
      }
      return saved;
    },

    async accept(
      scope: OpeningScope,
      id: string,
      clientKey: string,
    ): Promise<RetestCandidate> {
      if (!clientKey || clientKey.length < 8) {
        throw Object.assign(new Error("clientKey required"), { code: "VALIDATION" });
      }
      const rows = await sql`
        SELECT id, payload FROM opening_jobs
        WHERE id = ${id}
          AND workspace_id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId}
          AND kind = ${"retest"}
        LIMIT 1
      `;
      if (!rows.length) {
        throw Object.assign(new Error("retest candidate not found"), { code: "NOT_FOUND" });
      }
      const payload = rows[0]!.payload as RetestCandidate;
      if (payload.accepted) return payload;
      const accepted: RetestCandidate = { ...payload, accepted: true };
      await sql`
        UPDATE opening_jobs
        SET payload = ${sql.json(accepted as never)},
            result = ${sql.json({ accepted: true, clientKey, dueAt: accepted.dueAt, scheduled: false } as never)},
            updated_at = now()
        WHERE id = ${id} AND workspace_id = ${scope.workspaceId}
      `;
      return accepted;
    },

    async listAcceptedSkillLabels(
      scope: OpeningScope,
      courseId: string,
    ): Promise<string[]> {
      const rows = await sql`
        SELECT payload FROM opening_jobs
        WHERE workspace_id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId}
          AND kind = ${"retest"}
      `;
      const labels: string[] = [];
      for (const row of rows) {
        const payload = row.payload as RetestCandidate;
        if (payload?.accepted && payload.courseId === courseId) {
          labels.push(payload.skillLabel);
        }
      }
      return [...new Set(labels)];
    },
  };
}

export type OpeningRetestRepository = ReturnType<typeof createOpeningRetestRepository>;
