import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { loadTutorHistory, loadTutorHistoryContext } from "./opening-tutor-history";

const scope = { workspaceId: "workspace-1", ownerUserId: "owner-1" };
const sourceId = "00000000-0000-4000-8000-000000000001";
function fakeSql(rows: Record<string, unknown>[]) {
  const sql = (async (strings: TemplateStringsArray) => {
    if (!strings.join("").includes("WITH prior")) return [];
    return rows;
  }) as unknown as Sql;
  sql.unsafe = (() => "fragment") as unknown as Sql["unsafe"];
  return sql;
}

describe("loadTutorHistory context selection", () => {
  it("keeps compatibility history while carrying the selected exchanges' lineage", async () => {
    const sql = fakeSql([{ question: "question", answer: "answer", user_source_refs: [],
      assistant_source_refs: [{ sourceId, sourceVersion: 0 }] }]);
    expect(await loadTutorHistoryContext(sql, scope, "turn-1")).toEqual({
      history: [{ role: "user", text: "question" }, { role: "assistant", text: "answer" }],
      sourceRefs: [{ sourceId, sourceVersion: 0 }],
    });
    expect(await loadTutorHistory(sql, scope, "turn-1")).toEqual([
      { role: "user", text: "question" }, { role: "assistant", text: "answer" },
    ]);
  });
  it("does not inherit provenance from an exchange omitted by the character limit", async () => {
    const sql = fakeSql([
      { question: "recent", answer: "answer", user_source_refs: [], assistant_source_refs: [] },
      { question: "x".repeat(12001), answer: "old", user_source_refs: [], assistant_source_refs: [{ sourceId, sourceVersion: 0 }] },
    ]);
    expect(await loadTutorHistoryContext(sql, scope, "turn-1")).toEqual({
      history: [{ role: "user", text: "recent" }, { role: "assistant", text: "answer" }], sourceRefs: [],
    });
  });
  it("projects only human questions for record follow-ups, without query snapshot prose", async () => {
    const sql = fakeSql([{ question: "昨天完成了哪些任务", answer: "snapshot".repeat(2000),
      user_source_refs: [], assistant_source_refs: [{ sourceId, sourceVersion: 0 }] }]);
    expect(await loadTutorHistoryContext(sql, scope, "turn-1", "record_referents")).toEqual({
      history: [{ role: "user", text: "昨天完成了哪些任务" }],
      sourceRefs: [{ sourceId, sourceVersion: 0 }],
    });
  });
  it("preserves memoryOnly history lineage and filters expired/inactive memoryOnly turns via clock_timestamp()", async () => {
    const queries: string[] = [];
    const memorySourceId = "00000000-0000-4000-8000-000000000002";
    const sql = (async (strings: TemplateStringsArray) => {
      const text = strings.join("?").replace(/\s+/g, " ").trim();
      queries.push(text);
      if (!text.includes("WITH prior")) return [];
      return [{
        question: "question", answer: "answer",
        user_source_refs: [{ sourceId, sourceVersion: 0 }],
        assistant_source_refs: [
          { sourceId, sourceVersion: 0 },
          { sourceId: memorySourceId, sourceVersion: 0, memoryOnly: true },
        ],
      }];
    }) as unknown as Sql;
    sql.unsafe = (() => "fragment") as unknown as Sql["unsafe"];
    const result = await loadTutorHistoryContext(sql, scope, "turn-1");
    expect(result.sourceRefs).toEqual([
      { sourceId, sourceVersion: 0 },
      { sourceId: memorySourceId, sourceVersion: 0, memoryOnly: true },
    ]);
    expect(queries.some(q => q.includes("(mem_ref->>'memoryOnly') = 'true'") && q.includes("m.expires_at > clock_timestamp()"))).toBe(true);
  });
});
