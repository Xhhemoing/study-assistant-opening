import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { repairOpeningLatexEscapes } from "./opening-latex-escape-repair";

// What a plain JSON.parse made of "$a\times b = \frac{1}{2}$".
const corruptedBlock = JSON.parse('{"text":"$a\\times b = \\frac{1}{2}$\\n第二行"}') as { text: string };
const corruptedEvaluation = JSON.parse('{"feedback":"$\\beta \\neq 0$","criteria":[{"label":"x","verdict":"correct","feedback":"ok"}]}') as Record<string, unknown>;

function fakeSql(tables: { library_blocks: unknown[]; opening_learning_observations: unknown[]; library_revisions: unknown[] }) {
  const writes: Array<{ query: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (/^\s*UPDATE/.test(query)) {
      writes.push({ query, values });
      return Promise.resolve([{ id: values.at(-2) }]);
    }
    const after = values[0] as string;
    const table = (Object.keys(tables) as Array<keyof typeof tables>).find(name => query.includes(`FROM ${name}`))!;
    return Promise.resolve((tables[table] as Array<{ id: string }>).filter(row => row.id > after));
  }) as unknown as Sql;
  sql.json = ((value: unknown) => value) as Sql["json"];
  return { sql, writes };
}

const rows = () => ({
  library_blocks: [{ id: "00000000-0000-4000-8000-000000000001", content: corruptedBlock },
    { id: "00000000-0000-4000-8000-000000000002", content: { text: "$\\times$ intact" } }],
  opening_learning_observations: [{ id: "00000000-0000-4000-8000-000000000003", ai_evaluation: corruptedEvaluation }],
  library_revisions: [{ id: "00000000-0000-4000-8000-000000000004", blocks: [{ id: "b", content: corruptedBlock }] }],
});

describe("repairOpeningLatexEscapes", () => {
  it("dry run counts repairs without writing", async () => {
    const { sql, writes } = fakeSql(rows());
    const report = await repairOpeningLatexEscapes(sql);
    expect(writes).toEqual([]);
    expect(report.apply).toBe(false);
    expect(report.libraryBlocks).toEqual({ scanned: 2, affected: 1, repairs: 2, updated: 0 });
    expect(report.aiEvaluations).toEqual({ scanned: 1, affected: 1, repairs: 2, updated: 0 });
    expect(report.teachingRevisions).toEqual({ scanned: 1, affected: 1, repairs: 2 });
    expect(report.samples[0]?.after).toContain("\\\\times");
  });

  it("--apply writes repaired JSON with a compare-and-set and never touches revisions", async () => {
    const { sql, writes } = fakeSql(rows());
    const report = await repairOpeningLatexEscapes(sql, { apply: true, maxSamples: 0 });
    expect(report.samples).toEqual([]);
    expect(report.libraryBlocks.updated).toBe(1);
    expect(report.aiEvaluations.updated).toBe(1);
    expect(writes.map(write => write.query.trim().split(/\s+/).slice(0, 2).join(" "))).toEqual([
      "UPDATE library_blocks", "UPDATE opening_learning_observations",
    ]);
    expect(writes.some(write => write.query.includes("library_revisions"))).toBe(false);
    const [block, evaluation] = writes;
    expect(block!.values[0]).toEqual({ text: "$a\\times b = \\frac{1}{2}$\n第二行" });
    expect(block!.values.at(-1)).toBe(corruptedBlock);
    expect((evaluation!.values[0] as { feedback: string }).feedback).toBe("$\\beta \\neq 0$");
  });
});
