import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { loadTutorHistory } from "./opening-tutor-history";

const scope = { workspaceId: "workspace-1", ownerUserId: "owner-1" };

function fakeSql() {
  const queries: string[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    queries.push(query);
    if (query.includes("opening_privacy_exclusions") && !query.includes("opening_turns")) {
      return [{ source_id: "excluded-source" }];
    }
    expect(query).not.toMatch(/opening_privacy_exclusions/);
    expect(values).toContainEqual(["excluded-source"]);
    return [{ question: "kept question", answer: "kept answer" }];
  }) as unknown as Sql;
  return { sql, queries };
}

describe("loadTutorHistory privacy admission", () => {
  it("compares history refs to listExcludedSourceIds instead of a local privacy query", async () => {
    const privacy = await import("./opening-privacy");
    const listExcludedSourceIds = vi.fn(async () => ["excluded-source"]);
    const spy = vi.spyOn(privacy, "createOpeningPrivacyRepository").mockReturnValue({
      getWorkspaceEpoch: vi.fn(),
      isSourceExcluded: vi.fn(),
      listExcludedSourceIds,
      recordExclusions: vi.fn(),
    });
    const { sql, queries } = fakeSql();

    await expect(loadTutorHistory(sql, scope, "turn-1")).resolves.toEqual([
      { role: "user", text: "kept question" },
      { role: "assistant", text: "kept answer" },
    ]);

    expect(spy).toHaveBeenCalledWith(sql);
    expect(listExcludedSourceIds).toHaveBeenCalledWith(scope);
    expect(queries.some((query) => query.includes("FROM opening_privacy_exclusions"))).toBe(false);
    expect(queries.some((query) => query.includes("a.citations"))).toBe(true);
    spy.mockRestore();
  });
});
