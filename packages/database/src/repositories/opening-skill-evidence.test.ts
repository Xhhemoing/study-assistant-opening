import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createOpeningSkillEvidenceRepository } from "./opening-skill-evidence";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const ownerUserId = "00000000-0000-4000-8000-000000000002";
const courseId = "00000000-0000-4000-8000-000000000003";
const nodeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const observationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const scope = { workspaceId, ownerUserId };

function db(handler: (query: string, values: unknown[]) => unknown[]) {
  const sql = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!Object.hasOwn(strings as object, "raw")) return strings;
    const query = (strings as TemplateStringsArray).join("?");
    return Promise.resolve(handler(query, values));
  }) as unknown as Sql;
  sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
  return sql;
}

describe("opening skill evidence repository (unit)", () => {
  it("rejects link when workspace is missing", async () => {
    const sql = db((query) => {
      if (query.includes("FROM workspaces")) return [];
      return [];
    });
    await expect(
      createOpeningSkillEvidenceRepository(sql).link(scope, {
        nodeId,
        observationId,
        dimension: "transfer",
        courseId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects link when observation is outside the scope", async () => {
    const sql = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_learning_observations")) return [];
      return [];
    });
    await expect(
      createOpeningSkillEvidenceRepository(sql).link(scope, {
        nodeId,
        observationId,
        dimension: "recall",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects courseId that does not match the observation", async () => {
    const sql = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_learning_observations")) {
        return [{ id: observationId, course_id: courseId, assistance: "independent" }];
      }
      return [];
    });
    await expect(
      createOpeningSkillEvidenceRepository(sql).link(scope, {
        nodeId,
        observationId,
        dimension: "explain",
        courseId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects nodeId missing from an existing knowledge snapshot", async () => {
    const sql = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_learning_observations")) {
        return [{ id: observationId, course_id: courseId, assistance: "independent" }];
      }
      if (query.includes("FROM courses")) return [{ id: courseId }];
      if (query.includes("FROM opening_course_knowledge")) {
        return [{
          snapshot: {
            courseId,
            version: 1,
            nodes: [{
              id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
              courseId,
              label: "other",
              kind: "concept",
              evidenceChunkIds: [],
              status: "suggested",
            }],
            edges: [],
          },
        }];
      }
      return [];
    });
    await expect(
      createOpeningSkillEvidenceRepository(sql).link(scope, {
        nodeId,
        observationId,
        dimension: "procedure",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("nodeId") });
  });
});
