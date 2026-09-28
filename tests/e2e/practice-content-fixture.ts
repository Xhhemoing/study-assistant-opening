import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { buildSeedItems } from "../../apps/web/src/lib/data/mock/seeds-content";

// The legacy player still reads its display content from the mock provider.
const ids = {
  choice: "22222222-2222-4222-8222-222222222201",
  short: "22222222-2222-4222-8222-222222222209",
  checkpoint: "22222222-2222-4222-8222-22222222220f",
};

/** Seed the matching real server item in this test's newly registered workspace only. */
export async function seedPracticeContent(workspaceId: string, kind: keyof typeof ids) {
  const url = process.env.E2E_DATABASE_URL;
  if (!url || !decodeURIComponent(new URL(url).pathname).endsWith("_e2e")) {
    throw new Error("Practice fixtures require E2E_DATABASE_URL naming an _e2e database");
  }
  const item = buildSeedItems().find((candidate) => candidate.id === ids[kind]);
  if (!item) throw new Error(`Missing legacy practice fixture: ${kind}`);
  const sql = postgres(url, { max: 1, connect_timeout: 5 });
  const packageId = randomUUID();
  const rule = item.kind === "checkpoint"
    ? { type: "token_set", accepted: [item.answer.split(",")] }
    : { type: "exact", accepted: [item.answer] };
  try {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO content_packages (id, workspace_id, title, version, status)
        VALUES (${packageId}, ${workspaceId}, 'E2E practice', 1, 'active')`;
      await tx`INSERT INTO syllabus_nodes (id, workspace_id, package_id, code, title, sort_order)
        VALUES (${item.syllabusPointId}, ${workspaceId}, ${packageId}, 'D1', '练习知识点', 0)`;
      await tx`INSERT INTO practice_items (id, workspace_id, package_id, current_version)
        VALUES (${item.id}, ${workspaceId}, ${packageId}, ${item.contentVersion})`;
      await tx`INSERT INTO practice_item_versions (
        practice_item_id, version, workspace_id, syllabus_point_id, kind, stem, options,
        answer_rule, answer_display, hints, ability_slice, estimated_minutes, source, review_status
      ) VALUES (
        ${item.id}, ${item.contentVersion}, ${workspaceId}, ${item.syllabusPointId}, ${item.kind}, ${item.stem},
        ${item.options ? tx.json(item.options) : null}, ${tx.json(rule)}, ${item.answer},
        ${tx.json(item.hints)}, ${item.abilitySlice}, ${item.estimatedMinutes}, ${tx.json({})}, 'reviewed'
      )`;
    });
  } finally {
    await sql.end();
  }
  return {
    itemId: item.id,
    cleanup: async () => {
      const cleanupSql = postgres(url, { max: 1, connect_timeout: 5 });
      try {
        // Keep append-only learning events and their workspace; release only fixture content.
        await cleanupSql.begin(async (tx) => {
          await tx`DELETE FROM practice_sessions WHERE workspace_id = ${workspaceId} AND practice_item_id = ${item.id}`;
          await tx`DELETE FROM practice_items WHERE workspace_id = ${workspaceId} AND id = ${item.id}`;
          await tx`DELETE FROM syllabus_nodes WHERE workspace_id = ${workspaceId} AND package_id = ${packageId}`;
          await tx`DELETE FROM content_packages WHERE workspace_id = ${workspaceId} AND id = ${packageId}`;
        });
      } finally {
        await cleanupSql.end();
      }
    },
  };
}
