import { randomUUID } from "node:crypto";
import { createSqlClient } from "@aistudy/database";
import type { JSONValue, Sql } from "postgres";
import { backupRows, createBackupFixture } from "./opening-backup-records-fixture";

export const originalVerification = {
  kind: "rubric", status: "ready", exerciseKeys: ["原题-1"],
  rubric: "原始标准 https://example.invalid/rubric?q=%E4%B8%AD#raw",
  missingReasons: [],
};

export async function createCourseLineagePgFixture() {
  const base = await createBackupFixture();
  // An isolated SELECT-only role exercises real permissions without installing
  // RLS policies or changing schema. max:1 keeps SET ROLE on the reader backend.
  const role = `backup_lineage_${randomUUID().replaceAll("-", "")}`;
  const reader = createSqlClient(process.env.OPENING_TEST_DATABASE_URL!, { max: 1 });
  await base.sql`CREATE ROLE ${base.sql(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS`;
  async function dispose() {
    try {
      await reader.end({ timeout: 5 });
      await base.sql`DROP OWNED BY ${base.sql(role)}`;
      await base.sql`DROP ROLE ${base.sql(role)}`;
    } finally { await base.dispose(); }
  }
  try {
    await base.sql`GRANT USAGE ON SCHEMA public TO ${base.sql(role)}`;
    await base.sql`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${base.sql(role)}`;
    await reader`SET ROLE ${reader(role)}`;
    const [roleState] = await reader<{ allowed: boolean }[]>`
      SELECT NOT rolsuper AND NOT rolbypassrls AS allowed FROM pg_roles WHERE rolname=current_user`;
    if (!roleState?.allowed) throw new Error("Backup reader must not bypass database authorization");
    await reader`SET lock_timeout='8s'`;
    await reader`SET statement_timeout='8s'`;
    await reader`SET idle_in_transaction_session_timeout='20s'`;
    const course = randomUUID(), foreignCourse = randomUUID();
    await base.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES
      (${course},${base.scope.workspaceId},'真实课程 中文',${course}),
      (${foreignCourse},${base.otherScope.workspaceId},'不得泄漏课程',${foreignCourse})`;
    const included = await base.rows.source();
    const excluded = await base.rows.source();
    const uploading = await base.rows.source("pending");
    const foreignSource = await backupRows(base.sql, base.otherScope).source();
    await base.rows.exclude(excluded);
    for (const source of [included, excluded, uploading]) {
      await base.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
        VALUES(${base.scope.workspaceId},${course},'source',${source},'reference','private')`;
    }
    const includedRef = {
      sourceId: included, sourceVersion: 1, chunkId: randomUUID(), page: 7,
      metadata: { label: "捕获时原文", url: "https://example.invalid/%E4%B8%AD?q=a%2Fb#old", nested: [3, "原值"] },
    };
    const foreignRequirement = randomUUID();
    await base.sql`INSERT INTO course_requirements(id,workspace_id,owner_user_id,course_id,stable_skill_id,requirement_key,title,source_refs,verification)
      VALUES(${foreignRequirement},${base.otherScope.workspaceId},${base.otherScope.ownerUserId},${foreignCourse},${randomUUID()},
        ${foreignRequirement},'不得泄漏要求',${base.sql.json([{sourceId: foreignSource}])},${base.sql.json(originalVerification)})`;
    const requirementIds: string[] = [];
    async function requirement(refs: JSONValue = [], omit = false) {
      const id = randomUUID(), skill = randomUUID(), node = randomUUID();
      const predecessors = requirementIds.slice(-1);
      // Omission is a real INSERT omission. Never drop a column, weaken NOT NULL,
      // disable a trigger, or synthesize a SELECT result to create a legacy row.
      const columns = {
        id, workspace_id: base.scope.workspaceId, owner_user_id: base.scope.ownerUserId,
        course_id: course, stable_skill_id: skill, knowledge_node_id: node,
        requirement_key: id, title: "原始要求 https://example.invalid/title#原文",
        position: requirementIds.length, mandatory: requirementIds.length % 2 === 0,
        prerequisite_ids: predecessors, verification: base.sql.json(originalVerification),
        approved_at: new Date("2026-10-01T00:00:00Z"),
        // Object INSERT helpers accept JSON parameters, not SQL fragments.
        ...(omit || refs === null ? {} : { source_refs: base.sql.json(refs) }),
      };
      await base.sql`INSERT INTO course_requirements ${base.sql(columns)}`;
      if (!omit && refs === null) {
        // A fixed SQL literal persists JSON null without postgres.js treating a
        // JS null as SQL NULL or inferring the text parameter as JSON string.
        await base.sql`UPDATE course_requirements SET source_refs='null'::jsonb WHERE id=${id}`;
      }
      requirementIds.push(id);
      return id;
    }
    return { ...base, reader, course, included, excluded, uploading, foreignSource, foreignRequirement,
      includedRef, requirement, requirementIds,
      async stored(sql: Sql = base.sql) {
        return [...await sql`SELECT * FROM course_requirements WHERE workspace_id=${base.scope.workspaceId} ORDER BY id`];
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
export type CourseLineagePgFixture = Awaited<ReturnType<typeof createCourseLineagePgFixture>>;
