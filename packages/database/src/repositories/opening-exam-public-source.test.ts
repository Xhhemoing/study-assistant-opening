import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { readOpeningExamPublicSource } from "./opening-exam-public-source";

const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const chunks = ["数学冲刺\n\n公开介绍", "极限\n\n公开例题"], text = chunks.join("\n\n");
const metadata = { mime: "text/plain", upload_state: "uploaded", parse_state: "ready", availability: "available",
  bytes: Buffer.byteLength(text, "utf8"), sha256: createHash("sha256").update(text).digest("hex") };
function sqlWith(first: unknown[], second = chunks.map(text => ({ text }))) {
  const call = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  return { sql: call as unknown as Sql, call };
}

describe("frozen public exam source", () => {
  it("reconstructs only a matched binding's version-zero public chunks with exact UTF-8 bytes", async () => {
    const { sql, call } = sqlWith([metadata]);
    expect(await readOpeningExamPublicSource(sql, scope, "source", 0)).toEqual({ text, bytes: metadata.bytes });
    expect(call.mock.calls[0]?.slice(1)).toEqual([scope.workspaceId, scope.ownerUserId, "source"]);
    expect(call.mock.calls[1]?.slice(1)).toEqual(["source"]);
  });
  it("does not claim ordinary uploads or other versions", async () => {
    const { sql, call } = sqlWith([]);
    expect(await readOpeningExamPublicSource(sql, scope, "ordinary", 0)).toBeNull();
    expect(await readOpeningExamPublicSource(sql, scope, "ordinary", 1)).toBeNull();
    expect(call).toHaveBeenCalledTimes(1);
  });
  it.each([{ ...metadata, bytes: metadata.bytes + 1 }, { ...metadata, sha256: "0".repeat(64) }])("rejects byte or digest mismatch", async bad => {
    const { sql } = sqlWith([bad]);
    await expect(readOpeningExamPublicSource(sql, scope, "source", 0)).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it.each([{ ...metadata, availability: "unavailable" }, { ...metadata, mime: "application/pdf" },
    { ...metadata, parse_state: "queued" }, { ...metadata, upload_state: "pending" }])("rejects unavailable synthetic content", async bad => {
    const { sql, call } = sqlWith([bad]);
    await expect(readOpeningExamPublicSource(sql, scope, "source", 0)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("rejects missing or reordered text instead of returning a partial lesson file", async () => {
    for (const rows of [[], [...chunks].reverse().map(text => ({ text }))]) {
      const { sql } = sqlWith([metadata], rows);
      await expect(readOpeningExamPublicSource(sql, scope, "source", 0)).rejects.toMatchObject({ code: "CONFLICT" });
    }
  });
});
