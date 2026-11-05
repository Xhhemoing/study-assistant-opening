import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { readOpeningSourceContent } from "./opening-source-content";

const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const source = { version: 1, mime: "application/pdf", parse_state: "ready", upload_state: "uploaded",
  published: false, ai_excluded: true, error: null };

// Exercise the real reader's decision branch; SQL authorization/filtering is
// covered by the persistence/unchanged ephemeral handler tests, not this stub.
function database(row: Record<string, unknown> | undefined): Sql {
  const sql = ((parts: TemplateStringsArray) => {
    const query = parts.join("?");
    if (query.includes("FROM opening_sources s")) return Promise.resolve(row ? [row] : []);
    if (query.includes("GROUP BY page")) return Promise.resolve([{ page: 1, characters: 7, readable: true }]);
    if (query.includes("left(text,20001)")) return Promise.resolve([{ text: "private" }]);
    throw new Error(`Unexpected SQL: ${query}`);
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

  it("does not convert owner/source lookup failures or future versions into readable content", async () => {
    await expect(readOpeningSourceContent(database(undefined), scope, "source", {}))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readOpeningSourceContent(database(source), scope, "source", { version: 2 }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
