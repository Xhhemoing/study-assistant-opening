import { describe, expect, it, vi } from "vitest";
import { LibraryError } from "@aistudy/database";
import type { Principal } from "../../lib/authorization";
import { exportMarkdownForPrincipal } from "./markdown-export-service";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherWorkspace = "33333333-3333-4333-8333-333333333333";
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const documentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const blockId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const principal = { userId: ownerUserId, workspaceId } as Principal;

function documentRow() {
  return {
    id: documentId,
    workspaceId,
    title: "导数笔记",
    lifecycle: "confirmed",
    schemaVersion: 1,
    currentRevisionNumber: 1,
    createdAt: new Date("2026-08-15T00:00:00.000Z"),
    updatedAt: new Date("2026-08-15T00:00:00.000Z"),
    deletedAt: null,
    blocks: [{ id: blockId, type: "paragraph", position: 0, content: { text: "正文" } }],
  };
}

describe("markdown export service", () => {
  it("exports from the session workspace and ignores a client workspace id", async () => {
    const getDocument = vi.fn().mockResolvedValue(documentRow());
    const listProperties = vi.fn().mockResolvedValue([
      { key: "tags", valueType: "json", value: ["高数"] },
    ]);
    const listRelations = vi.fn().mockResolvedValue([]);
    const result = await exportMarkdownForPrincipal(
      { library: { getDocument, listProperties, listRelations } } as never,
      principal,
      { documentId, workspaceId: otherWorkspace },
    );
    expect(getDocument).toHaveBeenCalledWith({ workspaceId, documentId });
    expect(result.format).toBe("markdown");
    expect(result.lossReport.claimedLossless).toBe(false);
    expect(result.markdown).toContain("正文");
    expect(result.markdown).toContain("高数");
    expect(result.manifest.blockIdentities[0]?.blockId).toBe(blockId);
  });

  it("refuses to export a document that belongs to another workspace", async () => {
    const getDocument = vi.fn().mockRejectedValue(
      new LibraryError("WORKSPACE_MISMATCH", "not in workspace"),
    );
    await expect(
      exportMarkdownForPrincipal(
        { library: { getDocument, listProperties: vi.fn(), listRelations: vi.fn() } } as never,
        principal,
        { documentId },
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_FORBIDDEN", status: 403 });
  });

  it("records relations and extra properties as structured losses", async () => {
    const getDocument = vi.fn().mockResolvedValue(documentRow());
    const listProperties = vi.fn().mockResolvedValue([
      { key: "tags", valueType: "json", value: [] },
      { key: "flagged", valueType: "boolean", value: true },
    ]);
    const listRelations = vi.fn().mockResolvedValue([{ id: "rel-1" }]);
    const result = await exportMarkdownForPrincipal(
      { library: { getDocument, listProperties, listRelations } } as never,
      principal,
      { documentId },
    );
    expect(result.lossReport.losses.map((loss) => loss.code).sort()).toEqual([
      "custom-properties",
      "relations",
    ]);
  });
});
