import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { failOpeningJob } from "./opening-job-failure";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const SOURCE = "00000000-0000-4000-8000-000000000003";

type Recorded = { query: string; values: unknown[] };

function fakeSql(job: { payload: unknown; privacy_epoch: number; kind?: string }, workspaceEpoch = 7) {
  const recorded: Recorded[] = [];
  const kind = job.kind ?? "parse";
  const sql = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?").replace(/\s+/g, " ").trim();
    recorded.push({ query, values });
    if (query.startsWith("SELECT w.id")) return Promise.resolve([{ id: WORKSPACE, owner_user_id: "user-1", privacy_epoch: workspaceEpoch }]);
    if (query.startsWith("UPDATE opening_jobs")) {
      const { kind: _ignored, ...rest } = job;
      return Promise.resolve([{ kind, owner_user_id: "user-1", ...rest }]);
    }
    if (query.startsWith("UPDATE opening_sources")) return Promise.resolve([]);
    throw new Error(`unexpected query: ${query}`);
  }) as unknown as Sql;
  sql.json = ((value: unknown) => value) as never;
  sql.begin = (async (callback: (tx: Sql) => Promise<unknown>) => callback(sql)) as Sql["begin"];
  return { sql, recorded };
}

/** The last failure projection (claim release may follow it). */
function lastFailureProjection(recorded: Recorded[]): Recorded {
  return recorded.filter(({ query }) => query.startsWith("UPDATE opening_sources") && query.includes("parse_state = 'failed'")).at(-1)!;
}

/** Values bound to the `(? IS NULL OR s.version = ?)` version fence of a source update. */
function versionFenceValues(entry: Recorded): unknown[] {
  const parts = entry.query.split("?");
  const bound: unknown[] = [];
  entry.values.forEach((value, index) => {
    const before = parts[index] ?? "";
    const after = parts[index + 1] ?? "";
    if (after.startsWith("::integer IS NULL") || before.endsWith("s.version = ")) bound.push(value);
  });
  return bound;
}

describe("opening parse job failure projection", () => {
  it("projects a current parse failure without treating workspace epoch as source version", async () => {
    const { sql, recorded } = fakeSql({ payload: { sourceId: SOURCE }, privacy_epoch: 7 });

    await expect(failOpeningJob(sql, "job-1", { error: "failed" })).resolves.toBe(true);
    const update = lastFailureProjection(recorded);
    expect(update.query.startsWith("UPDATE opening_sources")).toBe(true);
    // Legacy payload without sourceVersion: the fence is disabled (null), never the epoch 7.
    expect(versionFenceValues(update)).toEqual([null, null]);
  });

  it("fences the source update to the version the parse job targeted", async () => {
    const { sql, recorded } = fakeSql({ payload: { sourceId: SOURCE, sourceVersion: 3 }, privacy_epoch: 7 });

    await expect(failOpeningJob(sql, "job-1", { error: "failed" })).resolves.toBe(true);
    expect(versionFenceValues(lastFailureProjection(recorded))).toEqual([3, 3]);
  });

  it("ignores a malformed sourceVersion instead of fencing on it", async () => {
    const { sql, recorded } = fakeSql({ payload: { sourceId: SOURCE, sourceVersion: "3" }, privacy_epoch: 7 });

    await expect(failOpeningJob(sql, "job-1", { error: "failed" })).resolves.toBe(true);
    expect(versionFenceValues(lastFailureProjection(recorded))).toEqual([null, null]);
  });

  it("marks a stale parse source failed so it cannot remain pending forever", async () => {
    const { sql, recorded } = fakeSql({ payload: { sourceId: SOURCE, sourceVersion: 0 }, privacy_epoch: 6 });

    await expect(failOpeningJob(sql, "job-1", { error: "stale" })).resolves.toBe(true);
    const sourceUpdates = recorded.filter(({ query }) => query.startsWith("UPDATE opening_sources") && query.includes("parse_state = 'failed'"));
    expect(sourceUpdates.length).toBe(2);
    for (const update of sourceUpdates) expect(versionFenceValues(update)).toEqual([0, 0]);
  });

  it("projects parse-media failure onto the source like parse", async () => {
    const { sql, recorded } = fakeSql({
      kind: "parse-media",
      payload: { sourceId: SOURCE, sourceVersion: 2 },
      privacy_epoch: 7,
    });

    await expect(failOpeningJob(sql, "job-media", { error: "media boom" })).resolves.toBe(true);
    const sourceUpdates = recorded.filter(({ query }) => query.startsWith("UPDATE opening_sources") && query.includes("parse_state = 'failed'"));
    expect(sourceUpdates.length).toBe(1);
    expect(sourceUpdates[0]!.query).toContain("parse_state = 'failed'");
    expect(versionFenceValues(sourceUpdates[0]!)).toEqual([2, 2]);
  });

  it("releases only its own running claim, after the failure projection", async () => {
    const { sql, recorded } = fakeSql({ payload: { sourceId: SOURCE, sourceVersion: 0 }, privacy_epoch: 7 });

    await expect(failOpeningJob(sql, "job-1", { error: "failed" })).resolves.toBe(true);
    const release = recorded.at(-1)!;
    expect(release.query).toContain("parse_state = 'not_started'");
    expect(release.query).toContain("s.parse_state = 'running'");
    // Another running parse job for the same source keeps the marker.
    expect(release.query).toContain("NOT EXISTS (SELECT 1 FROM opening_jobs j");
    expect(release.values).toContain(SOURCE);
  });

  it("does not touch sources for non-parse jobs", async () => {
    const { sql, recorded } = fakeSql({ kind: "compile-teaching-unit", payload: { sourceId: SOURCE }, privacy_epoch: 7 });

    await expect(failOpeningJob(sql, "job-c", { error: "x" })).resolves.toBe(true);
    expect(recorded.some(({ query }) => query.startsWith("UPDATE opening_sources"))).toBe(false);
  });
});
