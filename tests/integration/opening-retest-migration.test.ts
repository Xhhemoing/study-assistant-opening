import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createSqlClient } from "@aistudy/database";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for retest migration tests");

const sql = createSqlClient(databaseUrl, { max: 1 });
const schema = `retest_migration_${randomUUID().replaceAll("-", "")}`;
const userId = randomUUID();
const workspaceId = randomUUID();
const courseId = randomUUID();
const jobId = randomUUID();
const taskId = randomUUID();

beforeAll(async () => {
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  await sql.unsafe(`SET search_path TO ${schema}, public`);
  await sql.unsafe(`
    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE workspaces (id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES users(id));
    CREATE TABLE courses (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id));
    CREATE TABLE opening_jobs (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), owner_user_id uuid NOT NULL REFERENCES users(id),
      key text NOT NULL, kind text NOT NULL, payload jsonb NOT NULL, state text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE opening_tasks (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), owner_user_id uuid NOT NULL REFERENCES users(id),
      candidate_id uuid, status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE opening_learning_observations (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, owner_user_id uuid NOT NULL, retest_id uuid,
      outcome text, occurred_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await sql`INSERT INTO users (id) VALUES (${userId})`;
  await sql`INSERT INTO workspaces (id, owner_user_id) VALUES (${workspaceId}, ${userId})`;
  await sql`INSERT INTO courses (id, workspace_id) VALUES (${courseId}, ${workspaceId})`;
  await sql`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, state)
    VALUES (${jobId}, ${workspaceId}, ${userId}, 'upper-retest', 'retest', ${sql.json({
      courseId: courseId.toUpperCase(), taskId: taskId.toUpperCase(), skillLabel: "fractions", accepted: true,
    })}, 'succeeded')`;
  await sql`INSERT INTO opening_tasks (id, workspace_id, owner_user_id, candidate_id, status)
    VALUES (${taskId}, ${workspaceId}, ${userId}, ${jobId}, 'pending')`;
  const migration = await readFile(
    path.resolve(process.cwd(), "packages/database/src/migrations/0030_opening_retest_activities.sql"),
    "utf8",
  );
  await sql.unsafe(migration);
});

afterAll(async () => {
  await sql.unsafe("SET search_path TO public");
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await sql.end({ timeout: 5 });
});

it("migrates legacy retests when course and task UUID payloads use uppercase", async () => {
  const activities = await sql`
    SELECT course_id, task_id, status FROM opening_retest_activities WHERE candidate_id = ${jobId}
  `;
  expect(activities).toEqual([{ course_id: courseId, task_id: taskId, status: "accepted" }]);
  const jobs = await sql`SELECT payload->'retestActivityMigration' AS migration FROM opening_jobs WHERE id = ${jobId}`;
  expect(jobs[0]?.migration).toBeNull();
});
