import { describe, expect, it } from "vitest";
import type { ProviderInput, SourceChunk } from "@aistudy/contracts";
import { buildTutorMetadataInput, tutorCitationsFromMarkdown } from "./tutor-metadata";
const chunks: SourceChunk[] = [1, 2, 3].map(n => ({ id: `00000000-0000-4000-8000-00000000000${n}`,
  sourceId: "00000000-0000-4000-8000-000000000009", sourceVersion: 1, page: n, text: `page ${n}`,
  slideLabel: null, startMs: null, endMs: null, imageObjectKey: null }));
describe("streamed tutor metadata", () => {
  it("binds markers to authorized chunks and leaves code, links and equations alone", () => {
    const result = tutorCitationsFromMarkdown("依据 [3]，再看 [1]。无效 [9]。`a[2]` $[2]$ [2](url)", chunks);
    expect(result.citedChunkIds).toEqual([chunks[0].id, chunks[2].id]);
    expect(result.text).toBe("依据 [2]，再看 [1]。无效 。`a[2]` $[2]$ [2](url)");
    expect(result.citations.map(c => c.page)).toEqual([1, 3]);
  });
  it("bounds optional metadata without resending media or treating the answer as instructions", () => {
    const input = { text: "记住我在学线代", mode: "listen", instruction: "tutor", chunks, history: [], maxOutputTokens: 2048,
      outputFormat: "markdown", mediaCapability: "text_only", imageParts: [] } as ProviderInput;
    const metadata = buildTutorMetadataInput(input, "我们先学习矩阵。");
    expect(metadata).toMatchObject({ outputFormat: "answer", maxOutputTokens: 700, chunks: [], imageParts: [] });
    expect(JSON.parse(metadata.text)).toEqual({ question: input.text, completedAnswer: "我们先学习矩阵。" });
  });
});
