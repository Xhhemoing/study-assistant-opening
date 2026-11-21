import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type PackageJson = {
  name?: string;
  license?: string;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  browser?: string | Record<string, string | false>;
  exports?: unknown;
  imports?: Record<string, unknown>;
};

type EdgeKind = "runtime" | "type" | "reexport" | "dynamic" | "require";
type RuntimeProfile = "browser-ui" | "portable-runtime";

type Edge = {
  spec: string;
  line: number;
  kind: EdgeKind;
  reference?: "path" | "types";
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
  requirePermissiveCandidateLicense?: boolean;
  profile?: RuntimeProfile;
};

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".d.mts", ".d.cts", ".js", ".jsx", ".mjs", ".cjs"];
const SOURCE_SUBSTITUTIONS: Record<string, string[]> = {
  ".js": [".ts", ".tsx", ".d.ts"],
  ".jsx": [".tsx", ".d.ts"],
  ".mjs": [".mts", ".d.mts"],
  ".cjs": [".cts", ".d.cts"],
};
const PORTABLE_EXTERNALS = new Set(["zod", "ts-fsrs", "react", "react/jsx-runtime", "react-dom"]);
const UI_EXTERNALS = new Set(["@radix-ui/react-dialog", "@radix-ui/react-tabs", "@radix-ui/react-toast", "lucide-react"]);
const PORTABLE_NODE_MODULES = new Set(["node:crypto", "node:buffer"]);
const BUILTINS = new Set(builtinModules);
const CLOSED_PACKAGE_SPECS = [
  /^@aistudy\/(?:ai|database)(?:\/|$)/,
  /^(?:next|postgres|pg|drizzle-orm|ioredis|jose|server-only)(?:\/|$)/,
  /^@aws-sdk\//,
];
const CLOSED_DIRECTORY_NAMES = new Set([
  "epistemic",
  "symbolic-equivalence",
  "pedagogical-retrieval",
  "tutor-graph",
  "cartridge-compiler",
  "diagnostic-placement",
  "remedy-clinic",
  "rubric-calibration",
  "exam-forecast",
  "stack-408-v1",
  "ielts-writing-speaking-v1",
]);

const slash = (value: string) => value.replaceAll("\\", "/");
const normalizeFile = (file: string) => path.normalize(path.resolve(file));
const rootedPath = (spec: string) => spec.startsWith("/") || /^[a-z]:/iu.test(spec);

function isClosedFile(file: string, root: string): boolean {
  const relative = slash(path.relative(root, file)).toLowerCase();
  const segments = relative.split("/");
  return segments.some(segment => CLOSED_DIRECTORY_NAMES.has(segment)) ||
    CLOSED_DIRECTORY_NAMES.has(path.basename(relative).replace(/(?:\.d)?\.[cm]?[jt]sx?$/u, "")) ||
    segments.some(segment => /(?:^|[-_])(?:l3|l4|0109|seeded-recipe|flagship)(?:[-_]|$)/u.test(segment)) ||
    /(?:^|\/)0109(?:\/|[-_.]|$)/u.test(relative) ||
    /^packages\/(?:ai|database)\//u.test(relative) ||
    /^packages\/domain\/src\/opening\/(?:exam-sprint\/|cartridges\/|span-)/u.test(relative);
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectConditionalTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) || isStringRecord(value)) return Object.values(value).flatMap(collectConditionalTargets);
  return [];
}

function matchPatternMap(map: Record<string, unknown>, spec: string) {
  if (Object.hasOwn(map, spec)) return { key: spec, targets: collectConditionalTargets(map[spec]) };
  const patterns = Object.keys(map)
    .filter(key => {
      const star = key.indexOf("*");
      return star >= 0 && star === key.lastIndexOf("*") && spec.length >= key.length &&
        spec.startsWith(key.slice(0, star)) && spec.endsWith(key.slice(star + 1));
    })
    .sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length);
  const pattern = patterns[0];
  if (!pattern) return undefined;
  const star = pattern.indexOf("*");
  const matched = spec.slice(star, spec.length - (pattern.length - star - 1));
  const targets = collectConditionalTargets(map[pattern]).map(target => target.replaceAll("*", () => matched));
  return { key: pattern, targets };
}

function parseEdges(file: string, text: string): Edge[] {
  // TypeScript infers ScriptKind from the filename, including TSX and JS variants.
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const edges: Edge[] = [];
  for (const ref of source.referencedFiles) {
    const name = slash(ref.fileName);
    const relative = !rootedPath(name) && !name.startsWith("./") && !name.startsWith("../");
    edges.push({
      spec: relative ? "./" + name : name,
      line: source.getLineAndCharacterOfPosition(ref.pos).line + 1,
      kind: "type", reference: "path",
    });
  }
  for (const ref of source.typeReferenceDirectives) {
    edges.push({
      spec: slash(ref.fileName),
      line: source.getLineAndCharacterOfPosition(ref.pos).line + 1,
      kind: "type", reference: "types",
    });
  }
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  function addEdge(node: ts.Node, argument: ts.Node | undefined, kind: EdgeKind) {
    const spec = argument && ts.isStringLiteralLike(argument) ? slash(argument.text) : "<dynamic-non-literal>";
    edges.push({ spec, line: line(node), kind });
  }
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
      addEdge(node, node.moduleSpecifier, typeOnly ? "type" : "runtime");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = Boolean(
        node.isTypeOnly ||
        (node.exportClause && ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every(element => element.isTypeOnly)),
      );
      addEdge(node, node.moduleSpecifier, typeOnly ? "type" : "reexport");
    } else if (ts.isImportTypeNode(node)) {
      addEdge(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, "type");
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addEdge(node, node.moduleReference.expression, node.isTypeOnly ? "type" : "require");
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      addEdge(node, node.arguments[0], node.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic" : "require");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}

type Resolution = { file: string } | { violation: string };

class ModuleGraph {
  private readonly profile: RuntimeProfile;
  private readonly root: string;
  private readonly files: ReadonlyMap<string, string>;
  private readonly virtualOnly: boolean;
  private readonly packageRoots = new Map<string, string>();
  private readonly manifestCache = new Map<string, PackageJson | null>();

  constructor(options: GraphOptions) {
    this.profile = options.profile ?? "browser-ui";
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
    const parsed: PackageJson | null = text === undefined ? null : JSON.parse(text);
    if (text !== undefined && !isStringRecord(parsed)) throw new Error(`Invalid manifest: ${this.label(file)}`);
    this.manifestCache.set(normalized, parsed);
    return parsed;
  }

  private loadManifest(packageRoot: string): PackageJson | null {
    return this.readManifest(path.join(packageRoot, "package.json"));
  }

  private findPackageRoot(from: string): string | undefined {
    let current = path.dirname(normalizeFile(from));
    while (true) {
      if (this.loadManifest(current)) return current;
      if (current === this.root || path.dirname(current) === current) return undefined;
      current = path.dirname(current);
    }
  }

  licenseViolation(file: string): string | undefined {
    const owner = this.findPackageRoot(file) ?? this.root;
    if (this.loadManifest(owner)?.license !== "Apache-2.0") return this.label(path.join(owner, "package.json"));
    if (this.loadManifest(this.root)?.license !== "Apache-2.0") return "package.json";
    return undefined;
  }

  private resolvePath(
    base: string, spec: string, lookup: "module" | "file-reference" | "package-root" = "module", seenDirs = new Set<string>(),
  ): Resolution[] {
    const relative = path.relative(this.root, base);
    if (relative.split(path.sep)[0] === ".." || path.isAbsolute(relative) || seenDirs.has(base)) return [{ violation: spec }];
    const extension = /\.d\.[cm]?ts$/u.exec(base)?.[0] ?? path.extname(base);
    let candidates: string[];
    if (lookup === "file-reference") {
      // A path directive names a file. A same-named directory cannot satisfy it.
      if (!relative || (extension && !SOURCE_EXTENSIONS.includes(extension))) return [{ violation: spec }];
      candidates = extension ? [base] : [".ts", ".tsx", ".d.ts"].map(ext => base + ext);
    } else if (!relative || lookup === "package-root") {
      candidates = [];
    } else if (SOURCE_EXTENSIONS.includes(extension)) {
      const stem = base.slice(0, -extension.length);
      candidates = [base, ...(SOURCE_SUBSTITUTIONS[extension] ?? []).map(ext => stem + ext)];
    } else {
      candidates = SOURCE_EXTENSIONS.map(ext => base + ext);
    }
    const manifest = lookup === "file-reference" ? null : this.loadManifest(base);
    // Relative CommonJS directory imports can still load index when exports exists.
    if (lookup !== "file-reference" && (manifest?.exports === undefined || !manifest.main)) {
      candidates.push(...SOURCE_EXTENSIONS.map(ext => path.join(base, "index" + ext)));
    }
    const results: Resolution[] = candidates.filter(file => this.readText(file) !== undefined).map(file => ({ file }));
    if (manifest) {
      const seen = new Set(seenDirs).add(base);
      if (manifest.exports !== undefined) {
        results.push(...this.resolveExports(base, manifest.exports, ".", spec, seen));
      }
      const targets = collectConditionalTargets([manifest.main, manifest.module, manifest.types, manifest.typings, manifest.browser]);
      for (const target of new Set(targets.map(slash))) {
        if (rootedPath(target)) results.push({ violation: target });
        else results.push(...this.resolvePath(path.resolve(base, target), target, "module", seen));
      }
    }
    return results.length ? results : [{ violation: spec }];
  }

  private resolveExports(root: string, exports: unknown, subpath: string, spec: string, seenDirs: Set<string>): Resolution[] {
    let targets: string[] | undefined;
    if (isStringRecord(exports) && Object.keys(exports).some(key => key.startsWith("."))) {
      targets = matchPatternMap(exports, subpath)?.targets;
    } else if (subpath === ".") {
      targets = collectConditionalTargets(exports);
    }
    if (!targets?.length) return [{ violation: spec }];
    return [...new Set(targets.map(slash))].flatMap(target => target.startsWith("./")
      ? this.resolvePath(path.resolve(root, target), target, "module", seenDirs)
      : [{ violation: target }]);
  }

  private resolvePackage(spec: string): Resolution[] {
    const [, name, rest] = spec.match(/^(@aistudy\/[^/]+)(\/.*)?$/u) ?? [];
    const root = this.packageRoots.get(name);
    const manifest = root && this.loadManifest(root);
    if (!root || !manifest) return [{ violation: spec }];
    const subpath = rest ? "." + rest : ".";
    if (manifest.exports === undefined) {
      return this.resolvePath(path.resolve(root, subpath), spec, subpath === "." ? "package-root" : "module");
    }
    return this.resolveExports(root, manifest.exports, subpath, spec, new Set([root]));
  }

  resolveEdge(edge: Edge, from: string): Resolution[] {
    if (edge.reference === "path") {
      if (rootedPath(edge.spec)) return [{ violation: edge.spec }];
      return this.resolvePath(path.resolve(path.dirname(from), edge.spec), edge.spec, "file-reference");
    }
    if (edge.reference === "types" && edge.spec.startsWith("node:")) return [{ violation: edge.spec }];
    return this.resolveImport(edge.spec, from);
  }

  private resolveImport(spec: string, from: string, seenSpecs = new Set<string>()): Resolution[] {
    if (this.profile === "portable-runtime" && PORTABLE_NODE_MODULES.has(spec)) return [];
    if (spec.startsWith("node:") || BUILTINS.has(spec) || CLOSED_PACKAGE_SPECS.some(pattern => pattern.test(spec))) {
      return [{ violation: spec }];
    }
    if (PORTABLE_EXTERNALS.has(spec)) return [];
    if (this.profile === "browser-ui" && UI_EXTERNALS.has(spec)) return [];
    if (spec.startsWith("#")) {
      const owner = this.findPackageRoot(from);
      const imports = owner && this.loadManifest(owner)?.imports;
      const match = imports && matchPatternMap(imports, spec);
      if (!owner || !match || !match.targets.length || seenSpecs.has(match.key)) return [{ violation: spec }];
      // Track matched keys per branch so even a wildcard that expands itself must terminate.
      const seen = new Set(seenSpecs).add(match.key);
      return [...new Set(match.targets.map(slash))].flatMap(target => target.startsWith("./")
        ? this.resolvePath(path.resolve(owner, target), target)
        : this.resolveImport(target, from, seen));
    }
    if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
      return this.resolvePath(path.resolve(path.dirname(from), spec), spec);
    }
    if (spec.startsWith("@aistudy/")) return this.resolvePackage(spec);
    return [{ violation: spec }];
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
  for (const rawEntry of entries) {
    const entry = normalizeFile(rawEntry);
    const entryLabel = graph.label(entry);
    const stack = [{ file: entry, chain: [entryLabel] }];
    const visited = new Set([entry]);
    const reportedLicenses = new Set<string>();
    while (stack.length) {
      const current = stack.pop()!;
      const text = graph.text(current.file);
      if (text === undefined || isClosedFile(current.file, options.root)) {
        violations.push({ entry: entryLabel, target: graph.label(current.file), chain: current.chain });
        continue;
      }
      const license = options.requirePermissiveCandidateLicense && graph.licenseViolation(current.file);
      if (license && !reportedLicenses.has(license)) {
        reportedLicenses.add(license);
        violations.push({ entry: entryLabel, target: license, chain: [...current.chain, license] });
      }
      for (const edge of parseEdges(current.file, text)) {
        const kind = edge.kind === "runtime" ? "" : ` [${edge.kind}]`;
        const hop = `${graph.label(current.file)}:${edge.line} -> ${edge.spec}${kind}`;
        for (const target of graph.resolveEdge(edge, current.file)) {
          if ("violation" in target) {
            violations.push({ entry: entryLabel, target: target.violation, chain: [...current.chain, hop, target.violation] });
          } else if (!visited.has(target.file)) {
            visited.add(target.file);
            stack.push({ file: target.file, chain: [...current.chain, hop, graph.label(target.file)] });
          }
        }
      }
    }
  }
  return { violations };
}

function virtualAnalyze(files: Record<string, string>, entry: string, packageJson?: PackageJson, profile?: RuntimeProfile) {
  const root = normalizeFile("__v3_open_core_virtual__");
  const virtualFiles = new Map<string, string>(
    Object.entries(files).map(([file, text]) => [path.join(root, file), text]),
  );
  if (packageJson) virtualFiles.set(path.join(root, "package.json"), JSON.stringify(packageJson));
  return analyzeModuleGraph([path.join(root, entry)], { root, files: virtualFiles, virtualOnly: true, profile });
}

function formatViolations(violations: BoundaryViolation[]): string {
  return violations.map(violation => `${violation.entry} reaches ${violation.target}\n  ${violation.chain.join("\n  ")}`).join("\n");
}

describe("v3 Open-Core public candidate boundary", () => {
  it("keeps every real public candidate free of closed-core and server-only transitive targets", () => {
    const root = path.resolve(__dirname, "../..");
    const candidates: Record<RuntimeProfile, { required: string[]; optional: string[] }> = {
      "browser-ui": {
        required: ["packages/jingwei/src/index.ts", "packages/jingwei/src/react/index.ts", "packages/ui/src/index.ts"],
        optional: [],
      },
      "portable-runtime": {
        required: ["packages/domain/src/portability/native/index.ts", "packages/contracts/src/index.ts"],
        optional: [
          "packages/contracts/src/learner-portability/index.ts",
          "packages/contracts/src/cartridge-lite/index.ts",
          "packages/domain/src/cartridge-sdk-lite/index.ts",
          "packages/domain/src/opening/cartridge-spi.ts",
          "packages/cartridge-sdk-lite/src/index.ts",
        ],
      },
    };
    for (const profile of ["browser-ui", "portable-runtime"] as const) {
      const { required, optional } = candidates[profile];
      const entries = [
        ...required,
        ...optional.filter(file => lstatSync(path.join(root, file), { throwIfNoEntry: false }) !== undefined),
      ].map(file => path.join(root, file));
      for (const entry of entries) {
        expect(statSync(entry).isFile(), entry).toBe(true);
        accessSync(entry, constants.R_OK);
      }
      const { violations } = analyzeModuleGraph(entries, { root, profile });
      expect(violations, formatViolations(violations)).toEqual([]);
    }
  });

  it("accepts a portable candidate with public contracts and pure external dependencies", () => {
    const result = virtualAnalyze({
      "contracts/package.json": JSON.stringify({ name: "@aistudy/contracts", exports: "./public.d.ts" }),
      "contracts/public.d.ts": "export type BackupFileManifestEntry = string;",
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

  it.each([
    ['type T = import("@aistudy/ai").T', "@aistudy/ai", "type"],
    ['type T = typeof import("@aistudy/ai")', "@aistudy/ai", "type"],
    ['type T = import("react").Box<import("pg").T>', "pg", "type"],
    ["type T = import(ModuleName).T", "<dynamic-non-literal>", "type"],
    ['import x = require("postgres")', "postgres", "require"],
    ['import type x = require("jose")', "jose", "type"],
    ['import("@aistudy/ai", { with: { type: "json" } })', "@aistudy/ai", "dynamic"],
    ['require(`pg`, opts)', "pg", "require"],
    ["import(name)", "<dynamic-non-literal>", "dynamic"],
    ["import(`./${name}`)", "<dynamic-non-literal>", "dynamic"],
    ["import()", "<dynamic-non-literal>", "dynamic"],
    ["require(name, opts)", "<dynamic-non-literal>", "require"],
    ["require()", "<dynamic-non-literal>", "require"],
  ])("reports the module edge in %s", (code, target, kind) => {
    const { violations } = virtualAnalyze({ "index.ts": code }, "index.ts");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ entry: "index.ts", target });
    expect(violations[0].chain).toContain(`index.ts:1 -> ${target} [${kind}]`);
  });

  it.each([
    ["epistemic/closed.d.ts", "./epistemic/closed.d.ts"],
    ["./epistemic/closed.d.mts", "./epistemic/closed.d.mts"],
    ["../epistemic/closed.d.cts", "../epistemic/closed.d.cts"],
  ])("follows declaration path references relative to the declaring file: %s", (reference, spec) => {
    const file = reference.startsWith("../") ? reference.slice(3) : "types/" + reference.replace(/^\.\//u, "");
    const { violations } = virtualAnalyze({
      "index.ts": 'export type * from "./types/public.d.ts";',
      "types/public.d.ts": `// Public declarations\n/// <reference path="${reference}" />`,
      [file]: "export type T = number;",
    }, "index.ts");
    expect(violations).toHaveLength(1);
    expect(violations[0].target).toBe(file);
    expect(violations[0].chain).toContain(`types/public.d.ts:2 -> ${spec} [type]`);
  });

  it("accepts a portable declaration and rejects missing, absolute and escaping reference paths", () => {
    const references = ["public.d.ts", "missing.d.ts", "../../outside.d.ts", "/outside.d.ts", "X:relative.d.ts", "X:/absolute.d.ts"];
    const { violations } = virtualAnalyze({
      "types/index.d.ts": references.map(ref => `/// <reference path="${ref}" />`).join("\n"),
      "types/public.d.ts": "export {};",
      "types/missing.d.ts/index.ts": "export {};",
    }, "types/index.d.ts");
    expect(violations.map(v => v.target)).toEqual(["./missing.d.ts", ...references.slice(2)]);
  });

  it.each(["browser-ui", "portable-runtime"] as const)("rejects unlisted ambient type packages under %s", profile => {
    const names = ["node", "pg", "unknown-ambient", "node:crypto"];
    const { violations } = virtualAnalyze({
      "index.d.ts": names.map(name => `/// <reference types="${name}" />`).join("\n"),
    }, "index.d.ts", undefined, profile);
    expect(violations.map(v => v.target)).toEqual(names);
    for (const [i, v] of violations.entries()) expect(v.chain).toContain(`index.d.ts:${i + 1} -> ${names[i]} [type]`);
  });

  it.each(['require("./helper")', 'import "./helper"'])("reads directory main alongside a clean index for %s", code => {
    const { violations } = virtualAnalyze({
      "index.ts": code,
      "helper/package.json": JSON.stringify({ main: "./runtime.cjs" }),
      "helper/index.js": "export {};",
      "helper/runtime.cjs": 'require("pg");',
    }, "index.ts");
    expect(violations.map(v => v.target)).toEqual(["pg"]);
    expect(violations[0].chain).toContain("helper/runtime.cjs");
  });

  it.each([true, false])("scans all root exports and legacy directory entries (subpath map: %s)", withSubpath => {
    const conditions = { types: "./public.d.ts", default: [{ browser: "./client.js" }, "./runtime.cjs"] };
    const { violations } = virtualAnalyze({
      "index.ts": 'import "./helper";',
      "helper/package.json": JSON.stringify({
        exports: withSubpath ? { ".": conditions, "./other": "./unrelated.js" } : conditions,
        main: "legacy.cjs", browser: { "./legacy.cjs": "./browser.js", "./disabled.js": false },
      }),
      "helper/public.d.ts": "export {};",
      "helper/client.js": 'import "node:fs";',
      "helper/runtime.cjs": 'require("pg");',
      "helper/legacy.cjs": 'require("jose");',
      "helper/browser.js": 'import "server-only";',
    }, "index.ts");
    expect(violations.map(v => v.target).sort()).toEqual(["jose", "node:fs", "pg", "server-only"]);
  });

  it("rejects a directory without a root export despite its valid legacy main and index", () => {
    const { violations } = virtualAnalyze({
      "index.ts": 'import "./helper";',
      "helper/package.json": JSON.stringify({ exports: { "./sub": "./index.js" }, main: "./index.js" }),
      "helper/index.js": "export {};",
    }, "index.ts");
    expect(violations.map(v => v.target)).toEqual(["./helper"]);
  });

  it("reports every broken legacy directory target alongside a transitive violation from index", () => {
    const { violations } = virtualAnalyze({
      "index.ts": 'import "./helper";',
      "helper/package.json": JSON.stringify({ main: "./missing.cjs", module: "../../escaped.mjs", browser: "./browser.js" }),
      "helper/index.js": 'import "pg";',
    }, "index.ts");
    expect(violations.map(v => v.target).sort()).toEqual(["../../escaped.mjs", "./browser.js", "./missing.cjs", "pg"]);
  });

  it("checks the CommonJS directory index when exports is defined without a legacy main", () => {
    const { violations } = virtualAnalyze({
      "index.ts": 'require("./helper");',
      "helper/package.json": JSON.stringify({ exports: "./public.js" }),
      "helper/public.js": "export {};",
      "helper/index.js": 'require("pg");',
    }, "index.ts");
    expect(violations.map(v => v.target)).toEqual(["pg"]);
  });

  it("rejects a missing workspace package entry despite a same-named sibling file", () => {
    const { violations } = virtualAnalyze({
      "index.ts": 'import "@aistudy/lite";',
      "lite/package.json": JSON.stringify({ name: "@aistudy/lite" }),
      "lite.ts": "export {};",
    }, "index.ts");
    expect(violations.map(v => v.target)).toEqual(["@aistudy/lite"]);
  });

  it.each(["./helper", "@aistudy/lite"])("scans module and typings entries without exports for %s", spec => {
    const { violations } = virtualAnalyze({
      "index.ts": `import "${spec}";`,
      "helper/package.json": JSON.stringify({ name: "@aistudy/lite", module: "./esm.mjs", typings: "./decl.d.cts" }),
      "helper/esm.mjs": 'import "pg";',
      "helper/decl.d.cts": 'export type T = import("jose").T;',
    }, "index.ts");
    expect(violations.map(v => v.target).sort()).toEqual(["jose", "pg"]);
  });

  it("rejects a self-referential directory main and still walks independent entries", () => {
    const { violations } = virtualAnalyze({
      "index.ts": 'import "./helper";',
      "helper/package.json": JSON.stringify({ main: ".", types: "./decl.d.ts" }),
      "helper/decl.d.ts": 'export type T = import("pg").T;',
      "helper/index.ts": "export {};",
    }, "index.ts");
    expect(violations.map(v => v.target).sort()).toEqual([".", "pg"]);
  });

  it("walks every conditional export and import branch, including missing siblings", () => {
    const { violations } = virtualAnalyze({
      "index.ts": 'export * from "@aistudy/lite/rules";',
      "lite/package.json": JSON.stringify({
        name: "@aistudy/lite",
        exports: {
          "./*": { types: "./*.d.ts", default: ["./*.js", { browser: "./missing-*.js" }] },
        },
        imports: { "#rules": { import: "./portable.ts", require: { node: "./server.cts" } } },
      }),
      "lite/rules.d.ts": "export type T = string;",
      "lite/rules.js": 'export * from "#rules";',
      "lite/portable.ts": "export {};",
      "lite/server.cts": 'require("pg");',
    }, "index.ts");
    expect(violations.map(v => v.target).sort()).toEqual(["./missing-rules.js", "pg"]);
  });

  it("rejects an unexported subpath despite a public main, types and source file", () => {
    const { violations } = virtualAnalyze({
      "index.ts": 'export * from "@aistudy/lite/missing";',
      "lite/package.json": JSON.stringify({
        name: "@aistudy/lite", types: "./public.ts", main: "./public.ts", exports: { ".": "./public.ts" },
      }),
      "lite/public.ts": "export {};",
      "lite/missing.ts": "export {};",
    }, "index.ts");
    expect(violations.map(v => v.target)).toEqual(["@aistudy/lite/missing"]);
  });

  it("prefers a longer wildcard prefix even when a shorter prefix has a longer suffix", () => {
    const { violations } = virtualAnalyze({
      "index.ts": 'import "#private/level.js";',
      "public.ts": "export {};",
      "diagnostic-placement/level.js": "export {};",
    }, "index.ts", { imports: { "#*": "./public.ts", "#*.js": "./public.ts", "#private/*": "./diagnostic-placement/*" } });
    expect(violations.map(v => v.target)).toEqual(["diagnostic-placement/level.js"]);
  });

  it("prefers the longest suffix among equal wildcard prefixes and honors exact blocked keys", () => {
    const imports = {
      "#private/*": "./public.ts",
      "#private/*.js": "./exam-forecast/*.ts",
      "#private/blocked.js": null,
    };
    const { violations } = virtualAnalyze({
      "index.ts": 'import "#private/score.js";\nimport "#private/blocked.js";',
      "public.ts": "export {};",
      "exam-forecast/score.ts": "export {};",
    }, "index.ts", { imports });
    expect(violations.map(v => v.target).sort()).toEqual([
      "#private/blocked.js", "exam-forecast/score.ts",
    ]);
  });

  it("reports cyclic aliases and still inspects their other conditions", () => {
    const { violations } = virtualAnalyze({ "index.ts": 'import "#a";' }, "index.ts", {
      imports: { "#a": "#b", "#b": { types: "#a", default: "server-only" } },
    });
    expect(violations.map(v => v.target).sort()).toEqual(["#a", "server-only"]);
  });

  it.each(["browser-ui", "portable-runtime"] as const)("applies %s to every transitive builtin import", profile => {
    const memory = ["node:crypto", "node:buffer"];
    const restricted = ["crypto", "buffer", "fs", "node:fs", "node:fs/promises", "node:child_process", "node:net",
      "node:tls", "node:http", "node:https", "node:os", "node:worker_threads", "node:vm"];
    const files = {
      "index.ts": 'export * from "./helper";',
      "helper.ts": [...memory, ...restricted].map(spec => `import ${JSON.stringify(spec)};`).join("\n") + '\nimport "#hash";',
    };
    const { violations } = virtualAnalyze(files, "index.ts", { imports: { "#hash": "node:crypto" } }, profile);
    const expected = profile === "browser-ui" ? [...restricted, ...memory, "node:crypto"] : restricted;
    expect(violations.map(v => v.target).sort()).toEqual(expected.sort());
  });

  it.each(["stack-408-v1", "ielts-writing-speaking-v1"])("blocks flagship cartridge %s in a portable graph", name => {
    const directoryEntry = `cartridges/${name}/index.ts`;
    const moduleEntry = `cartridges/${name}.ts`;
    const files = {
      "index.ts": `import "./${directoryEntry}";\nimport "./${moduleEntry}";`,
      [directoryEntry]: "export {};",
      [moduleEntry]: "export {};",
    };
    const { violations } = virtualAnalyze(files, "index.ts", undefined, "portable-runtime");
    expect(violations.map(v => v.target).sort()).toEqual([directoryEntry, moduleEntry].sort());
  });

  it.each(["./missing", "#unknown", "@aistudy/missing", "not-allowlisted", "node:crypto", "fs/promises", "next/navigation",
    "@aws-sdk/client-s3", "react-dom/server"])("rejects %s", spec => {
    const { violations } = virtualAnalyze({ "index.ts": `import ${JSON.stringify(spec)};` }, "index.ts");
    expect(violations.map(v => v.target)).toEqual([spec]);
  });

  it.each(["diagnostic-placement", "remedy-clinic", "rubric-calibration", "exam-forecast"])("blocks Wave P directory %s", name => {
    const file = `packages/${name === "rubric-calibration" ? "ai" : "domain"}/src/${name}/index.ts`;
    const { violations } = virtualAnalyze({ "index.ts": `export * from "./${file}";`, [file]: "export {};" }, "index.ts");
    expect(violations.map(v => v.target)).toEqual([file]);
  });

  it("parses TS generics and traverses ESM, CommonJS and declaration paths with normalized separators", () => {
    const { violations } = virtualAnalyze({
      "index.ts": 'const id = <T>(v: T) => v;\nexport * from ".\\\\lib\\\\esm.mjs";\nimport "./ambient";',
      "ambient.d.ts": 'export type T = import("pg").T;',
      "lib/esm.mts": 'export * from "./common.cjs";',
      "lib/common.cts": 'require("./prebuilt.mjs");',
      "lib/prebuilt.mjs": 'import "./built.cjs";',
      "lib/built.cjs": 'require("node:path");',
    }, "index.ts");
    expect(violations.map(v => v.target).sort()).toEqual(["node:path", "pg"]);
  });

  it("uses only repository-relative segments when classifying a target", () => {
    const root = path.resolve("epistemic", "repo");
    const entry = path.join(root, "index.ts");
    const files = new Map([[entry, 'export * from "./public";'], [path.join(root, "public.ts"), "export {};"]]);
    expect(analyzeModuleGraph([entry], { root, files, virtualOnly: true }).violations).toEqual([]);
  });

  it("requires Apache-2.0 manifests for the export while scanning private source candidates independently of license", () => {
    const root = path.resolve("__community_export__");
    const entry = path.join(root, "index.ts");
    const manifest = path.join(root, "sub", "package.json");
    const files = new Map([
      [entry, 'export * from "./sub/lib";'], [path.join(root, "sub", "lib.ts"), "export {};"],
      [path.join(root, "package.json"), '{"license":"Apache-2.0"}'], [manifest, '{"license":"UNLICENSED"}'],
    ]);
    const options = { root, files, virtualOnly: true };
    const exported = { ...options, requirePermissiveCandidateLicense: true };
    expect(analyzeModuleGraph([entry], options).violations).toEqual([]);
    expect(analyzeModuleGraph([entry], exported).violations.map(v => v.target)).toEqual(["sub/package.json"]);
    files.set(manifest, '{"license":"Apache-2.0"}');
    expect(analyzeModuleGraph([entry], exported).violations).toEqual([]);
    files.set(path.join(root, "package.json"), '{"license":"UNLICENSED"}');
    expect(analyzeModuleGraph([entry], exported).violations.map(v => v.target)).toEqual(["package.json"]);
  });
});
