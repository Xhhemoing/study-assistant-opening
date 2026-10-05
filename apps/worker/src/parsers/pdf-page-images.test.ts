import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { renderPdfPageImages } from "./pdf-page-images";
const id = "11111111-1111-4111-8111-111111111111";
describe("LLM PDF page images", () => {
  it("renders a real physical page as a bounded PNG data URL, never a remote object key", async () => {
    const bytes = await readFile("tests/fixtures/opening/parser-two-page.pdf");
    const images = await renderPdfPageImages(bytes, [{ sourceId: id, physicalPage: 2 }]);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ sourceId: id, physicalPage: 2, mediaType: "image/png" });
    expect(images[0]!.data.startsWith("data:image/png;base64,iVBOR")).toBe(true);
    expect(images[0]!.data.length).toBeLessThan(3000000);
    await expect(renderPdfPageImages(bytes, [{ sourceId: id, physicalPage: 99 }])).rejects.toThrow();
  }, 30000);
});
