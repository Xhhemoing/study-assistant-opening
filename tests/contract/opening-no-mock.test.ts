import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
export const OPENING_ENTRY_ROOT = "apps/web/src/app/(opening)";
const EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
export const FORBIDDEN_OPENING_IMPORTS = ["/lib/data/mock", "createMockProvider", "/lib/data/react", "lib/data/react"];

function isCodeFile(file: string) {
  return EXTENSIONS.has(path.extname(file));
}

function isTestFile(file: string) {
  return /(\.test|\.spec)\.[cm]?[jt]sx?$/.test(file);
}

function listFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    const full = path.join(abs, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(path.relative(ROOT, full)));
      continue;
    }
    if (isCodeFile(full) && !isTestFile(full)) out.push(full);
  }
  return out;
}

function resolveImport(fromFile: string, spec: string): string | null {
  let target: string | null = null;
  if (spec.startsWith("@/")) {
    target = path.join(ROOT, "apps/web/src", spec.slice(2));
  } else if (spec.startsWith(".")) {
    target = path.resolve(path.dirname(fromFile), spec);
  }
  if (!target) return null;
  const candidates = [target, ...[...EXTENSIONS].map((ext) => `${target}${ext}`)];
  for (const ext of EXTENSIONS) candidates.push(path.join(target, `index${ext}`));
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile() && isCodeFile(candidate)) return candidate;
    } catch {
      // ignore resolution misses; the build will surface them
    }
  }
  return null;
}

/** Ways a reachable file can still load the mock provider without a literal import. */
export function concealedMockImport(text: string): string | null {
  // A service method such as Redis.eval executes Lua remotely, not JavaScript imports.
  if (/\bnew\s+Function\b|(?:^|[^.\w])eval\s*\(|\b(?:globalThis|global|window|self)\s*(?:\?\.|\.)\s*eval\s*\(/.test(text)) return "new Function or eval";
  const dynamic = /(?:^|[^.\w])import\s*\(\s*([\s\S]*?)\)/g;
  for (const match of text.matchAll(dynamic)) {
    const arg = match[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const quote = arg[0];
    const single = arg.length >= 2 && (quote === '"' || quote === "'" || quote === "`") && arg.endsWith(quote);
    const body = single ? arg.slice(1, -1) : null;
    if (body === null || body.includes(quote) || body.includes("${") || arg.includes("+")) return "non-literal dynamic import";
  }
  const literals = [...text.matchAll(/['"`]([^'"`]*)['"`]/g)].map((match) => match[1]);
  const assembles = /\.join\s*\(|['"`][^'"`]*['"`]\s*\+/.test(text);
  if (assembles) {
    const compact = literals.join("/");
    if (/lib\/data\/react|lib\/data\/mock|createMockProvider/.test(compact)) return "concatenated specifier";
    if (literals.includes("lib") && literals.includes("data") && (literals.includes("react") || literals.includes("mock"))) {
      return "concatenated specifier";
    }
  }
  return null;
}

export function collectOpeningReachableFiles(): Set<string> {
  const visited = new Set<string>();
  const stack = listFiles(OPENING_ENTRY_ROOT);
  while (stack.length) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const text = readFileSync(file, "utf8");
    const regex = /(?:import\s+(?:[^"']*?\s+from\s+)?|import\s*\(\s*(?:\/\*[^*]*\*\/\s*)*|export\s+(?:[^"']*?\s+from\s+))["']([^"']+)["']/g;
    for (const match of text.matchAll(regex)) {
      const resolved = resolveImport(file, match[1]);
      if (resolved && !visited.has(resolved)) stack.push(resolved);
    }
  }
  return visited;
}

const OLD_CONCEALED_IMPORT = `
  const specifier = ["..", "lib", "data", "react"].join("/").replace("..", "../..");
  const module = await (new Function("specifier", "return import(specifier)"))(specifier);
`;

it("rejects concealed mock imports that a literal-import scan would miss", () => {
  expect(concealedMockImport(OLD_CONCEALED_IMPORT)).toBe("new Function or eval");
  expect(concealedMockImport(`eval("import(specifier)");`)).toBe("new Function or eval");
  expect(concealedMockImport(`globalThis.eval("import(specifier)");`)).toBe("new Function or eval");
  expect(concealedMockImport(`global.eval(code);`)).toBe("new Function or eval");
  expect(concealedMockImport(`globalThis?.eval(code);`)).toBe("new Function or eval");
  expect(concealedMockImport(`window.eval("import(specifier)");`)).toBe("new Function or eval");
  expect(concealedMockImport(`await redis.eval("return redis.call('GET', KEYS[1])", 1, key);`)).toBeNull();
  expect(concealedMockImport(`const spec = "../../lib/data/react"; await import(spec);`)).toBe("non-literal dynamic import");
  expect(concealedMockImport(`await import("../../" + "lib/data/react");`)).toBe("non-literal dynamic import");
  expect(concealedMockImport(`const specifier = ["..", "lib", "data", "react"].join("/");`)).toBe("concatenated specifier");
  expect(concealedMockImport(`await import(\`../../lib/data/\${name}\`);`)).toBe("non-literal dynamic import");
  expect(concealedMockImport(`import { useStudyProvider } from "../../lib/data/react";`)).toBeNull();
});

it("official Opening pages never reach mock providers or demo data", () => {
  const offenders: string[] = [];
  for (const file of collectOpeningReachableFiles()) {
    const text = readFileSync(file, "utf8");
    const relative = path.relative(ROOT, file);
    if (FORBIDDEN_OPENING_IMPORTS.some((needle) => text.includes(needle))) offenders.push(relative);
    const concealed = concealedMockImport(text);
    if (concealed) offenders.push(`${relative} (${concealed})`);
  }
  expect(offenders.sort()).toEqual([]);
});

it("scans Opening entry points and reachable shared modules", () => {
  const files = [...collectOpeningReachableFiles()].map((file) => path.relative(ROOT, file).replace(/\\/g, "/"));
  expect(files).toContain("apps/web/src/features/courses/course-detail.tsx");
  expect(files).toContain("apps/web/src/features/opening/shell/opening-shell.tsx");
  expect(files).toContain("apps/web/src/app/(opening)/opening/cards/page.tsx");
  expect(files).toContain("apps/web/src/features/opening/cards/card-review-view.tsx");
  expect(files).toContain("apps/web/src/features/opening/cards/cards-client.ts");
  expect(files).toContain("apps/web/src/features/editor/document-editor.tsx");
  expect(files).toContain("apps/web/src/features/editor/new-document.tsx");
  expect(files).not.toContain("apps/web/src/lib/data/react.ts");
  expect(files).not.toContain("apps/web/src/lib/data/mock/provider.ts");
  expect(files).not.toContain("apps/web/src/features/courses/legacy-course-detail.tsx");
});

it("legacy /learn course page uses real CourseDetail and never reaches mock providers", () => {
  const legacy = readFileSync(path.join(ROOT, "apps/web/src/features/courses/legacy-course-detail.tsx"), "utf8");
  expect(legacy).toMatch(/CourseDetail/);
  expect(legacy).toMatch(/surface=["']learn["']/);
  expect(legacy).not.toMatch(/lib\/data\/react|createMockProvider|useStudyProvider/);
  expect(legacy).not.toMatch(/\bnew\s+Function\b/);
  expect(concealedMockImport(legacy)).toBeNull();

  const advanced = readFileSync(path.join(ROOT, "apps/web/src/features/settings/advanced-settings-view.tsx"), "utf8");
  expect(advanced).not.toMatch(/lib\/data\/react|createMockProvider|useStudyProvider|resetDemoData/);
  expect(concealedMockImport(advanced)).toBeNull();
});
