import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type PackageJson = {
  name?: string;
  main?: string;
  types?: string;
  exports?: unknown;
  imports?: Record<string, unknown>;
};

type EdgeKind = "runtime" | "type" | "reexport" | "dynamic" | "require";

type Edge = {
  spec: string;
  line: number;
  kind: EdgeKind;
};

export type BoundaryViolation = {
  entry: string;
  target: string;
  chain: string[];
};

type GraphOptions = {
  root: string;
  files?: ReadonlyMap<string, string>;
  virtualOnly?: boolean;
};

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];
const CLOSED_PACKAGE_SPECS = [
  /^@aistudy\/(?:ai|database)(?:\/|$)/,
  /^(?:postgres|drizzle-orm|ioredis|jose|server-only)(?:\/|$)/,
  /^@aws-sdk\//,
];
const CLOSED_DIRECTORY_NAMES = new Set([
  "epistemic",
  "symbolic-equivalence",
  "pedagogical-retrieval",
  "tutor-graph",
  "cartridge-compiler",
]);

const slash = (value: string) => value.replaceAll("\\", "/");
const normalizeFile = (file: string) => path.normalize(path.resolve(file));

function isClosedPackageSpec(spec: string): boolean {
  return CLOSED_PACKAGE_SPECS.some(pattern => pattern.test(spec)) || spec.startsWith("#");
}

function isClosedFile(file: string): boolean {
  const normalized = slash(file).toLowerCase();
  const segments = normalized.split("/");
  if (segments.some(segment => CLOSED_DIRECTORY_NAMES.has(segment))) return true;
  if (segments.some(segment => /(?:^|[-_])(?:l3|l4)(?:[-_]|$)/u.test(segment))) return true;
  if (segments.some(segment => /(?:^|[-_])(?:0109|seeded-recipe|flagship)(?:[-_]|$)/u.test(segment))) return true;
  if (normalized.includes("/packages/ai/")) return true;
  if (normalized.includes("/packages/database/")) return true;
  if (normalized.includes("/packages/domain/src/opening/exam-sprint/")) return true;
  if (normalized.includes("/packages/domain/src/opening/cartridges/")) return true;
  if (normalized.includes("/packages/domain/src/opening/span-")) return true;
  if (normalized.includes("/packages/ai/src/tutor-graph/")) return true;
  if (normalized.includes("/packages/ai/src/cartridge-compiler/")) return true;
  if (normalized.includes("/packages/domain/src/epistemic/")) return true;
  if (normalized.includes("/packages/domain/src/symbolic-equivalence/")) return true;
  if (normalized.includes("/packages/domain/src/pedagogical-retrieval/")) return true;
  return /(?:^|\/)0109(?:\/|[-_.]|$)/u.test(normalized);
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pickConditionalTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const picked = pickConditionalTarget(candidate);
      if (picked) return picked;
    }
    return undefined;
  }
  if (!isStringRecord(value)) return undefined;
  for (const key of ["types", "import", "node", "default", "require"]) {
    const picked = pickConditionalTarget(value[key]);
    if (picked) return picked;
  }
  for (const candidate of Object.values(value)) {
    const picked = pickConditionalTarget(candidate);
    if (picked) return picked;
  }
  return undefined;
}

function matchPatternMap(map: Record<string, unknown> | undefined, spec: string): string | undefined {
  if (!map) return undefined;
  const exact = pickConditionalTarget(map[spec]);
  if (exact) return exact;
  for (const [pattern, value] of Object.entries(map)) {
    const star = pattern.indexOf("*");
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
    const replacement = spec.slice(prefix.length, spec.length - suffix.length || undefined);
    const target = pickConditionalTarget(value);
    if (target) return target.replaceAll("*", replacement);
  }
  return undefined;
}

function parseEdges(file: string, text: string): Edge[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edges: Edge[] = [];
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly = Boolean(
        clause && (
          clause.isTypeOnly ||
          (!clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every(element => element.isTypeOnly))
        ),
      );
      edges.push({ spec: node.moduleSpecifier.text, line: line(node), kind: typeOnly ? "type" : "runtime" });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = Boolean(
        node.isTypeOnly ||
        (node.exportClause && ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every(element => element.isTypeOnly)),
      );
      edges.push({ spec: node.moduleSpecifier.text, line: line(node), kind: typeOnly ? "type" : "reexport" });
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      edges.push({
        spec: node.arguments[0].text,
        line: line(node),
        kind: node.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic" : "require",
      });
    } else if (ts.isImportTypeNode(node)) {
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}

class ModuleGraph {
  private readonly root: string;
  private readonly files: ReadonlyMap<string, string>;
  private readonly virtualOnly: boolean;
  private readonly packageRoots = new Map<string, string>();
  private readonly manifestCache = new Map<string, PackageJson | null>();

  constructor(options: GraphOptions) {
    this.root = normalizeFile(options.root);
    this.files = new Map([...options.files ?? new Map()].map(([file, text]) => [normalizeFile(file), text]));
    this.virtualOnly = options.virtualOnly ?? false;
    for (const [file] of this.files) {
      if (path.basename(file) !== "package.json") continue;
      const manifest = this.readManifest(file);
      if (manifest?.name) this.packageRoots.set(manifest.name, path.dirname(file));
    }
    if (!this.virtualOnly) {
      const packagesRoot = path.join(this.root, "packages");
      if (existsSync(packagesRoot)) {
        for (const name of requireDirectoryNames(packagesRoot)) {
          const packageRoot = path.join(packagesRoot, name);
          const manifest = this.loadManifest(packageRoot);
          if (manifest?.name) this.packageRoots.set(manifest.name, packageRoot);
        }
      }
    }
  }

  private readText(file: string): string | undefined {
    const normalized = normalizeFile(file);
    const virtual = this.files.get(normalized);
    if (virtual !== undefined) return virtual;
    if (this.virtualOnly || !existsSync(normalized) || !statSync(normalized).isFile()) return undefined;
    return readFileSync(normalized, "utf8");
  }

  private readManifest(file: string): PackageJson | null {
    const normalized = normalizeFile(file);
    if (this.manifestCache.has(normalized)) return this.manifestCache.get(normalized) ?? null;
    const text = this.readText(normalized);
    if (!text) {
      this.manifestCache.set(normalized, null);
      return null;
    }
    try {
      const parsed = JSON.parse(text) as PackageJson;
      this.manifestCache.set(normalized, parsed);
      return parsed;
    } catch {
      this.manifestCache.set(normalized, null);
      return null;
    }
  }

  private loadManifest(packageRoot: string): PackageJson | null {
    return this.readManifest(path.join(packageRoot, "package.json"));
  }

  private findPackageRoot(from: string): string | undefined {
    let current = path.dirname(normalizeFile(from));
    while (true) {
      if (this.loadManifest(current)) return current;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }

  private resolvePath(base: string): string | undefined {
    const normalized = normalizeFile(base);
    const candidates = [normalized];
    const extension = path.extname(normalized);
    if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
      candidates.push(normalized.slice(0, -extension.length) + ".ts");
      candidates.push(normalized.slice(0, -extension.length) + ".tsx");
    } else if (!extension) {
      candidates.push(...SOURCE_EXTENSIONS.map(candidate => normalized + candidate));
    }
    candidates.push(...SOURCE_EXTENSIONS.map(candidate => path.join(normalized, `index${candidate}`)));
    return candidates.find(candidate => this.readText(candidate) !== undefined);
  }

  private resolvePackageImports(spec: string, from: string): string | undefined {
    const packageRoot = this.findPackageRoot(from);
    if (!packageRoot) return undefined;
    const manifest = this.loadManifest(packageRoot);
    const target = matchPatternMap(manifest?.imports, spec);
    if (!target) return undefined;
    if (target.startsWith("#")) return this.resolveImport(target, from);
    if (!target.startsWith(".")) return undefined;
    return this.resolvePath(path.resolve(packageRoot, target));
  }

  private resolvePackage(spec: string): string | undefined {
    const match = spec.match(/^(@aistudy\/[^/]+)(\/.*)?$/u);
    if (!match) return undefined;
    const packageName = match[1];
    const packageRoot = this.packageRoots.get(packageName);
    if (!packageRoot) return undefined;
    const manifest = this.loadManifest(packageRoot);
    const subpath = match[2] ? `.${match[2]}` : ".";
    let target: string | undefined;
    if (manifest?.exports !== undefined) {
      const exportsValue = manifest.exports;
      if (subpath === "." && (!isStringRecord(exportsValue) || !Object.keys(exportsValue).some(key => key.startsWith(".")))) {
        target = pickConditionalTarget(exportsValue);
      } else if (isStringRecord(exportsValue)) {
        target = pickConditionalTarget(exportsValue[subpath]);
      }
    }
    target ??= manifest?.types ?? manifest?.main;
    if (!target || !target.startsWith(".")) return undefined;
    return this.resolvePath(path.resolve(packageRoot, target));
  }

  resolveImport(spec: string, from: string): string | undefined {
    if (spec.startsWith("#")) return this.resolvePackageImports(spec, from);
    if (spec.startsWith(".") || path.isAbsolute(spec)) {
      return this.resolvePath(path.resolve(path.dirname(from), spec));
    }
    return this.resolvePackage(spec);
  }

  label(file: string): string {
    const relative = path.relative(this.root, normalizeFile(file));
    return slash(relative || path.basename(file));
  }

  text(file: string): string | undefined {
    return this.readText(file);
  }
}

function requireDirectoryNames(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry: { isDirectory: () => boolean }) => entry.isDirectory())
    .map((entry: { name: string }) => entry.name);
}

export function analyzeModuleGraph(entries: readonly string[], options: GraphOptions): { violations: BoundaryViolation[] } {
  const graph = new ModuleGraph(options);
  const violations: BoundaryViolation[] = [];
  const reported = new Set<string>();
  for (const rawEntry of entries) {
    const entry = normalizeFile(rawEntry);
    if (!graph.text(entry)) continue;
    const entryLabel = graph.label(entry);
    const stack: Array<{ file: string; chain: string[] }> = [{ file: entry, chain: [entryLabel] }];
    const visited = new Set<string>([entry]);
    while (stack.length > 0) {
      const current = stack.pop()!;
      const text = graph.text(current.file);
      if (text === undefined) continue;
      for (const edge of parseEdges(current.file, text)) {
        const targetFile = graph.resolveImport(edge.spec, current.file);
        const hop = `${graph.label(current.file)}:${edge.line} -> ${edge.spec}${edge.kind === "runtime" ? "" : ` [${edge.kind}]`}`;
        let target: string | undefined;
        if (targetFile && isClosedFile(targetFile)) {
          target = graph.label(targetFile);
        } else if (isClosedPackageSpec(edge.spec) && !edge.spec.startsWith("#")) {
          target = edge.spec;
        } else if (!targetFile && edge.spec.startsWith("#")) {
          target = edge.spec;
        }
        if (target) {
          const chain = [...current.chain, hop];
          if (targetFile && target === graph.label(targetFile)) chain.push(target);
          const key = `${entryLabel}\0${chain.join("\n")}`;
          if (!reported.has(key)) {
            reported.add(key);
            violations.push({ entry: entryLabel, target, chain });
          }
          continue;
        }
        if (targetFile && !visited.has(targetFile)) {
          visited.add(targetFile);
          stack.push({ file: targetFile, chain: [...current.chain, hop, graph.label(targetFile)] });
        }
      }
    }
  }
  return { violations };
}

function virtualAnalyze(files: Record<string, string>, entry: string, packageJson?: PackageJson) {
  const root = normalizeFile("__v3_open_core_virtual__");
  const virtualFiles = new Map<string, string>(
    Object.entries(files).map(([file, text]) => [path.join(root, file), text]),
  );
  if (packageJson) virtualFiles.set(path.join(root, "package.json"), JSON.stringify(packageJson));
  return analyzeModuleGraph([path.join(root, entry)], { root, files: virtualFiles, virtualOnly: true });
}

function formatViolations(violations: BoundaryViolation[]): string {
  return violations.map(violation => `${violation.entry} reaches ${violation.target}\n  ${violation.chain.join("\n  ")}`).join("\n");
}

describe("v3 Open-Core public candidate boundary", () => {
  it("keeps every real public candidate free of closed-core and server-only transitive targets", () => {
    const root = path.resolve(__dirname, "../..");
    const required = [
      "packages/jingwei/src/index.ts",
      "packages/jingwei/src/react/index.ts",
      "packages/domain/src/portability/native/index.ts",
    ];
    const optional = [
      "packages/contracts/src/learner-portability/index.ts",
      "packages/contracts/src/cartridge-lite/index.ts",
      "packages/domain/src/cartridge-sdk-lite/index.ts",
    ];
    const entryPaths = [...required, ...optional].map(file => path.join(root, file));
    const missingRequired = required.filter(file => !existsSync(path.join(root, file)));
    expect(missingRequired).toEqual([]);
    const entries = entryPaths.filter(file => existsSync(file));
    expect(entries).toHaveLength(required.length + optional.filter(file => existsSync(path.join(root, file))).length);
    const result = analyzeModuleGraph(entries, { root });
    expect(result.violations, formatViolations(result.violations)).toEqual([]);
  });

  it("accepts a portable candidate with public contracts and pure external dependencies", () => {
    const result = virtualAnalyze({
      "index.ts": 'export * from "./helper";\n',
      "helper.ts": [
        'import { z } from "zod";',
        'import { createEmptyCard } from "ts-fsrs";',
        'import type { BackupFileManifestEntry } from "@aistudy/contracts";',
        "export const portable = Boolean(z && createEmptyCard && (null as BackupFileManifestEntry | null));",
      ].join("\n"),
    }, "index.ts");
    expect(result.violations).toEqual([]);
  });

  it("captures a multi-layer star re-export into a closed epistemic module", () => {
    const result = virtualAnalyze({
      "packages/domain/src/cartridge-sdk-lite/index.ts": 'export * from "./helper";\n',
      "packages/domain/src/cartridge-sdk-lite/helper.ts": 'export * from "../../epistemic/index";\n',
      "packages/domain/epistemic/index.ts": "export const SkillBeliefV1 = 1;\n",
    }, "packages/domain/src/cartridge-sdk-lite/index.ts");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.target).toContain("packages/domain/epistemic/index.ts");
    expect(result.violations[0]?.chain.join("\n")).toMatch(/helper\.ts:[0-9]+ -> \.\.\/\.\.\/epistemic\/index/);
  });

  it("blocks dynamic imports and indirect server package re-exports", () => {
    const result = virtualAnalyze({
      "index.ts": 'export * from "./helper";\n',
      "helper.ts": [
        'export * from "./server";',
        "export async function loadGraph() {",
        '  return import("@aistudy/ai/tutor-graph");',
        "}",
      ].join("\n"),
      "server.ts": 'export * from "./db";\n',
      "db.ts": 'export const database = require("@aistudy/database");\n',
    }, "index.ts");
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map(violation => violation.target)).toEqual(
      expect.arrayContaining(["@aistudy/database", "@aistudy/ai/tutor-graph"]),
    );
    expect(result.violations.map(violation => violation.chain.join("\n")).join("\n")).toMatch(/\[dynamic\]/);
  });

  it("resolves wildcard package imports aliases before classifying private L3-L4 targets", () => {
    const result = virtualAnalyze({
      "index.ts": 'export { cartridge } from "#cartridge-is-proxy";\n',
      "private/l3-is-proxy.ts": "export const cartridge = {};\n",
    }, "index.ts", {
      name: "@aistudy/community-lite",
      imports: { "#cartridge-*": "./private/l3-*.ts" },
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.target).toContain("private/l3-is-proxy.ts");
    expect(result.violations[0]?.chain.join("\n")).toContain("#cartridge-is-proxy");
  });

  it("treats a closed-core type re-export as a public contract leak", () => {
    const result = virtualAnalyze({
      "packages/domain/src/cartridge-sdk-lite/index.ts": 'export type { SkillBeliefV1 } from "../../epistemic/types";\n',
      "packages/domain/epistemic/types.ts": "export type SkillBeliefV1 = unknown;\n",
    }, "packages/domain/src/cartridge-sdk-lite/index.ts");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.chain.join("\n")).toMatch(/\[type\]/);
    expect(result.violations[0]?.target).toContain("packages/domain/epistemic/types.ts");
  });
});
