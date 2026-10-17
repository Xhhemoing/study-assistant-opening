import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Sql } from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertOpeningTestDatabase } from "@aistudy/config";
import { createOpeningMeasurementRepository, createSqlClient } from "@aistudy/database";
import { getMeasurementUnit } from "@aistudy/domain/measurement-catalog";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const runFile = promisify(execFile);
const schema = `measurement_recovery_${randomUUID().replaceAll("-", "")}`;
const tables = ["opening_measurement_trials", "opening_measurement_attempts", "opening_measurement_commands"];
const key = () => `measurement-recovery:${randomUUID()}`;
const unit = getMeasurementUnit("calculus-parts-v1")!;
let fixture: OpeningFixture;
let isolatedSql: Sql | undefined;
let directory: string | undefined;
let connectionUrl: URL;

beforeAll(async () => {
  connectionUrl = assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL ?? "", process.env.OPENING_TEST_DB);
  fixture = await createOpeningFixture();
  directory = await mkdtemp(path.join(tmpdir(), "opening-measurement-recovery-"));
  await fixture.sql`CREATE SCHEMA ${fixture.sql(schema)}`;
  const scopedUrl = new URL(connectionUrl);
  scopedUrl.searchParams.set("search_path", `${schema},public`);
  isolatedSql = createSqlClient(scopedUrl.toString());
  await isolatedSql.unsafe(await readFile(new URL("../../packages/database/src/migrations/0066_opening_measurement.sql", import.meta.url), "utf8"));
});

afterAll(async () => {
  await isolatedSql?.end({ timeout: 5 });
  if (fixture) {
    await fixture.sql`DROP SCHEMA IF EXISTS ${fixture.sql(schema)} CASCADE`;
    await fixture.close();
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function persistedFacts(sql: Sql) {
  return Promise.all(tables.map(async table => Array.from(
    await sql`SELECT to_jsonb(entry) AS document FROM ${sql(table)} AS entry ORDER BY id`,
    row => row.document,
  )));
}

it("restores frozen trials, predictions and receipts from pg_dump and resumes without disclosing delayed answers", async () => {
  let sql = isolatedSql!;
  let repository = createOpeningMeasurementRepository(sql);
  const courseId = randomUUID();
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES (${courseId},${fixture.scope.workspaceId},'Measurement recovery',${courseId})`;
  const enrollment = { courseId, unitId: "calculus-parts-v1" as const, clientKey: key() };
  let overview = await repository.start(fixture.scope, enrollment);
  const trialId = overview.trial!.id;
  for (let index = 0; index < 6; index += 1) {
    overview = await repository.next(fixture.scope, { trialId, clientKey: key() });
    const attempt = overview.attempts.at(-1)!;
    overview = await repository.act(fixture.scope, attempt.id, {
      action: "answer", answer: unit.items.find(item => item.id === attempt.item.id)!.correctOptionId, clientKey: key(),
    });
  }
  await sql`UPDATE opening_measurement_trials SET practice_completed_at=clock_timestamp()-interval '49 hours' WHERE id=${trialId}`;
  overview = await repository.next(fixture.scope, { trialId, clientKey: key() });
  const delayed = overview.attempts.at(-1)!;
  const delayedAnswer = {
    action: "answer" as const, answer: unit.items.find(item => item.id === delayed.item.id)!.correctOptionId, clientKey: key(),
  };
  await repository.act(fixture.scope, delayed.id, delayedAnswer);
  const pendingCommand = { trialId, clientKey: key() };
  overview = await repository.next(fixture.scope, pendingCommand);
  const pending = overview.attempts.at(-1)!;
  expect(overview.attempts.at(-2)).toMatchObject({ outcome: null, predictions: [], feedbackWithheld: true });
  expect(pending).toMatchObject({ answeredAt: null, predictions: [] });
  const before = await persistedFacts(sql);
  expect(before.map(rows => rows.length)).toEqual([1, 8, 15]);
  const [storedTrial] = await sql`SELECT catalog,models FROM opening_measurement_trials WHERE id=${trialId}`;
  expect(storedTrial!.catalog).toHaveLength(12);
  expect(storedTrial!.models).toHaveLength(2);

  // Test only the private schema; public fixture identities stay in place. The
  // deployment runbook uses a complete database archive to include those parents.
  // Credentials stay in process environment, never in executable arguments.
  const env = {
    ...process.env, PGHOST: connectionUrl.hostname.replace(/^\[(.*)\]$/, "$1"), PGPORT: connectionUrl.port || "5432",
    PGDATABASE: decodeURIComponent(connectionUrl.pathname.slice(1)), PGUSER: decodeURIComponent(connectionUrl.username),
    PGPASSWORD: decodeURIComponent(connectionUrl.password), PGOPTIONS: "",
  };
  const archive = path.join(directory!, "measurement.dump");
  await runFile("pg_dump", ["--format=custom", `--schema=${schema}`, `--file=${archive}`], { env, timeout: 30_000 });
  await sql.end({ timeout: 5 });
  isolatedSql = undefined;
  await fixture.sql`DROP SCHEMA ${fixture.sql(schema)} CASCADE`;
  await runFile("pg_restore", ["--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", `--dbname=${env.PGDATABASE}`, archive], { env, timeout: 30_000 });
  const scopedUrl = new URL(connectionUrl);
  scopedUrl.searchParams.set("search_path", `${schema},public`);
  isolatedSql = sql = createSqlClient(scopedUrl.toString());
  repository = createOpeningMeasurementRepository(sql);
  expect(await persistedFacts(sql)).toEqual(before);
  expect(await repository.read(fixture.scope, courseId)).toEqual(overview);

  // The original command keys remain valid after recovery; they cannot create a
  // fresh trial, overwrite a score or replace the already-presented question.
  expect(await repository.start(fixture.scope, enrollment)).toEqual(overview);
  expect(await repository.act(fixture.scope, delayed.id, delayedAnswer)).toEqual(overview);
  expect(await repository.next(fixture.scope, pendingCommand)).toEqual(overview);
  expect(await persistedFacts(sql)).toEqual(before);
  await expect(repository.act(fixture.scope, delayed.id, { ...delayedAnswer, answer: "different" })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(repository.export(fixture.otherScope, courseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  const exported = await repository.export(fixture.scope, courseId);
  expect(exported.attempts).toEqual(overview.attempts);
  expect(JSON.stringify(exported)).not.toContain("correctOptionId");
  for (const attempt of exported.attempts.filter(value => value.item.phase === "delay_48h")) {
    expect(attempt).toMatchObject({ outcome: null, predictions: [] });
    expect(attempt.item).not.toHaveProperty("solution");
    expect(attempt.item).not.toHaveProperty("hint");
  }

  overview = await repository.act(fixture.scope, pending.id, {
    action: "answer", answer: unit.items.find(item => item.id === pending.item.id)!.correctOptionId, clientKey: key(),
  });
  overview = await repository.next(fixture.scope, { trialId, clientKey: key() });
  const finalProbe = overview.attempts.at(-1)!;
  overview = await repository.act(fixture.scope, finalProbe.id, {
    action: "answer", answer: unit.items.find(item => item.id === finalProbe.item.id)!.correctOptionId, clientKey: key(),
  });
  expect(overview.trial!.id).toBe(trialId);
  expect(overview.trial!.startedAt).toBe(exported.trial!.startedAt);
  expect(overview.attempts.filter(attempt => attempt.item.phase === "delay_48h")).toHaveLength(3);
  expect(overview.attempts.filter(attempt => attempt.item.phase === "delay_48h").every(attempt =>
    attempt.outcome === "correct" && !attempt.feedbackWithheld && attempt.predictions.length === 2)).toBe(true);
  expect(overview.report.eligible).toBe(9);
}, 60_000);
