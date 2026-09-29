import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "@tailwindcss/postcss";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const stylesheet = readFileSync(fileURLToPath(new URL("./tailwind.css", import.meta.url)), "utf8");

describe("Tailwind source discovery", () => {
  it.each([".", "apps/web"])("only watches UI sources when started from %s", async (cwd) => {
    const root = mkdtempSync(path.join(tmpdir(), "aistudy-tailwind-"));
    function write(relativePath: string, content: string) {
      const file = path.join(root, relativePath);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content, "utf8");
      return file;
    }

    try {
      // Resolve only the package import so the real stylesheet can run in an isolated monorepo.
      const tailwindPath = require.resolve("tailwindcss/index.css").replaceAll("\\", "/");
      const css = stylesheet.replace('"tailwindcss"', `"${tailwindPath}"`);
      const from = write("apps/web/src/app/tailwind.css", css);
      write("apps/web/src/app/page.tsx", '<div className="p-7" />');
      write("packages/ui/src/nested/card.tsx", '<div className="m-9" />');
      write("docs/example.md", '<div class="text-fuchsia-950" />');
      write("apps/web/.next-opening-e2e/generated.js", 'const html = "text-fuchsia-950";');
      write(".gitignore", "node_modules/\n.next/\n.next-opening-e2e/\n");

      const result = await postcss([tailwind({ base: path.resolve(root, cwd) })]).process(css, { from });
      expect(result.css).toContain(".p-7");
      expect(result.css).toContain(".m-9");

      const roots = ["apps/web/src", "packages/ui/src"].map((source) => path.join(root, source));
      const watched = result.messages.filter((message) => message.type === "dir-dependency");
      expect(watched.length).toBeGreaterThan(0);
      // Next's PostCSS loader watches each whole directory, ignoring Tailwind's glob.
      // A parent of .next-opening-e2e would therefore rebuild on its own output.
      const outsideSources = watched.filter(({ dir }) => !roots.some((source) => dir === source || dir.startsWith(`${source}${path.sep}`)));
      expect(outsideSources.map(({ dir }) => path.relative(root, dir))).toEqual([]);
      expect(result.css).not.toContain(".text-fuchsia-950");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
