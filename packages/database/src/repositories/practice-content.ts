import type { Sql } from "postgres";
import {
  mapCandidate,
  mapGradableItem,
  mapPublicItem,
  mapSyllabusPoint,
  PracticeContentRepositoryError,
  type PracticeContentRepository,
  type Row,
} from "./practice-content-types";

export {
  PracticeContentRepositoryError,
  type PracticeContentErrorCode,
  type PracticeContentRepository,
} from "./practice-content-types";

export function createPracticeContentRepository(sql: Sql): PracticeContentRepository {
  async function loadVersion(input: {
    workspaceId: string;
    itemId: string;
    version?: number;
  }): Promise<Row> {
    const rows = input.version == null
      ? await sql`
          SELECT i.id AS practice_item_id, i.current_version, i.archived_at, v.*
          FROM practice_items i
          JOIN practice_item_versions v
            ON v.practice_item_id = i.id AND v.version = i.current_version
          WHERE i.workspace_id = ${input.workspaceId} AND i.id = ${input.itemId}
          LIMIT 1
        `
      : await sql`
          SELECT i.id AS practice_item_id, i.current_version, i.archived_at, v.*
          FROM practice_items i
          JOIN practice_item_versions v
            ON v.practice_item_id = i.id AND v.version = ${input.version}
          WHERE i.workspace_id = ${input.workspaceId} AND i.id = ${input.itemId}
          LIMIT 1
        `;
    if (!rows[0]) {
      throw new PracticeContentRepositoryError(
        "NOT_FOUND",
        `Practice item ${input.itemId} was not found in this workspace`,
      );
    }
    return rows[0] as Row;
  }

  return {
    async getPublicItem(input) {
      return mapPublicItem(await loadVersion(input));
    },

    async getGradableVersion(input) {
      return mapGradableItem(await loadVersion(input));
    },

    async listSyllabusPoints(input) {
      const rows = await sql`
        SELECT * FROM syllabus_nodes
        WHERE workspace_id = ${input.workspaceId} AND package_id = ${input.packageId}
        ORDER BY sort_order ASC, code ASC
      `;
      return rows.map((row) => mapSyllabusPoint(row as Row));
    },

    async listPracticeCandidates(input) {
      const rows = await sql`
        SELECT i.id AS practice_item_id, i.current_version, v.syllabus_point_id,
               v.kind, v.ability_slice, v.estimated_minutes
        FROM practice_items i
        JOIN practice_item_versions v
          ON v.practice_item_id = i.id AND v.version = i.current_version
        WHERE i.workspace_id = ${input.workspaceId}
          AND i.package_id = ${input.packageId}
          AND i.archived_at IS NULL
        ORDER BY i.id ASC
      `;
      return rows.map((row) => mapCandidate(row as Row));
    },
  };
}
