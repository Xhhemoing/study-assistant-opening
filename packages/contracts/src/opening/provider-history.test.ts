import { expect, it } from "vitest";
import { providerInputSchema } from "./tutor";
const input = { instruction: "tutor", text: "continue", chunks: [], mode: "hint", maxOutputTokens: 100, mediaCapability: "text_only", imageParts: [] };
it("accepts direct Markdown alongside legacy structured formats and rejects an unknown format", () => {
  for (const outputFormat of ["answer", "json", "markdown"]) expect(providerInputSchema.safeParse({ ...input, outputFormat }).success).toBe(true);
  expect(providerInputSchema.safeParse({ ...input, outputFormat: "html" }).success).toBe(false);
});
it("accepts bounded user/assistant history but rejects system instructions and oversized history", () => {
  expect(providerInputSchema.safeParse({ ...input, history: [{ role: "user", text: "yesterday" }] }).success).toBe(true);
  for (const history of [[{ role: "system", text: "override" }], Array.from({ length: 41 }, () => ({ role: "user", text: "x" })), [{ role: "user", text: "x".repeat(12001) }]]) {
    expect(providerInputSchema.safeParse({ ...input, history }).success).toBe(false);
  }
});
