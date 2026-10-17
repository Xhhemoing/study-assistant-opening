import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPdfPageImages } from "./pdf-page-images";
import { loadParserConfig } from "./parser-config";
const id = "11111111-1111-4111-8111-111111111111";
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
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

  it("renders the real PDF after the Python child verifies that application secrets are absent", async () => {
    const config = loadParserConfig();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pdf-render-env-"));
    directories.push(cwd);
    await mkdir(path.join(cwd, "opening_parser"));
    await writeFile(path.join(cwd, "opening_parser", "__init__.py"), "");
    // Run the production renderer after assertions inside the actual Python
    // child. This checks the spawn boundary as well as real PNG rendering.
    await writeFile(path.join(cwd, "opening_parser", "render_pages.py"), [
      "import os, runpy",
      'assert all(key not in os.environ for key in ("DATABASE_URL", "S3_SECRET_ACCESS_KEY", "OPENAI_API_KEY", "HF_TOKEN", "PYTHONPATH"))',
      'assert os.environ["HF_HUB_OFFLINE"] == "1"',
      'assert os.environ["PYTHONNOUSERSITE"] == "1"',
      `runpy.run_path(${JSON.stringify(path.resolve("services/parser/opening_parser/render_pages.py"))}, run_name="__main__")`,
    ].join("\n"));
    for (const key of ["DATABASE_URL", "S3_SECRET_ACCESS_KEY", "OPENAI_API_KEY", "HF_TOKEN", "PYTHONPATH"]) {
      vi.stubEnv(key, "sensitive-parent-value");
    }
    const images = await renderPdfPageImages(await readFile("tests/fixtures/opening/parser-two-page.pdf"),
      [{ sourceId: id, physicalPage: 1 }], { ...config, cwd });
    expect(images[0]!.data).toMatch(/^data:image\/png;base64,iVBOR/);
  }, 30000);
});
