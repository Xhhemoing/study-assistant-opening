import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import {
  READY_COURSE_SOURCE_IDS_CAP,
  createOpeningCourseReadySourcesRepository,
  listReadySourceIdsForCourse,
} from "./opening-course-ready-sources";
import { OpeningKnowledgeError } from "./opening-knowledge";

const W = "00000000-0000-4000-8000-0000000000w1";
const U = "00000000-0000-4000-8000-0000000000u1";
const COURSE = "00000000-0000-4000-8000-0000000000c1";
const S1 = "00000000-0000-4000-8000-0000000000s1";
const S2 = "00000000-0000-4000-8000-0000000000s2";
const scope = { workspaceId: W, ownerUserId: U };

function makeSql(opts: {
  courseFound?: boolean;
  rows?: Array<Record<string, unknown>>;
  onQuery?: (q: string, values: unknown[]) => void;
}): Sql {
  const sql = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    if (!Object.hasOwn(parts, "raw")) {
      return parts as unknown;
    }
    const q = parts.join("?").replace(/\s+/g, " ").trim();
    opts.onQuery?.(q, values);
    if (q.startsWith("SELECT c.id FROM courses")) {
      return Promise.resolve(opts.courseFound === false ? [] : [{ id: COURSE }]);
    }
    if (q.includes("FROM course_asset_memberships")) {
      return Promise.resolve(opts.rows ?? []);
    }
    throw new Error("unexpected SQL: " + q);
  }) as unknown as Sql;
  Object.assign(sql, {
    begin: async (cb: (tx: Sql) => Promise<unknown>) => cb(sql),
  });
  return sql;
}

describe("listReadySourceIdsForCourse", () => {
  it("returns [] when course has no ready membership sources", async () => {
    const sql = makeSql({ rows: [] });
    await expect(listReadySourceIdsForCourse(sql, scope, COURSE)).resolves.toEqual([]);
  });

  it("throws OpeningKnowledgeError NOT_FOUND when course is not owned / archived", async () => {
    const sql = makeSql({ courseFound: false });
    await expect(listReadySourceIdsForCourse(sql, scope, COURSE)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(listReadySourceIdsForCourse(sql, scope, COURSE)).rejects.toBeInstanceOf(
      OpeningKnowledgeError,
    );
  });

  it("returns ready membership source ids in SQL order", async () => {
    const sql = makeSql({
      rows: [{ id: S1 }, { id: S2 }],
    });
    await expect(listReadySourceIdsForCourse(sql, scope, COURSE)).resolves.toEqual([S1, S2]);
  });

  it("SQL excludes privacy-excluded sources via NOT EXISTS", async () => {
    let listQuery = "";
    const sql = makeSql({
      rows: [],
      onQuery: (q) => {
        if (q.includes("course_asset_memberships")) listQuery = q;
      },
    });
    await listReadySourceIdsForCourse(sql, scope, COURSE);
    expect(listQuery).toMatch(/NOT EXISTS/);
    expect(listQuery).toMatch(/opening_privacy_exclusions/);
    expect(listQuery).toMatch(/e\.workspace_id = s\.workspace_id/);
    expect(listQuery).toMatch(/e\.source_id = s\.id/);
  });

  it("SQL requires uploaded + parse ready and membership asset_type source", async () => {
    let listQuery = "";
    const sql = makeSql({
      rows: [],
      onQuery: (q) => {
        if (q.includes("course_asset_memberships")) listQuery = q;
      },
    });
    await listReadySourceIdsForCourse(sql, scope, COURSE);
    expect(listQuery).toMatch(/upload_state = 'uploaded'/);
    expect(listQuery).toMatch(/parse_state = 'ready'/);
    expect(listQuery).toMatch(/asset_type = 'source'/);
    expect(listQuery).toMatch(/ORDER BY m\.sort_order ASC, m\.created_at ASC, s\.id ASC/);
  });

  it("SQL caps at READY_COURSE_SOURCE_IDS_CAP (32)", async () => {
    let listQuery = "";
    let listValues: unknown[] = [];
    const sql = makeSql({
      rows: Array.from({ length: 32 }, (_, i) => ({
        id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
      })),
      onQuery: (q, values) => {
        if (q.includes("course_asset_memberships")) {
          listQuery = q;
          listValues = values;
        }
      },
    });
    const ids = await listReadySourceIdsForCourse(sql, scope, COURSE);
    expect(READY_COURSE_SOURCE_IDS_CAP).toBe(32);
    expect(ids).toHaveLength(32);
    expect(listQuery).toMatch(/LIMIT \?/);
    expect(listValues[listValues.length - 1]).toBe(READY_COURSE_SOURCE_IDS_CAP);
  });

  it("repository factory wires listReadySourceIdsForCourse(scope, courseId)", async () => {
    const sql = makeSql({ rows: [{ id: S1 }] });
    const repo = createOpeningCourseReadySourcesRepository(sql);
    await expect(repo.listReadySourceIdsForCourse(scope, COURSE)).resolves.toEqual([S1]);
  });
});
