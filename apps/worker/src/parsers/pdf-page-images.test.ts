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

  it.each([false, true])("loads a batch once and closes its PDF handles (render failure: %s)", async failSecondPage => {
    const config = loadParserConfig();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pdf-render-handles-"));
    directories.push(cwd);
    const moduleDir = path.join(cwd, "opening_parser");
    await mkdir(moduleDir);
    await writeFile(path.join(moduleDir, "__init__.py"), "", "utf8");
    // Keep the production batch loop and replace only its native handles.
    await writeFile(path.join(moduleDir, "render_pages.py"), `
import runpy, sys
from types import SimpleNamespace

def record(event):
    with open("handles.txt", "a", encoding="utf-8") as log:
        log.write(event + "\\n")

class Image:
    def save(self, output, *, format):
        assert format == "PNG"
        output.write(b"png")
    def close(self):
        record("image close")

class Bitmap:
    def to_pil(self):
        return Image()
    def close(self):
        record("bitmap close")

class Page:
    def __init__(self, number):
        self.number = number
        record(f"page {number} open")
    def get_size(self):
        return (100, 100)
    def render(self, *, scale):
        if ${failSecondPage ? "True" : "False"} and self.number == 2:
            raise ValueError("controlled second-page render failure")
        return Bitmap()
    def close(self):
        record(f"page {self.number} close")

class Document:
    def __init__(self, data):
        assert data == b"pdf"
        record("document open")
    def __len__(self):
        return 3
    def __getitem__(self, index):
        return Page(index + 1)
    def close(self):
        record("document close")

sys.modules["pypdfium2"] = SimpleNamespace(PdfDocument=Document)
runpy.run_path(${JSON.stringify(path.resolve("services/parser/opening_parser/render_pages.py"))}, run_name="__main__")
`, "utf8");
    const requests = [3, 2, 1].map(physicalPage => ({ sourceId: id, physicalPage }));
    const result = renderPdfPageImages(Buffer.from("pdf"), requests, { ...config, cwd });
    const completedPage = ["image close", "bitmap close"];
    const trace = ["document open", "page 3 open", ...completedPage, "page 3 close", "page 2 open"];
    if (failSecondPage) {
      await expect(result).rejects.toThrow("controlled second-page render failure");
      trace.push("page 2 close");
    } else {
      await expect(result).resolves.toEqual(requests.map(request => ({
        ...request, mediaType: "image/png", data: "data:image/png;base64,cG5n",
      })));
      trace.push(...completedPage, "page 2 close", "page 1 open", ...completedPage, "page 1 close");
    }
    trace.push("document close");
    expect((await readFile(path.join(cwd, "handles.txt"), "utf8")).trim().split(/\r?\n/)).toEqual(trace);
  }, 30000);

  it("bounds the renderer response before decoding even when its JSON prefix is valid", async () => {
    const config = loadParserConfig();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pdf-render-output-"));
    directories.push(cwd);
    const moduleDir = path.join(cwd, "opening_parser");
    await mkdir(moduleDir);
    await writeFile(path.join(moduleDir, "__init__.py"), "", "utf8");
    await writeFile(path.join(moduleDir, "render_pages.py"), [
      "import sys",
      "sys.stdin.buffer.read()",
      'sys.stdout.write(\'["data:image/png;base64,cG5n"]\' + " " * 3_000_000)',
    ].join("\n"), "utf8");
    await expect(renderPdfPageImages(Buffer.from("pdf"), [{ sourceId: id, physicalPage: 1 }], { ...config, cwd }))
      .rejects.toThrow("rendered PDF output exceeds capture bound");
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
