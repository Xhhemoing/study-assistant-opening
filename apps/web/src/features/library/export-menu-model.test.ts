import { describe, expect, it } from "vitest";
import { ankiExportRequestSchema, markdownExportRequestSchema } from "@aistudy/contracts";
import {
  ankiExportCopy,
  buildAnkiExportRequest,
  buildMarkdownExportRequest,
  markdownExportCopy,
} from "./export-menu-model";

describe("markdown export menu model", () => {
  it("builds a request without a client workspace id", () => {
    expect(buildMarkdownExportRequest()).toEqual({});
    expect(buildMarkdownExportRequest("11111111-1111-4111-8111-111111111111")).toEqual({
      documentId: "11111111-1111-4111-8111-111111111111",
    });
    expect(markdownExportRequestSchema.parse({
      ...buildMarkdownExportRequest("11111111-1111-4111-8111-111111111111"),
      workspaceId: "22222222-2222-4222-8222-222222222222",
    })).toEqual({ documentId: "11111111-1111-4111-8111-111111111111" });
  });

  it("never describes the Markdown exchange as lossless", () => {
    const copy = markdownExportCopy({
      claimedLossless: false,
      losses: [{ code: "relations", feature: "relations", message: "Relations are omitted." }],
    });
    expect(copy.headline).toContain("Markdown");
    expect(copy.lossSummary).toContain("1");
    expect(`${copy.headline}${copy.lossSummary}${copy.disclaimer}`).not.toMatch(/无损|lossless/i);
  });

  it("builds an Anki request without a client workspace id and never calls it a full backup", () => {
    expect(buildAnkiExportRequest()).toEqual({});
    expect(buildAnkiExportRequest("44444444-4444-4444-8444-444444444444")).toEqual({
      cardId: "44444444-4444-4444-8444-444444444444",
    });
    expect(ankiExportRequestSchema.parse({
      ...buildAnkiExportRequest("44444444-4444-4444-8444-444444444444"),
      workspaceId: "22222222-2222-4222-8222-222222222222",
    })).toEqual({ cardId: "44444444-4444-4444-8444-444444444444" });
    const copy = ankiExportCopy({
      claimedLossless: false,
      losses: [{ code: "review-history", feature: "review-history", message: "omitted" }],
    });
    expect(copy.headline).toContain("Anki");
    expect(copy.lossSummary).toContain("1");
    expect(`${copy.headline}${copy.lossSummary}${copy.disclaimer}`).not.toMatch(/无损|lossless/i);
    expect(copy.disclaimer).toContain("投影");
    expect(copy.disclaimer).toContain("不是完整备份");
  });
});
