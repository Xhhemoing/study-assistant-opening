import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { readOpeningSourceContent } from "./opening-source-content";

const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const source = { version: 1, mime: "application/pdf", parse_state: "ready", upload_state: "uploaded",
  published: false, ai_excluded: true, error: null };

const defaultChunks = [{ id: "public", page: 1, text: "private", characters: 7, readable: true }];

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

  it("uses the same publication scope for inventory and bodies and excludes whole answer chunks", async () => {
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
    for (const query of reads) {
      expect(query).toContain("pdf_pending_seals AS MATERIALIZED");
      expect(query).toContain("boundary.first_page<=c.page");
      expect(query).toContain("seal.page_start=c.page AND seal.page_end=c.page");
      expect(query).toContain("pdf_archive_sealed_spans AS MATERIALIZED");
      expect(query).toContain("bool_or(body ~* ?) AS section_answer");
      expect(query).toContain("bool_or(body ~* ?) AS answer_label");
      expect(query).toContain("regexp_replace(ltrim(body");
      expect(query.match(/\b(?:FROM|JOIN) opening_\w+/gu)).toHaveLength(6);
    }
    expect(reads[1]).toContain("c.id=ANY(?::uuid[])");
    await expect(readOpeningSourceContent(sql, scope, "source", { page: 3 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not convert owner/source lookup failures or future versions into readable content", async () => {
    await expect(readOpeningSourceContent(database(undefined), scope, "source", {}))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readOpeningSourceContent(database(source), scope, "source", { version: 2 }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
