import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { containsPdfAnswerLabel, isPublicSourceChunk } from "./opening-knowledge-definitions";
import { readOpeningSourceContent } from "./opening-source-content";

const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const source = { version: 1, mime: "application/pdf", parse_state: "ready", upload_state: "uploaded",
  published: false, ai_excluded: true, error: null };

const defaultChunks = [{ id: "public", page: 1, text: "private", characters: 7, readable: true }];

it("recognizes contextual appendix and capitalized period labels in PDF text", () => {
  const solutions = "## Solutions (cont.):\n\n[原生提取]\nPage 304\nChapter 1 Exercises\n1. A hidden answer.";
  const chemistry = "## Solutions\nA homogeneous mixture.";
  expect(isPublicSourceChunk({ mime: "application/pdf", page: 304, text: solutions })).toBe(false);
  expect(isPublicSourceChunk({ mime: "application/pdf", page: 1, text: chemistry })).toBe(true);
  for (const line of ["Solution.", "SOLUTION.", "Answer.", "ANSWER.", "Full solutions.", "Official answer."]) {
    expect(containsPdfAnswerLabel(`Problem 1. Find x.\n${line} The answer is private.`), line).toBe(true);
  }
  expect(containsPdfAnswerLabel("Theorem 2.1: Ax = b has a unique\nsolution. Moreover, x = A^{-1}b.")).toBe(false);
  expect(containsPdfAnswerLabel("Example 1: Factor x.\nSolution. The worked example is public.")).toBe(false);
});

it("keeps PDF worked-example context until a genuine structural heading", () => {
  const exampleWith = (line: string) => `Worked Example 1: Factor x.\n${line}\n【解析】\nThe derivation follows.`;
  for (const line of ["Chapter 2: What Is Algebra? — Page 12", "What Is Algebra? — Page 12", "3.14 Hz", "3.14 MB",
    "3.14 千瓦时", "3.14 毫安时", "3.14 公顷", "3.14 有实数解", "3.14 在区间内",
    "Theorem 2.1 (Lagrange), applied to G, gives the result.", "## Theorem 2.1 (Lagrange), applied to G, gives the result.",
    "## Chapter 2 gives the result.", "## 图 2（a）显示了函数图像。", "## Example 1 gives the result.",
    "## The construction is shown below."]) {
    expect(containsPdfAnswerLabel(exampleWith(line)), line).toBe(false);
  }
  for (const line of ["2.1 有限群", "2.1 AI", "2.1 ML", "2.1 OS", "2.1 LP", "定理 2.1（拉格朗日定理）", "Definition 1.2",
    "Chapter 2: What Is Algebra? — Page 12\nTheorem 2.1 (Lagrange)", "Preface", "前言"]) {
    expect(containsPdfAnswerLabel(exampleWith(line)), line).toBe(true);
  }
});

it.each(["Solution:", "解答：", "Solution 1:"])(
  "recognizes %s as an answer label outside worked examples",
  label => {
    expect(containsPdfAnswerLabel(`1. Decide whether every cyclic group is abelian.\n${label}\nYes.`)).toBe(true);
  },
);

it("keeps numbered worked-example solutions public while recognizing explicit answer keys", () => {
  const example = "Example 1: Quadratic Equations\nSolution 1: Factor the polynomial.\nSolution 2: Complete the square.";
  expect(containsPdfAnswerLabel(example)).toBe(false);
  expect(containsPdfAnswerLabel(example + "\nExercises\nSolution 1: A private derivation.")).toBe(true);
  expect(containsPdfAnswerLabel(example + "\nOfficial Solution 1: A private derivation.")).toBe(true);
  expect(containsPdfAnswerLabel(example + "\nCorrect Solution. Yes.")).toBe(true);
  expect(containsPdfAnswerLabel(example + "\nSolution to Exercise 1: A private derivation.")).toBe(true);
});

it("seals auxiliary PDF answer labels while taking worked-example context from primary text", () => {
  const example = "Example 1: Quadratic Equations";
  const answer = "Solution:\nThe derivation follows.";
  for (const header of ["【图表观察描述，非原文或解答】", "【识别不确定，不能据此判定正确】",
    "[图片描述]", "[图像描述]", "[图示与版面描述]", "[不确定处]"]) {
    expect(containsPdfAnswerLabel(`${header}\n${example}\n[转写]\n${answer}`), header).toBe(true);
    expect(containsPdfAnswerLabel(`${example}\n${header}\nChapter 2: Geometry\n[转写]\n${answer}`), header).toBe(false);
    expect(containsPdfAnswerLabel(`${example}\n${header}\nOfficial Solution: A description.`), header).toBe(true);
  }
});

function database(row: Record<string, unknown> | undefined, chunks = defaultChunks, reads: string[] = []): Sql {
  const sql = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.map((part, index) => {
      const value = values[index];
      return part + (typeof value === "object" && value && "fragment" in value ? value.fragment
        : index < values.length ? "?" : "");
    }).join("").replace(/\s+/gu, " ").trim();
    if (query.includes("AS ai_excluded")) return Promise.resolve(row ? [row] : []);
    if (query.includes("AS readable,c.text")) {
      reads.push(query);
      return { async *cursor() { yield chunks; } };
    }
    if (query.includes("left(c.text,20001)")) {
      reads.push(query);
      const permitted = values.find(Array.isArray) ?? [];
      return Promise.resolve(chunks.filter(chunk => permitted.includes(chunk.id)));
    }
    return { fragment: query };
  }) as unknown as Sql;
  sql.begin = (async (_options: string, callback: (tx: Sql) => Promise<unknown>) => callback(sql)) as Sql["begin"];
  return sql;
}

describe("source content self-read versus additional PDF retry access", () => {
  it("retains ordinary ready and explicit historical self-reads despite AI exclusion", async () => {
    expect(await readOpeningSourceContent(database(source), scope, "source", {}))
      .toMatchObject({ version: 1, currentVersion: 1, text: "private" });
    expect(await readOpeningSourceContent(database({ ...source, version: 2, parse_state: "queued",
      error: { code: "PRIVACY_EXCLUDED" } }), scope, "source", { version: 1 }))
      .toMatchObject({ version: 1, currentVersion: 2, text: "private" });
  });

  it.each(["queued", "running", "failed", "not_started"])("permits %s only with same-version publication and no exclusion", async parse_state => {
    const published = { ...source, parse_state, published: true, ai_excluded: false };
    expect(await readOpeningSourceContent(database(published), scope, "source", {}))
      .toMatchObject({ version: 1, text: "private" });
    for (const denied of [{ ...published, ai_excluded: true }, { ...published, published: false },
      { ...published, error: { code: "PRIVACY_EXCLUDED" } }, { ...published, upload_state: "rejected" }]) {
      await expect(readOpeningSourceContent(database(denied), scope, "source", {}))
        .rejects.toMatchObject({ code: "CONFLICT" });
    }
  });

  it("reads only the authorized IDs from the same PDF inventory snapshot", async () => {
    const reads: string[] = [];
    const answer = "[原生提取]\nChapter 2: Geometry\n\n[视觉转写与描述]\n"
      + "【原图忠实转写，尚需核对】\n**Ans**wers to Review Questions\n5 units.";
    const chunks = [...defaultChunks,
      { id: "blank", page: 2, text: "", characters: 0, readable: false },
      { id: "mixed-page-answer", page: 2, text: answer, characters: answer.length, readable: true },
      { id: "answer-only", page: 3, text: answer, characters: answer.length, readable: true },
    ];
    const sql = database(source, chunks, reads);
    expect(await readOpeningSourceContent(sql, scope, "source", { page: 2 })).toMatchObject({
      pages: [1, 2], readablePages: 1, characters: 7, text: "",
    });
    expect(reads).toHaveLength(2);
    const [inventory, body] = reads;
    expect(inventory).toContain("pdf_pending_seals AS MATERIALIZED");
    expect(inventory).toContain("boundary.first_page<=c.page");
    expect(inventory).toContain("seal.page_start=c.page AND seal.page_end=c.page");
    expect(inventory).toContain("pdf_archive_sealed_spans AS MATERIALIZED");
    expect(inventory).toContain("archived_page.source_id=c.source_id AND archived_page.source_version=c.source_version AND archived_page.page=c.page");
    expect(inventory).toContain("archived_chunk.chunk_id=c.id");
    expect(inventory).toContain("ORDER BY c.page NULLS LAST,c.created_at,c.id");
    expect(body).toContain("c.source_id=? AND c.source_version=? AND c.page IS NOT DISTINCT FROM ? AND c.id=ANY(?::uuid[])");
    expect(body).not.toContain("pdf_archive_sealed_spans");
    await expect(readOpeningSourceContent(sql, scope, "source", { page: 3 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("seals same-page split Solutions chunks across chunk boundaries while isolating auxiliary blocks and keeping question chunks public", async () => {
    const splitSolutions = [
      ...defaultChunks,
      { id: "sol-head", page: 2, text: "Solutions\n######\n[图片描述]\nDiagram", characters: 33, readable: true },
      { id: "sol-ctx", page: 2, text: "1. The result is 42.", characters: 20, readable: true },
      { id: "sol-tail", page: 2, text: "2. More hidden answers.", characters: 23, readable: true },
    ];
    await expect(readOpeningSourceContent(database(source, splitSolutions), scope, "source", { page: 2 }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readOpeningSourceContent(database(source, splitSolutions), scope, "source", { page: 1 }))
      .resolves.toMatchObject({ pages: [1], text: "private" });

    const splitQuestionAndSolution = [
      { id: "q1", page: 1, text: "1. Find x.", characters: 10, readable: true },
      { id: "s1", page: 1, text: "Solution:\nx = 2", characters: 15, readable: true },
    ];
    await expect(readOpeningSourceContent(database(source, splitQuestionAndSolution), scope, "source", { page: 1 }))
      .resolves.toMatchObject({ pages: [1], characters: 10, text: "1. Find x." });

    const isolatedAuxiliary = [
      { id: "aux-sol", page: 1, text: "Chapter 1\n[图片描述]\nSolutions", characters: 26, readable: true },
      { id: "prim-q", page: 1, text: "1. Find x.", characters: 10, readable: true },
    ];
    await expect(readOpeningSourceContent(database(source, isolatedAuxiliary), scope, "source", { page: 1 }))
      .resolves.toMatchObject({ pages: [1], text: "Chapter 1\n[图片描述]\nSolutions\n\n1. Find x." });

    for (const [lead, label] of [
      ["1. Find x.", "Solution:"],
      ["Chapter 2", "Answer:"],
      ["Problem 1.", "Official Solution:"],
    ] as const) {
      const threeChunkAnswer = [
        { id: "c0", page: 1, text: lead, characters: lead.length, readable: true },
        { id: "c1", page: 1, text: label, characters: label.length, readable: true },
        { id: "c2", page: 1, text: "x = 2", characters: 5, readable: true },
      ];
      await expect(readOpeningSourceContent(database(source, threeChunkAnswer), scope, "source", { page: 1 }))
        .resolves.toMatchObject({ pages: [1], characters: lead.length, text: lead });
    }

    for (const opener of ["Answer:", "Solutions", "Official Solution:"]) {
      const allSealed = [
        ...defaultChunks,
        { id: "a0", page: 2, text: opener, characters: opener.length, readable: true },
        { id: "a1", page: 2, text: "1. The result is 42.", characters: 20, readable: true },
        { id: "a2", page: 2, text: "2. Next answer.", characters: 15, readable: true },
      ];
      await expect(readOpeningSourceContent(database(source, allSealed), scope, "source", { page: 2 }))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
    }

    const workedExampleChunks = [
      { id: "w0", page: 1, text: "Worked Example 1: Factor x^2 - 1.", characters: 33, readable: true },
      { id: "w1", page: 1, text: "Solution:", characters: 9, readable: true },
      { id: "w2", page: 1, text: "(x - 1)(x + 1).", characters: 15, readable: true },
    ];
    await expect(readOpeningSourceContent(database(source, workedExampleChunks), scope, "source", { page: 1 }))
      .resolves.toMatchObject({
        pages: [1],
        text: "Worked Example 1: Factor x^2 - 1.\n\nSolution:\n\n(x - 1)(x + 1).",
      });

    const reopenedTheorem = [
      { id: "t0", page: 1, text: "1. Find x.", characters: 10, readable: true },
      { id: "t1", page: 1, text: "Solution: x = 2.", characters: 16, readable: true },
      { id: "t2", page: 1, text: "## Theorem 2.1\nEvery cyclic group is abelian.", characters: 45, readable: true },
    ];
    await expect(readOpeningSourceContent(database(source, reopenedTheorem), scope, "source", { page: 1 }))
      .resolves.toMatchObject({
        pages: [1],
        text: "1. Find x.\n\n## Theorem 2.1\nEvery cyclic group is abelian.",
      });

    const reopenedExercise = [
      { id: "e0", page: 1, text: "1. Find x.", characters: 10, readable: true },
      { id: "e1", page: 1, text: "Solution:\nx = 2.", characters: 16, readable: true },
      { id: "e2", page: 1, text: "2. Find y.", characters: 10, readable: true },
    ];
    await expect(readOpeningSourceContent(database(source, reopenedExercise), scope, "source", { page: 1 }))
      .resolves.toMatchObject({ pages: [1], text: "1. Find x.\n\n2. Find y." });

    const unlabeledContinuation = [
      { id: "u0", page: 1, text: "1. Find x.", characters: 10, readable: true },
      { id: "u1", page: 1, text: "Solution:\nx = 2.", characters: 16, readable: true },
      { id: "u2", page: 1, text: "Therefore x = 2.", characters: 16, readable: true },
    ];
    await expect(readOpeningSourceContent(database(source, unlabeledContinuation), scope, "source", { page: 1 }))
      .resolves.toMatchObject({ pages: [1], text: "1. Find x." });
  });

  it("does not convert owner/source lookup failures or future versions into readable content", async () => {
    await expect(readOpeningSourceContent(database(undefined), scope, "source", {}))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readOpeningSourceContent(database(source), scope, "source", { version: 2 }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
