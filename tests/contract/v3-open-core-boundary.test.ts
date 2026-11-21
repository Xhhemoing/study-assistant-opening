import {
  accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync, type Stats,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
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
  typesVersions?: unknown;
  browser?: string | Record<string, string | false>;
  exports?: unknown;
  imports?: Record<string, unknown>;
};

type Use = "runtime" | "type";
type EdgeKind = Use | "types-directive" | "reexport" | "dynamic" | "require";
type RuntimeProfile = "browser-ui" | "portable-runtime";
type PublicCandidate = { source: string; spec: string; optional?: boolean };

type Edge = {
  spec: string;
  line: number;
  kind: EdgeKind;
  reference?: "path";
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
  ".ts": [".d.ts"],
  ".tsx": [".d.ts"],
  ".mts": [".d.mts"],
  ".cts": [".d.cts"],
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
const declaration = (file: string) => /\.d\.[cm]?ts$/iu.test(file);
const DECLARATION_EXTENSIONS = SOURCE_EXTENSIONS.filter(declaration);

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative);
}

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

type ManifestTarget = { spec: string; use: Use };

function collectConditionalTargets(value: unknown, use: Use, packageMap = false): ManifestTarget[] {
  if (typeof value === "string") return [{ spec: slash(value), use }];
  if (Array.isArray(value) || isStringRecord(value)) {
    return Object.entries(value).flatMap(([key, child]) =>
      collectConditionalTargets(child, key === "types" || key.startsWith("types@") ? "type" : use, packageMap));
  }
  return packageMap && value != null ? [{ spec: "<invalid-package-target>", use }] : [];
}

function legacyEntries(manifest: PackageJson): ManifestTarget[] {
  const browser = isStringRecord(manifest.browser) ? Object.values(manifest.browser) : [manifest.browser];
  return [
    ...collectConditionalTargets([manifest.main, manifest.module, ...browser], "runtime"),
    ...collectConditionalTargets([manifest.types, manifest.typings], "type"),
  ];
}

function validVersionSelector(selector: string): boolean {
  // The pinned compiler exposes its typesVersions parser at runtime but omits it from its public typings.
  const { VersionRange } = ts as typeof ts & { VersionRange: { tryParse(text: string): unknown } };
  try {
    return VersionRange.tryParse(selector) !== undefined;
  } catch {
    // Malformed prerelease or build identifiers can raise a compiler assertion.
    return false;
  }
}

function declarationQueries(name: string): string[] {
  const relative = path.posix.normalize(slash(name));
  const ext = path.posix.extname(relative);
  if (declaration(relative)) return [relative, relative.replace(/\.d\.[cm]?ts$/iu, "")];
  const substitutions = SOURCE_SUBSTITUTIONS[ext];
  const stem = substitutions ? relative.slice(0, -ext.length) : relative;
  const suffixes = substitutions?.filter(declaration) ?? DECLARATION_EXTENSIONS;
  return [relative, stem, ...suffixes.map(suffix => stem + suffix)];
}

function versionTargets(pattern: string, replacement: string, spellings: string[]): string[] {
  const [prefix, suffix] = pattern.split("*");
  if (suffix === undefined) return spellings.includes(prefix) ? [slash(replacement)] : [];
  const targets = new Set<string>();
  for (const query of spellings) {
    if (query.length < prefix.length + suffix.length || !query.startsWith(prefix) || !query.endsWith(suffix)) continue;
    const capture = query.slice(prefix.length, query.length - suffix.length);
    targets.add(slash(replacement).replace("*", () => capture));
  }
  return [...targets];
}

function matchPatternMap(map: Record<string, unknown>, spec: string, use: Use) {
  if (Object.hasOwn(map, spec)) return { key: spec, targets: collectConditionalTargets(map[spec], use, true) };
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
  const targets = collectConditionalTargets(map[pattern], use, true).map(target => ({
    ...target, spec: target.spec.replaceAll("*", () => matched),
  }));
  return { key: pattern, targets };
}

function isRequireLoader(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === "require";
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return false;
  if (!ts.isIdentifier(expression.expression) || expression.expression.text !== "module") return false;
  return ts.isPropertyAccessExpression(expression) ? expression.name.text === "require" :
    ts.isStringLiteralLike(expression.argumentExpression) && expression.argumentExpression.text === "require";
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
      kind: "types-directive",
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
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequireLoader(node.expression))
    ) {
      addEdge(node, node.arguments[0], node.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic" : "require");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}

type Resolution = { file: string; use: Use } | { violation: string; absent?: true };

function requireTarget(results: Resolution[], spec: string, use: Use): Resolution[] {
  if (!results.length) return [{ violation: spec }];
  if (use === "type") return results.map(result => "file" in result ? { ...result, use: "type" } : result);
  if (results.every(result => "file" in result && result.use === "type")) results.push({ violation: spec });
  return results;
}

class BlockedPath extends Error {}

type DiskEntry = { physical: string; stats: Stats; link?: string };

function resolveBranch(resolve: () => Resolution[]): Resolution[] {
  try {
    return resolve();
  } catch (error) {
    if (error instanceof BlockedPath) return [{ violation: error.message }];
    throw error;
  }
}

class ModuleGraph {
  private readonly profile: RuntimeProfile;
  private readonly root: string;
  private readonly realRoot: string;
  private readonly files: ReadonlyMap<string, string>;
  private readonly virtualOnly: boolean;
  private readonly packageRoots = new Map<string, string>();
  private readonly manifestCache = new Map<string, PackageJson | null>();
  private readonly diskEntries = new Map<string, DiskEntry | undefined>();

  constructor(options: GraphOptions) {
    this.profile = options.profile ?? "browser-ui";
    this.root = normalizeFile(options.root);
    this.files = new Map([...options.files ?? new Map()].map(([file, text]) => [normalizeFile(file), text]));
    this.virtualOnly = options.virtualOnly ?? false;
    this.realRoot = this.virtualOnly ? this.root : normalizeFile(realpathSync.native(this.root));
    if (!this.virtualOnly) this.diskEntries.set(this.root, { physical: this.realRoot, stats: statSync(this.realRoot) });
    for (const [file] of this.files) {
      if (path.basename(file) !== "package.json" || this.label(file).split("/").includes("node_modules")) continue;
      if (isClosedFile(file, this.root)) continue;
      const manifest = this.registeredManifest(path.dirname(file));
      if (manifest?.name) this.packageRoots.set(manifest.name, path.dirname(file));
    }
    if (!this.virtualOnly) {
      const packagesRoot = path.join(this.root, "packages");
      let directory: DiskEntry | undefined;
      try {
        directory = this.diskEntry(packagesRoot);
      } catch (error) {
        if (error instanceof BlockedPath) return;
        throw error;
      }
      if (directory?.stats.isDirectory()) {
        for (const entry of readdirSync(directory.physical, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const packageRoot = path.join(packagesRoot, entry.name);
          const manifest = this.registeredManifest(packageRoot);
          if (manifest?.name) this.packageRoots.set(manifest.name, packageRoot);
        }
      }
    }
  }

  private registeredManifest(packageRoot: string): PackageJson | null {
    try {
      return this.loadManifest(packageRoot);
    } catch (error) {
      // An inaccessible workspace cannot supply a resolvable package name.
      if (error instanceof BlockedPath) return null;
      throw error;
    }
  }

  private diskEntry(file: string): DiskEntry | undefined {
    if (!within(this.root, file)) throw new BlockedPath(this.label(file));
    if (this.diskEntries.has(file)) return this.diskEntries.get(file);
    const parent = this.diskEntry(path.dirname(file));
    // A regular file cannot own a package.json or index file on either platform.
    const entry = parent?.stats.isDirectory() ? this.probeDiskEntry(file, parent.physical) : undefined;
    this.diskEntries.set(file, entry);
    return entry;
  }

  private probeDiskEntry(file: string, parent: string): DiskEntry | undefined {
    const child = path.join(parent, path.basename(file));
    let stats: Stats | undefined;
    try {
      stats = lstatSync(child, { throwIfNoEntry: false });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw new BlockedPath(this.label(file));
    }
    if (!stats) return undefined;
    let physical: string;
    try {
      physical = normalizeFile(realpathSync.native(child));
    } catch {
      // Once lstat finds an entry, a broken or cyclic link is a hard failure.
      throw new BlockedPath(this.label(file));
    }
    if (!within(this.realRoot, physical)) throw new BlockedPath(this.label(file));
    if (!stats.isSymbolicLink()) return { physical, stats };
    // Following the same directory link again could grow the lexical graph without bound.
    for (let dir = path.dirname(file); dir !== this.root; dir = path.dirname(dir)) {
      const link = this.diskEntries.get(dir)?.link;
      if (link && !path.relative(link, child)) throw new BlockedPath(this.label(file));
    }
    try {
      return { physical, stats: statSync(physical), link: child };
    } catch {
      throw new BlockedPath(this.label(file));
    }
  }

  // Express the canonical path in the checkout's namespace, including when the root is a link.
  sourcePath(file: string): string | undefined {
    if (!within(this.root, file)) throw new BlockedPath(this.label(file));
    let source: string | undefined;
    if (this.files.has(file)) source = file;
    else if (!this.virtualOnly) {
      const entry = this.diskEntry(file);
      if (entry?.stats.isFile()) source = path.join(this.root, path.relative(this.realRoot, entry.physical));
    }
    if (source && isClosedFile(file, this.root)) throw new BlockedPath(this.label(file));
    if (source && isClosedFile(source, this.root)) throw new BlockedPath(this.label(source));
    return source;
  }

  readSource(file: string, checkLicense = false) {
    const source = this.sourcePath(file);
    if (!source) return undefined;
    const license = checkLicense ? this.licenseViolation(file, source) : undefined;
    try {
      const text = this.files.get(file) ?? readFileSync(path.join(this.realRoot, path.relative(this.root, source)), "utf8");
      return { source, text, license };
    } catch {
      throw new BlockedPath(this.label(file));
    }
  }

  private readManifest(file: string): PackageJson | null {
    const normalized = normalizeFile(file);
    if (this.manifestCache.has(normalized)) return this.manifestCache.get(normalized) ?? null;
    const text = this.readSource(normalized)?.text;
    let parsed: PackageJson | null = null;
    if (text !== undefined) {
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new BlockedPath(this.label(file));
      }
      if (!isStringRecord(parsed)) throw new BlockedPath(this.label(file));
    }
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

  private licenseViolation(file: string, source: string): string | undefined {
    for (const candidate of new Set([file, source])) {
      const owner = this.findPackageRoot(candidate) ?? this.root;
      if (this.loadManifest(owner)?.license !== "Apache-2.0") return this.label(path.join(owner, "package.json"));
    }
    if (this.loadManifest(this.root)?.license !== "Apache-2.0") return "package.json";
    return undefined;
  }

  private resolvePath(
    base: string, spec: string, use: Use, lookup: "module" | "relative" | "file-reference" | "package-root" = "module", seenDirs = new Set<string>(),
    packageScope?: string,
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
    if (packageScope) {
      this.checkPackagePath(packageScope, base, spec);
      this.checkPackagePath(packageScope, path.join(base, "package.json"), spec);
    }
    const manifest = lookup === "file-reference" ? null : this.loadManifest(base);
    // Relative CommonJS directory imports can still load index when exports exists.
    if (lookup !== "file-reference") {
      candidates.push(...SOURCE_EXTENSIONS.map(ext => path.join(base, "index" + ext)));
    }
    const results: Resolution[] = [];
    for (const file of candidates) {
      results.push(...resolveBranch(() => {
        if (packageScope) this.checkPackagePath(packageScope, file, spec);
        const source = this.sourcePath(file);
        if (!source) return [];
        const implementation = SOURCE_EXTENSIONS.includes(path.extname(source)) && !declaration(source) && !declaration(file);
        return [{ file, use: implementation ? use : "type" }];
      }));
    }
    if (manifest) {
      const physical = this.virtualOnly ? base : this.diskEntry(base)?.physical ?? base;
      if (seenDirs.has(physical)) return [{ violation: spec }];
      const seen = new Set(seenDirs).add(physical);
      const exports = this.exportTargets(manifest.exports, ".", use);
      if (manifest.exports !== undefined) {
        results.push(...this.resolveExports(base, exports, spec, use, seen));
      }
      const legacy = legacyEntries(manifest);
      for (const target of legacy) {
        results.push(...this.resolveManifestTarget(base, target, seen, packageScope));
      }
      if (manifest.typesVersions !== undefined) {
        const names = [...exports, ...legacy].map(target => target.spec);
        const versioned = this.versionedDeclarations(base, manifest, spec, names, results);
        return [...requireTarget(results, spec, use), ...versioned];
      }
    }
    if (!manifest && !results.length && (lookup === "relative" || lookup === "file-reference")) {
      // Only a plain lookup miss may be satisfied from the other side of a link.
      if (!this.files.has(base) && (this.virtualOnly || !this.diskEntry(base))) return [{ violation: spec, absent: true }];
    }
    return requireTarget(results, spec, use);
  }

  private exportTargets(exports: unknown, subpath: string, use: Use): ManifestTarget[] {
    if (isStringRecord(exports) && Object.keys(exports).some(key => key.startsWith("."))) {
      if (Object.keys(exports).some(key => key !== "." && !key.startsWith("./"))) return [{ spec: "<invalid-package-target>", use }];
      return matchPatternMap(exports, subpath, use)?.targets ?? [];
    }
    return subpath === "." ? collectConditionalTargets(exports, use, true) : [];
  }

  private resolveManifestTarget(root: string, target: ManifestTarget, seenDirs: Set<string>, packageScope?: string): Resolution[] {
    if (rootedPath(target.spec)) return [{ violation: target.spec }];
    const paths = new Set([path.resolve(root, target.spec)]);
    // Parent-relative entries can select different files on either side of a junction.
    if (target.spec.split("/").includes("..") && !this.virtualOnly) {
      const manifest = this.sourcePath(path.join(root, "package.json"));
      if (manifest) paths.add(path.resolve(path.dirname(manifest), target.spec));
    }
    return [...paths].flatMap(file => resolveBranch(() => this.resolvePath(file, target.spec, target.use, "module", seenDirs, packageScope)));
  }

  private checkPackagePath(owner: string, file: string, spec: string): void {
    if (!within(owner, file)) throw new BlockedPath(spec);
    if (this.virtualOnly || this.files.has(file)) return;
    const physicalOwner = this.diskEntry(owner);
    const target = this.diskEntry(file);
    if (target && (!physicalOwner || !within(physicalOwner.physical, target.physical))) throw new BlockedPath(spec);
  }

  private packageTargetName(owner: string, spec: string): string {
    if (!spec.startsWith("./")) throw new BlockedPath(spec);
    const pathname = spec.split(/[?#]/u, 1)[0];
    if (/%(?:2f|5c)/iu.test(pathname)) throw new BlockedPath(spec);
    let name: string;
    try {
      name = decodeURIComponent(pathname);
    } catch {
      throw new BlockedPath(spec);
    }
    if (name.includes("\0") || name.slice(2).split("/").some(part =>
      part === "." || part === ".." || part.toLowerCase() === "node_modules")) throw new BlockedPath(spec);
    this.checkPackagePath(owner, path.resolve(owner, name), spec);
    return name;
  }

  private resolvePackageTarget(owner: string, target: ManifestTarget, seenDirs: Set<string>): Resolution[] {
    return resolveBranch(() => {
      const name = this.packageTargetName(owner, target.spec);
      return this.resolvePath(path.resolve(owner, name), target.spec, target.use, "module", seenDirs, owner);
    });
  }

  private resolveExports(root: string, targets: ManifestTarget[], spec: string, use: Use, seenDirs: Set<string>): Resolution[] {
    const results = targets.flatMap(target => this.resolvePackageTarget(root, target, seenDirs));
    return requireTarget(results, spec, use);
  }

  private resolvePackage(spec: string, use: Use, candidateOwner?: string): Resolution[] {
    const [, name, rest] = spec.match(/^(@aistudy\/[^/]+)(\/.*)?$/u) ?? [];
    const root = candidateOwner ?? this.packageRoots.get(name);
    const manifest = root && this.loadManifest(root);
    if (!root || !manifest || manifest.name !== name) return [{ violation: spec }];
    const subpath = rest ? "." + rest : ".";
    if (subpath === "." && manifest.exports === undefined) return this.resolvePath(root, spec, use, "package-root");
    if (candidateOwner && manifest.exports === undefined) return [{ violation: spec }];
    const exports = this.exportTargets(manifest.exports, subpath, use);
    const results = manifest.exports === undefined
      ? this.resolvePath(path.resolve(root, this.packageTargetName(root, subpath)), spec, use, "module", new Set(), root)
      : this.resolveExports(root, exports, spec, use, new Set([root]));
    const names = exports.map(target => target.spec);
    if (subpath === ".") {
      for (const target of legacyEntries(manifest)) {
        names.push(target.spec);
        results.push(...this.resolveManifestTarget(root, target, new Set([root])));
      }
      if (manifest.typesVersions !== undefined) results.push(...this.declarationFiles(root, "index", spec));
    } else names.push(subpath);
    if (manifest.typesVersions !== undefined) {
      results.push(...this.versionedDeclarations(root, manifest, spec, names, results, subpath === "."));
    }
    return results;
  }

  private resolveAmbient(spec: string, from: string): Resolution[] {
    // TypeScript mangles @scope/name to @types/scope__name.
    const name = spec.replace(/^@types\//u, "").replace(/^([\w.-]+)__([\w.-]+)$/u, "@$1/$2");
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name) ||
        name === "node" || BUILTINS.has(name) || CLOSED_PACKAGE_SPECS.some(pattern => pattern.test(name))) {
      return [{ violation: spec }];
    }
    const directoryName = name.replace(/^@/u, "").replace("/", "__");
    let directory = path.dirname(from);
    while (within(this.root, directory)) {
      const owner = path.join(directory, "node_modules", "@types", directoryName);
      const present = [...this.files.keys()].some(file => within(owner, file));
      if (present || (!this.virtualOnly && this.diskEntry(owner))) return this.ambientEntries(owner, spec);
      if (directory === this.root) break;
      directory = path.dirname(directory);
    }
    return [{ violation: spec, absent: true }];
  }

  private declarationFiles(owner: string, target: string, spec: string): Resolution[] {
    const base = path.resolve(owner, target);
    if (rootedPath(target) || !within(owner, base)) return [{ violation: spec }];
    const ext = path.extname(base);
    const suffixes = SOURCE_SUBSTITUTIONS[ext];
    const candidates = declaration(base) ? [base] : [
      ...(suffixes ? suffixes.filter(declaration).map(suffix => base.slice(0, -ext.length) + suffix)
        : DECLARATION_EXTENSIONS.map(suffix => base + suffix)),
      ...DECLARATION_EXTENSIONS.map(suffix => path.join(base, "index" + suffix)),
    ];
    const physicalOwner = this.virtualOnly ? undefined : this.diskEntry(owner)?.physical;
    return candidates.flatMap(file => resolveBranch(() => {
      // The package root can supply index declarations, never a same-named sibling.
      if (!within(owner, file)) return [];
      const source = this.sourcePath(file);
      if (!source) return [];
      if (physicalOwner && !within(physicalOwner, path.join(this.realRoot, path.relative(this.root, source)))) {
        return [{ violation: spec }];
      }
      return declaration(source) ? [{ file, use: "type" }] : [{ violation: spec }];
    }));
  }

  private versionedDeclarations(owner: string, manifest: PackageJson, spec: string, declaredNames: string[], entries: Resolution[], rootEntry = true): Resolution[] {
    const versions = manifest.typesVersions;
    if (!isStringRecord(versions)) return [{ violation: spec }];
    const names = [...declaredNames, ...entries.flatMap(entry => "file" in entry && within(owner, entry.file) && declaration(entry.file)
      ? [slash(path.relative(owner, entry.file))] : [])];
    if (!names.length || (rootEntry && !manifest.main && !manifest.types && !manifest.typings)) names.push("index");
    const queries = [...new Set(names)].map(declarationQueries);
    const results: Resolution[] = [];
    // Manifests are parsed JSON. Validate even selectors and patterns without a current match.
    for (const [selector, mapping] of Object.entries(versions)) {
      if (!validVersionSelector(selector) || !isStringRecord(mapping)) return [{ violation: spec }];
      for (const [pattern, replacements] of Object.entries(mapping)) {
        if (pattern.indexOf("*") !== pattern.lastIndexOf("*") || !Array.isArray(replacements) || !replacements.length ||
            !replacements.every(item => typeof item === "string" && item.length)) return [{ violation: spec }];
        for (const spellings of queries) {
          for (const replacement of replacements as string[]) {
            // Equivalent spellings satisfy the same replacement for this entry only.
            const targets = versionTargets(pattern, replacement, spellings);
            if (!targets.length) continue;
            const branch = targets.flatMap(target => this.declarationFiles(owner, target, spec));
            results.push(...requireTarget(branch, spec, "type"));
          }
        }
      }
    }
    return results;
  }

  private ambientEntries(owner: string, spec: string): Resolution[] {
    const manifest = this.loadManifest(owner);
    const targets = collectConditionalTargets([manifest?.types, manifest?.typings], "type");
    const exports = this.exportTargets(manifest?.exports, ".", "runtime");
    if (manifest?.exports !== undefined) {
      if (!exports.length) return [{ violation: spec }];
      targets.push(...exports);
    }
    if (!targets.length) targets.push({ spec: "index.d.ts", use: "type" });
    const resolved = targets.flatMap(target => resolveBranch(() => {
      const name = exports.includes(target) ? this.packageTargetName(owner, target.spec) : target.spec;
      const results = this.declarationFiles(owner, name, spec);
      // An explicit declaration must exist. JS export conditions contribute any paired declarations.
      return target.use === "type" || declaration(target.spec) ? requireTarget(results, spec, "type") : results;
    }));
    if (manifest?.typesVersions !== undefined) {
      resolved.push(...this.declarationFiles(owner, "index", spec));
      resolved.push(...this.versionedDeclarations(owner, manifest, spec, targets.map(target => target.spec), resolved));
    }
    return requireTarget(resolved, spec, "type");
  }

  resolveEdge(edge: Edge, source: string, lexical: string): Resolution[] {
    const origins = new Set([normalizeFile(source), normalizeFile(lexical)]);
    const branches = [...origins].map(from => resolveBranch(() => this.resolveFrom(edge, from)));
    const hasResolution = branches.some(branch => branch.every(target => "file" in target));
    const results = new Map<string, Resolution>();
    for (const target of branches.flat()) {
      if ("violation" in target && target.absent && hasResolution) continue;
      const key = "file" in target ? `${target.use}:${target.file}` : `violation:${target.violation}`;
      results.set(key, target);
    }
    return [...results.values()];
  }

  private resolveFrom(edge: Edge, from: string): Resolution[] {
    if (edge.kind === "types-directive") return this.resolveAmbient(edge.spec, from);
    if (edge.reference === "path") {
      if (rootedPath(edge.spec)) return [{ violation: edge.spec }];
      return this.resolvePath(path.resolve(path.dirname(from), edge.spec), edge.spec, "type", "file-reference");
    }
    return this.resolveImport(edge.spec, from, edge.kind === "type" || declaration(from) ? "type" : "runtime");
  }

  private resolveImport(spec: string, from: string, use: Use, seenSpecs = new Set<string>()): Resolution[] {
    if (this.profile === "portable-runtime" && PORTABLE_NODE_MODULES.has(spec)) return [];
    if (spec.startsWith("node:") || BUILTINS.has(spec) || CLOSED_PACKAGE_SPECS.some(pattern => pattern.test(spec))) {
      return [{ violation: spec }];
    }
    if (PORTABLE_EXTERNALS.has(spec)) return [];
    if (this.profile === "browser-ui" && UI_EXTERNALS.has(spec)) return [];
    if (spec.startsWith("#")) {
      const owner = this.findPackageRoot(from);
      const imports = owner ? this.loadManifest(owner)?.imports : undefined;
      if (imports !== undefined && !isStringRecord(imports)) return [{ violation: spec }];
      const match = imports && matchPatternMap(imports, spec, use);
      if (!owner || !match) {
        // Only an unmapped original specifier may fall back to the other side of a link.
        return seenSpecs.size ? [{ violation: spec }] : [{ violation: spec, absent: true }];
      }
      if (!match.targets.length || seenSpecs.has(match.key)) return [{ violation: spec }];
      // Track matched keys per branch so even a wildcard that expands itself must terminate.
      const seen = new Set(seenSpecs).add(match.key);
      const results = match.targets.flatMap(target => resolveBranch(() => {
        if (target.spec.startsWith("./")) return this.resolvePackageTarget(owner, target, new Set());
        if (target.spec === "." || target.spec === ".." || target.spec.startsWith("../") || rootedPath(target.spec)) {
          return [{ violation: target.spec }];
        }
        return this.resolveImport(target.spec, from, target.use, seen);
      }));
      if (use === "runtime" && !match.targets.some(target => target.use === "runtime")) results.push({ violation: spec });
      return results;
    }
    if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
      return this.resolvePath(path.resolve(path.dirname(from), spec), spec, use, seenSpecs.size ? "module" : "relative");
    }
    if (spec.startsWith("@aistudy/")) return this.resolvePackage(spec, use);
    return [{ violation: spec }];
  }

  label(file: string): string {
    const relative = path.relative(this.root, normalizeFile(file));
    return slash(relative || path.basename(file));
  }

  candidateFiles(required: readonly string[], optional: readonly string[]): string[] {
    return [...required, ...optional].flatMap(name => {
      const file = path.join(this.root, name);
      try {
        const entry = this.diskEntry(file);
        if (!entry && !required.includes(name)) return [];
        if (entry?.stats.isFile()) {
          accessSync(entry.physical, constants.R_OK);
          return [file];
        }
      } catch (error) {
        if (!(error instanceof BlockedPath || (error instanceof Error && "code" in error))) throw error;
      }
      return expect.fail(`Public candidate ${name} must be a readable file`);
    });
  }

  candidateTargets({ source, spec, optional }: PublicCandidate): Resolution[] {
    const files = this.candidateFiles(optional ? [] : [source], optional ? [source] : []);
    const [, packageName, ...subpath] = spec.split("/");
    const owner = path.join(this.root, "packages", packageName);
    const published = resolveBranch(() => {
      if (!files.length) {
        const manifest = this.loadManifest(owner);
        if (!manifest || (subpath.length && !this.exportTargets(manifest.exports, "./" + subpath.join("/"), "runtime").length)) return [];
      }
      const targets = this.resolvePackage(spec, "runtime", owner);
      if (!files.length) targets.push({ violation: source });
      return targets;
    });
    return [...files.map((file): Resolution => ({ file, use: "runtime" })), ...published];
  }
}

export function analyzeModuleGraph(entries: readonly string[], options: GraphOptions): { violations: BoundaryViolation[] } {
  return scanEntries(new ModuleGraph(options), entries, options.requirePermissiveCandidateLicense);
}

function scanEntries(graph: ModuleGraph, entries: readonly string[], checkLicense = false) {
  const violations: BoundaryViolation[] = [];
  for (const rawEntry of entries) {
    const entry = normalizeFile(rawEntry);
    const entryLabel = graph.label(entry);
    const stack = [{ file: entry, chain: [entryLabel] }];
    const visited = new Set([entry]);
    const reportedLicenses = new Set<string>();
    while (stack.length) {
      const current = stack.pop()!;
      let module: ReturnType<ModuleGraph["readSource"]>;
      try {
        module = graph.readSource(current.file, checkLicense);
        if (!module) throw new BlockedPath(graph.label(current.file));
      } catch (error) {
        if (!(error instanceof BlockedPath)) throw error;
        violations.push({ entry: entryLabel, target: error.message, chain: current.chain });
        continue;
      }
      const { source, text, license } = module;
      if (license && !reportedLicenses.has(license)) {
        reportedLicenses.add(license);
        violations.push({ entry: entryLabel, target: license, chain: [...current.chain, license] });
      }
      for (const edge of parseEdges(source, text)) {
        const kind = edge.kind === "runtime" ? "" : ` [${edge.kind}]`;
        const hop = `${graph.label(current.file)}:${edge.line} -> ${edge.spec}${kind}`;
        for (const target of graph.resolveEdge(edge, source, current.file)) {
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

function scanPublicCandidates(graph: ModuleGraph, candidates: PublicCandidate[]) {
  const violations: BoundaryViolation[] = [];
  for (const candidate of candidates) {
    const files = new Set<string>();
    const invalid = new Set<string>();
    for (const target of graph.candidateTargets(candidate)) {
      if ("file" in target) files.add(target.file);
      else invalid.add(target.violation);
    }
    const entry = candidate.spec;
    for (const target of invalid) violations.push({ entry, target, chain: [entry, target] });
    for (const leak of scanEntries(graph, [...files]).violations) {
      violations.push({ entry, target: leak.target, chain: [entry, ...leak.chain] });
    }
  }
  return { violations };
}

function withLinkedEntry(run: (fixture: { root: string; entry: string; source: string; sibling: string }) => void) {
  const temp = mkdtempSync(path.join(tmpdir(), "aistudy-linked-entry-"));
  try {
    const root = path.join(temp, "repo");
    const portable = path.join(root, "portable");
    const alias = path.join(root, "alias");
    for (const dir of [portable, alias]) mkdirSync(dir, { recursive: true });
    let entry = path.join(alias, "entry.d.ts");
    let source = path.join(portable, "entry.d.ts");
    let sibling = "./";
    writeFileSync(source, "", "utf8");
    try {
      symlinkSync(source, entry, "file");
    } catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      // Directory junctions also exercise distinct parent lookups on restricted Windows hosts.
      mkdirSync(path.join(portable, "linked"));
      symlinkSync(path.join(portable, "linked"), path.join(alias, "linked"), "junction");
      entry = path.join(alias, "linked/entry.d.ts");
      source = path.join(portable, "linked/entry.d.ts");
      sibling = "../";
    }
    run({ root, entry, source, sibling });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

describe("v3 Open-Core public candidate boundary", () => {
  it("keeps every real public candidate free of closed-core and server-only transitive targets", () => {
    const root = path.resolve(__dirname, "../..");
    const candidates: Record<RuntimeProfile, PublicCandidate[]> = {
      "browser-ui": [
        { spec: "@aistudy/jingwei", source: "packages/jingwei/src/index.ts" },
        { spec: "@aistudy/jingwei/react", source: "packages/jingwei/src/react/index.ts" },
        { spec: "@aistudy/ui", source: "packages/ui/src/index.ts" },
      ],
      "portable-runtime": [
        { spec: "@aistudy/domain/native", source: "packages/domain/src/portability/native/index.ts" },
        { spec: "@aistudy/contracts", source: "packages/contracts/src/index.ts" },
        { spec: "@aistudy/contracts/learner-portability", source: "packages/contracts/src/learner-portability/index.ts", optional: true },
        { spec: "@aistudy/contracts/cartridge-lite", source: "packages/contracts/src/cartridge-lite/index.ts", optional: true },
        { spec: "@aistudy/domain/cartridge-sdk-lite", source: "packages/domain/src/cartridge-sdk-lite/index.ts", optional: true },
        { spec: "@aistudy/domain/opening/cartridge-spi", source: "packages/domain/src/opening/cartridge-spi.ts", optional: true },
        { spec: "@aistudy/cartridge-sdk-lite", source: "packages/cartridge-sdk-lite/src/index.ts", optional: true },
      ],
    };
    for (const profile of ["browser-ui", "portable-runtime"] as const) {
      const graph = new ModuleGraph({ root, profile });
      const { violations } = scanPublicCandidates(graph, candidates[profile]);
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

  it("checks the published react subpath and root entries alongside their candidate sources", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aistudy-public-export-"));
    try {
      const owner = path.join(root, "packages/jingwei");
      mkdirSync(path.join(owner, "src/react"), { recursive: true });
      const react = { spec: "@aistudy/jingwei/react", source: "packages/jingwei/src/react/index.ts" };
      const index = { spec: "@aistudy/jingwei", source: "packages/jingwei/src/index.ts" };
      for (const name of [react.source, index.source]) writeFileSync(path.join(root, name), "", "utf8");
      writeFileSync(path.join(owner, "actual.cjs"), 'require("pg");', "utf8");
      writeFileSync(path.join(owner, "actual.d.cts"), 'import "jose";', "utf8");
      writeFileSync(path.join(owner, "legacy.js"), 'import "server-only";', "utf8");
      writeFileSync(path.join(owner, "index.js"), 'import "postgres";', "utf8");
      const save = (exports: unknown) => writeFileSync(path.join(owner, "package.json"),
        JSON.stringify({ name: index.spec, exports, main: "./legacy.js" }), "utf8");
      const check = (candidate: PublicCandidate) => scanPublicCandidates(new ModuleGraph({ root }), [candidate]).violations;
      save({ ".": "./src/index.ts", "./react": { types: "./src/react/index.ts", default: "./actual.cjs", browser: "./missing.js" } });
      const leaks = check(react);
      expect(leaks.map(v => v.target).sort()).toEqual(["./missing.js", "jose", "pg"]);
      expect(leaks.every(v => v.entry === react.spec && v.chain[0] === react.spec)).toBe(true);
      expect(check(index).map(v => v.target)).toEqual(["server-only"]);
      save({ ".": "./src/index.ts" });
      expect(check({ ...react, optional: true }).map(v => v.target)).toEqual([react.spec]);
      save({ "./react": "invalid-bare-target" });
      expect(check(react).map(v => v.target)).toEqual(["invalid-bare-target"]);
      save({ "./react": { default: "./src/react/index.ts", browser: 12 } });
      expect(check(react).map(v => v.target)).toEqual(["<invalid-package-target>"]);
      save({ "./react": "./actual.cjs" });
      rmSync(path.join(root, react.source));
      expect(check({ ...react, optional: true }).map(v => v.target).sort()).toEqual(["jose", react.source, "pg"].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    for (const [i, v] of violations.entries()) expect(v.chain).toContain(`index.d.ts:${i + 1} -> ${names[i]} [types-directive]`);
  });

  it.each(["browser-ui", "portable-runtime"] as const)("resolves ambient packages independently of runtime allowlists in %s", profile => {
    const entry = "public.d.ts";
    const files = { [entry]: '/// <reference types="react" />' };
    expect(virtualAnalyze(files, entry, undefined, profile).violations.map(v => v.target)).toEqual(["react"]);
    const result = virtualAnalyze({
      ...files,
      "node_modules/@types/react/package.json": JSON.stringify({ exports: { ".": { types: "./ambient.d.mts" } } }),
      "node_modules/@types/react/ambient.d.mts": '/// <reference types="node" />',
      "node_modules/@types/node/index.d.ts": "export {};",
    }, entry, undefined, profile);
    expect(result.violations.map(v => v.target)).toEqual(["node"]);
    expect(result.violations[0].chain).toContain("node_modules/@types/react/ambient.d.mts");
  });

  it.each(["types", "typings"])("requires an actual declaration at the ambient %s target", field => {
    const files = {
      "index.d.ts": '/// <reference types="@demo/view" />',
      "node_modules/@types/demo__view/package.json": JSON.stringify({ [field]: "./public.d.cts" }),
      "node_modules/@types/demo__view/index.d.ts": "export {};",
    };
    expect(virtualAnalyze({ ...files, "node_modules/@types/demo__view/public.d.cts": "export {};" }, "index.d.ts").violations).toEqual([]);
    expect(virtualAnalyze(files, "index.d.ts").violations).toHaveLength(1);
  });

  it("checks ambient index declarations and rejects prohibited names or traversal even if a file exists", () => {
    const names = ["local", "pg", "../internal", "node:buffer"];
    const result = virtualAnalyze({
      "index.d.ts": names.map(name => `/// <reference types="${name}" />`).join("\n"),
      "node_modules/@types/local/index.d.ts": 'export type T = import("./epistemic/internal").T;',
      "node_modules/@types/local/epistemic/internal.d.ts": "export type T = string;",
      "node_modules/@types/pg/index.d.ts": "export {};",
      "node_modules/internal/index.d.ts": "export {};",
    }, "index.d.ts", undefined, "portable-runtime");
    expect(result.violations.map(v => v.target).sort()).toEqual([
      "../internal", "node:buffer", "node_modules/@types/local/epistemic/internal.d.ts", "pg",
    ]);
  });

  it("checks the CJS directory index even with exports, main and an available declaration", () => {
    const result = virtualAnalyze({
      "index.ts": 'require("./helper");',
      "helper/package.json": JSON.stringify({ exports: "./public.js", main: "./runtime.cjs" }),
      "helper/public.js": "export {};",
      "helper/runtime.d.cts": "export {};",
      "helper/index.js": 'require("pg");',
    }, "index.ts");
    expect(result.violations.map(v => v.target).sort()).toEqual(["./runtime.cjs", "pg"]);
  });

  describe.each([
    { spec: "react", owner: "node_modules/@types/react", edge: '/// <reference types="react" />' },
    { spec: "@aistudy/lite", owner: "lite", edge: 'export type * from "@aistudy/lite";' },
  ])("typesVersions for $spec", ({ spec, owner, edge }) => {
    function check(typesVersions: unknown, files: Record<string, string> = {}, manifest = {}) {
      return virtualAnalyze({
        "public.d.ts": edge,
        [owner + "/package.json"]: JSON.stringify({ name: spec, types: "./index.d.ts", typesVersions, ...manifest }),
        [owner + "/index.d.ts"]: "export {};",
        ...Object.fromEntries(Object.entries(files).map(([name, source]) => [owner + "/" + name, source])),
      }, "public.d.ts").violations;
    }

    it("unions the unversioned entry with every matching selector, pattern and replacement", () => {
      const results = check({
        "*": { "*": ["v5/*", "compat"], index: ["exact.d.mts"] },
        ">=99": { "index.d.ts": ["future.d.cts"] },
      }, {
        "index.d.ts": 'import "pg";', "v5/index.d.ts": 'import "postgres";',
        "compat/index.d.cts": 'import "server-only";', "exact.d.mts": 'import "jose";',
        "future.d.cts": '/// <reference types="node" />',
      });
      expect(results.map(v => v.target).sort()).toEqual(["jose", "node", "pg", "postgres", "server-only"]);
    });

    it("accepts a clean versioned declaration and ignores unrelated patterns", () => {
      expect(check({ "*": { "*": ["v5/*"], other: ["unrelated"] } }, { "v5/index.d.ts": "" })).toEqual([]);
    });

    it("requires a versioned replacement for each distinct unversioned declaration", () => {
      const files = { "v5/index.d.ts": "", "second.d.mts": "" };
      const manifest = { typings: "./second.d.mts", exports: { ".": { types: "./index.d.ts" } } };
      expect(check({ "*": { "*": ["v5/*"] } }, files, manifest)).toMatchObject([{ target: spec }]);
      expect(check({ "*": { "*": ["v5/*"] } }, { ...files, "v5/second.d.mts": 'import "pg";' }, manifest))
        .toMatchObject([{ target: "pg" }]);
    });

    it.each([
      ["absent", {}], ["../shared", { "../shared.d.ts": "" }], ["/outside", {}],
      ["v5/runtime.cjs", { "v5/runtime.cjs": "" }],
    ] as const)("rejects the configured replacement %s even alongside a valid replacement", (target, files) => {
      expect(check({ "*": { "*": ["./index.d.ts", target] } }, files)).toMatchObject([{ target: spec }]);
    });

    it.each([null, [], "invalid", { "*": null }, { "*": [] }, { "*": { other: [] } }, { "*": { other: [0] } }])(
      "rejects malformed selector maps and target lists (%j)", value => {
        expect(check(value)).toMatchObject([{ target: spec }]);
      },
    );
  });

  it("maps both a workspace subpath and its declaration export without scanning unrelated subpaths", () => {
    const violations = virtualAnalyze({
      "index.ts": 'import "@aistudy/lite/rules";',
      "lite/package.json": JSON.stringify({
        name: "@aistudy/lite", exports: { "./*": { types: "./decl/*.d.mts", default: "./*.js" } },
        typesVersions: { ">=5": { "rules": ["old/rules"], "decl/*.d.mts": ["modern/*"], other: ["unused"] } },
      }),
      "lite/rules.js": "", "lite/decl/rules.d.mts": 'import "jose";',
      "lite/old/rules/index.d.mts": 'import "pg";', "lite/modern/rules.d.ts": 'import "postgres";',
    }, "index.ts").violations;
    expect(violations.map(v => v.target).sort()).toEqual(["jose", "pg", "postgres"]);
  });

  it("walks versioned declarations inside a relative directory alongside same-named sibling files", () => {
    const files = {
      "public.d.ts": 'export type * from "./lite";',
      "lite.d.ts": 'import "jose";', "lite/index.d.ts": "",
      "lite/package.json": JSON.stringify({ typesVersions: { ">=4.8": { "*": ["v5/*"] } } }),
    };
    const run = (extra: Record<string, string>) =>
      virtualAnalyze({ ...files, ...extra }, "public.d.ts").violations.map(v => v.target).sort();
    expect(run({ "lite/v5/index.d.ts": 'import "pg";' })).toEqual(["jose", "pg"]);
    expect(run({})).toEqual(["./lite", "jose"]);
  });

  it("keeps a missing unversioned directory entry visible while walking the mapped declaration", () => {
    const { violations } = virtualAnalyze({
      "public.d.ts": 'export type * from "./lite";',
      "lite/package.json": JSON.stringify({ typesVersions: { "4.x": { index: ["v4/index.d.ts"] } } }),
      "lite/v4/index.d.ts": 'import "pg";',
    }, "public.d.ts");
    expect(violations.map(v => v.target).sort()).toEqual(["./lite", "pg"]);
  });

  it.each([
    { main: "./dist/entry.js" }, { module: "./dist/entry.js" },
    { browser: "./dist/entry.js" }, { browser: { "./server.js": "./dist/entry.js", unused: false } },
  ])("keeps each legacy runtime specifier for exact version mappings (%j)", fields => {
    const violations = virtualAnalyze({
      "public.ts": 'import "@aistudy/lite";',
      "lite/package.json": JSON.stringify({
        name: "@aistudy/lite", ...fields, typesVersions: { "*": {
          "dist/entry.js": ["./v5/runtime.d.ts"], "dist/entry.d.ts": ["./v5/types.d.ts"], "dist/entry": ["./v5/stem.d.ts"],
        } },
      }),
      "lite/dist/entry.js": "", "lite/dist/entry.d.ts": "",
      "lite/v5/runtime.d.ts": 'import "pg";', "lite/v5/types.d.ts": 'import "jose";', "lite/v5/stem.d.ts": 'import "postgres";',
    }, "public.ts").violations;
    expect(violations.map(v => v.target).sort()).toEqual(["jose", "pg", "postgres"]);
  });

  it("validates compiler-version selectors even when their path patterns do not match", () => {
    const check = (selector: string) => virtualAnalyze({
      "public.d.ts": '/// <reference types="local" />',
      "node_modules/@types/local/package.json": JSON.stringify({ typesVersions: { [selector]: { unused: ["unused.d.ts"] } } }),
      "node_modules/@types/local/index.d.ts": "",
    }, "public.d.ts").violations.map(v => v.target);
    for (const selector of ["*", "", "   ", "||", ">=4.5", "<5.0.0-0", ">=4.8 <5.2", "^5.0.0", "~4.9", "4.x", "5.0.0", "4 - 5 || >=6"]) {
      expect(check(selector), selector).toEqual([]);
    }
    for (const selector of ["not-a-version", ">=4.8 garbage", "5.0.0-alpha..1"]) {
      expect(check(selector), selector).toEqual(["local"]);
    }
  });

  it.each(["./lite", "@aistudy/lite"])("queries the default index alongside module for %s", spec => {
    const result = virtualAnalyze({
      "entry.ts": `import "${spec}";`,
      "lite/package.json": JSON.stringify({ name: "@aistudy/lite", module: "./alternate.mjs", typesVersions: {
        "*": { index: ["compat.d.ts"], "alternate.mjs": ["alternate-version.d.mts"] },
      } }),
      "lite/index.js": "", "lite/alternate.mjs": "", "lite/compat.d.ts": 'import "pg";',
      "lite/alternate-version.d.mts": 'import "jose";',
    }, "entry.ts");
    expect(result.violations.map(v => v.target).sort()).toEqual(["jose", "pg"]);
  });

  it("walks an exported workspace root's legacy main declaration and compiler-accepted open-ended selector", () => {
    const result = virtualAnalyze({
      "entry.ts": 'import "@aistudy/lite";',
      "lite/package.json": JSON.stringify({ name: "@aistudy/lite", exports: "./public.js", main: "./legacy.cjs",
        typesVersions: { ">=5||": { "legacy.cjs": ["./v5.d.ts"] } } }),
      "lite/public.js": "", "lite/legacy.cjs": "", "lite/legacy.d.cts": 'import "pg";', "lite/v5.d.ts": 'import "jose";',
    }, "entry.ts");
    expect(result.violations.map(v => v.target).sort()).toEqual(["jose", "pg"]);
  });

  it.each([
    ["module.require('pg')", "pg"], ["module['require']('jose')", "jose"],
    ["module.require(name)", "<dynamic-non-literal>"], ["module['require']()", "<dynamic-non-literal>"],
  ])("follows a CommonJS loader call in a reachable module: %s", (code, target) => {
    const result = virtualAnalyze({ "index.ts": 'import "./helper.cjs";', "helper.cjs": code }, "index.ts");
    expect(result.violations.map(v => v.target)).toEqual([target]);
    expect(result.violations[0].chain).toContain(`helper.cjs:1 -> ${target} [require]`);
  });

  it("does not satisfy a version mapping to the package directory with a sibling declaration", () => {
    const spec = "@aistudy/lite/sub";
    const result = virtualAnalyze({
      "entry.d.ts": `export type * from "${spec}";`,
      "lite/package.json": JSON.stringify({ name: "@aistudy/lite", typesVersions: { "*": { sub: ["."] } } }),
      "lite/sub.d.ts": "", "lite.d.ts": "",
    }, "entry.d.ts");
    expect(result.violations.map(v => v.target)).toEqual([spec]);
  });

  it("treats browser replacements as runtime entries even for a package named types", () => {
    const result = virtualAnalyze({
      "index.ts": 'import "./helper";',
      "helper/package.json": JSON.stringify({ browser: { types: "./shim.js" } }),
      "helper/index.js": "export {};",
      "helper/shim.d.ts": "export {};",
    }, "index.ts");
    expect(result.violations.map(v => v.target)).toEqual(["./shim.js"]);
  });

  it("checks declarations inferred from ambient export conditions alongside explicit types", () => {
    const result = virtualAnalyze({
      "index.d.ts": '/// <reference types="react" />',
      "node_modules/@types/react/package.json": JSON.stringify({ exports: {
        import: { types: "./public.d.ts" }, require: "./common.cjs",
      } }),
      "node_modules/@types/react/public.d.ts": "export {};",
      "node_modules/@types/react/common.d.cts": '/// <reference types="node" />',
    }, "index.d.ts");
    expect(result.violations.map(v => v.target)).toEqual(["node"]);
  });

  it.each([
    ['import "./impl.js"', "./impl.js", "impl.d.ts"],
    ['require("./impl.cjs")', "./impl.cjs", "impl.d.cts"],
    ['import("./impl.mjs")', "./impl.mjs", "impl.d.mts"],
    ['export * from "./impl"', "./impl", "impl.d.ts"],
  ])("requires an implementation for %s", (code, spec, declaration) => {
    const files = { "index.ts": code, [declaration]: "export {};" };
    expect(virtualAnalyze(files, "index.ts").violations.map(v => v.target)).toEqual([spec]);
    files["index.ts"] = `import type { T } from "${spec}";`;
    expect(virtualAnalyze(files, "index.ts").violations).toEqual([]);
  });

  it("keeps nested type conditions distinct from runtime exports, even at the same target", () => {
    const files = {
      "index.ts": 'import "@aistudy/lite";',
      "lite/package.json": JSON.stringify({ name: "@aistudy/lite", exports: { ".": {
        import: { types: "./rules.mjs", default: "./rules.mjs" },
      } } }),
      "lite/rules.d.mts": 'export type T = import("pg").T;',
    };
    expect(virtualAnalyze(files, "index.ts").violations.map(v => v.target).sort()).toEqual(["./rules.mjs", "pg"]);
    expect(virtualAnalyze({ ...files, "lite/rules.mts": "export {};" }, "index.ts").violations.map(v => v.target)).toEqual(["pg"]);
  });

  it("checks paired declarations even for an explicit source import", () => {
    const result = virtualAnalyze({
      "index.ts": 'import "./module.cts";',
      "module.cts": "export {};",
      "module.d.cts": 'export type T = import("pg").T;',
    }, "index.ts");
    expect(result.violations.map(v => v.target)).toEqual(["pg"]);
  });

  it("checks a junction's physical boundary and both package owners before accepting an export", () => {
    const temp = mkdtempSync(path.join(tmpdir(), "aistudy-boundary-"));
    try {
      const root = path.join(temp, "repo");
      const entry = path.join(root, "index.ts");
      const closed = path.join(root, "packages/domain/src/epistemic");
      const privateOwner = path.join(root, "internal");
      const portable = path.join(root, "portable");
      const external = path.join(temp, "external");
      for (const dir of [external, closed, path.join(privateOwner, "lib"), portable]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "entry.ts"), "export {};", "utf8");
      }
      writeFileSync(path.join(root, "package.json"), '{"license":"Apache-2.0"}', "utf8");
      writeFileSync(path.join(privateOwner, "package.json"), '{"license":"UNLICENSED"}', "utf8");
      const check = (dir: string, license = false) => {
        writeFileSync(entry, `import "./${dir}/entry.ts";`, "utf8");
        return analyzeModuleGraph([entry], { root, requirePermissiveCandidateLicense: license }).violations.map(v => v.target);
      };
      symlinkSync(portable, path.join(root, "portable-link"), "junction");
      symlinkSync(external, path.join(root, "external-link"), "junction");
      symlinkSync(closed, path.join(root, "closed-link"), "junction");
      symlinkSync(path.join(privateOwner, "lib"), path.join(root, "owner-link"), "junction");
      symlinkSync(portable, path.join(privateOwner, "portable-link"), "junction");
      symlinkSync(portable, path.join(root, "exam-forecast"), "junction");
      expect(check("portable-link", true)).toEqual([]);
      expect(check("external-link")).toHaveLength(1);
      expect(check("closed-link")).toEqual(["packages/domain/src/epistemic/entry.ts"]);
      expect(check("owner-link", true)).toEqual(["internal/package.json"]);
      expect(check("internal/portable-link", true)).toEqual(["internal/package.json"]);
      expect(check("exam-forecast")).toEqual(["exam-forecast/entry.ts"]);
      writeFileSync(path.join(privateOwner, "lib/package.json"), '{"main":"../parent.cjs"}', "utf8");
      writeFileSync(path.join(privateOwner, "parent.cjs"), 'require("pg");', "utf8");
      writeFileSync(path.join(root, "parent.cjs"), "module.exports = {};", "utf8");
      writeFileSync(entry, 'require("./owner-link");', "utf8");
      expect(analyzeModuleGraph([entry], { root }).violations.map(v => v.target)).toEqual(["pg"]);
      // A blocked manifest must never reach the JSON parser.
      writeFileSync(path.join(external, "package.json"), "invalid JSON", "utf8");
      writeFileSync(entry, 'require("./external-link");', "utf8");
      expect(analyzeModuleGraph([entry], { root }).violations).toHaveLength(1);
      rmSync(external, { recursive: true });
      expect(analyzeModuleGraph([entry], { root }).violations).toHaveLength(1);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it.each(["path", "import", "imports alias", "ambient types"])("checks both origins of a linked %s edge", kind => {
    withLinkedEntry(({ root, entry, source, sibling }) => {
      const edges: Record<string, string> = {
        path: `/// <reference path="${sibling}helper.d.ts" />`, import: `import "${sibling}helper";`,
        "imports alias": 'import "#helper";', "ambient types": '/// <reference types="local" />',
      };
      writeFileSync(source, edges[kind], "utf8");
      const closed = path.join(root, "epistemic");
      mkdirSync(closed);
      writeFileSync(path.join(closed, "private.d.ts"), "", "utf8");
      for (const leaking of ["alias", "portable"]) {
        for (const name of ["alias", "portable"]) {
          const dir = path.join(root, name);
          writeFileSync(path.join(dir, "package.json"), '{"imports":{"#helper":"./helper.d.ts"}}', "utf8");
          const helper = kind === "ambient types" ? path.join(dir, "node_modules/@types/local/index.d.ts") : path.join(dir, "helper.d.ts");
          mkdirSync(path.dirname(helper), { recursive: true });
          const ref = slash(path.relative(path.dirname(helper), path.join(closed, "private.d.ts")));
          writeFileSync(helper, name === leaking ? `/// <reference path="${ref}" />` : "", "utf8");
        }
        const { violations } = analyzeModuleGraph([entry], { root });
        expect(violations.map(v => v.target)).toEqual(["epistemic/private.d.ts"]);
        const helper = kind === "ambient types" ? "node_modules/@types/local/index.d.ts" : "helper.d.ts";
        expect(violations[0].chain).toContain(`${leaking}/${helper}`);
      }
    });
  });

  it("keeps a physical-only sibling but reports a broken, escaping or misconfigured lexical sibling", () => {
    withLinkedEntry(({ root, entry, source, sibling }) => {
      writeFileSync(source, `import "${sibling}helper";`, "utf8");
      writeFileSync(path.join(root, "portable/helper.d.ts"), "", "utf8");
      const check = () => analyzeModuleGraph([entry], { root }).violations.map(v => v.target);
      expect(check()).toEqual([]);
      const external = path.join(path.dirname(root), "external");
      const link = path.join(root, "alias/helper");
      mkdirSync(external);
      symlinkSync(external, link, "junction");
      expect(check()).toEqual(["alias/helper"]);
      rmSync(external, { recursive: true });
      expect(check()).toEqual(["alias/helper"]);
      rmSync(link);
      mkdirSync(link);
      writeFileSync(path.join(link, "package.json"), '{"types":"./missing.d.ts"}', "utf8");
      expect(check()).toEqual(["./missing.d.ts"]);
      writeFileSync(path.join(link, "package.json"), "invalid", "utf8");
      expect(check()).toEqual(["alias/helper/package.json"]);
    });
  });

  it("accepts a one-sided imports map across a junction and preserves failures in configured targets", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aistudy-linked-imports-"));
    try {
      const portable = path.join(root, "portable");
      const lexical = path.join(root, "view");
      mkdirSync(path.join(portable, "src"), { recursive: true });
      mkdirSync(lexical);
      symlinkSync(path.join(portable, "src"), path.join(lexical, "src"), "junction");
      writeFileSync(path.join(portable, "src/entry.ts"), 'import "#helper";', "utf8");
      const map = (dir: string, imports: unknown) =>
        writeFileSync(path.join(dir, "package.json"), JSON.stringify({ imports }), "utf8");
      const check = () => analyzeModuleGraph([path.join(lexical, "src/entry.ts")], { root }).violations.map(v => v.target);
      map(portable, { "#helper": "./safe.ts" });
      writeFileSync(path.join(portable, "safe.ts"), "", "utf8");
      expect(check()).toEqual([]);
      map(lexical, { "#other": "./missing.ts" });
      expect(check()).toEqual([]);
      for (const [mapping, target] of [
        [null, "#helper"], ["#unmapped", "#unmapped"], ["./missing", "./missing"],
        ["pg", "pg"], ["./../../outside", "./../../outside"],
      ]) {
        map(lexical, { "#helper": mapping });
        expect(check()).toEqual([target]);
      }
      map(lexical, null);
      expect(check()).toEqual(["#helper"]);
      map(lexical, { "#helper": "./safe.ts" });
      map(portable, {});
      writeFileSync(path.join(lexical, "safe.ts"), 'import "jose";', "utf8");
      expect(check()).toEqual(["jose"]);
      map(lexical, {});
      expect(check()).toEqual(["#helper"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a package-relative imports escape even if the other link origin has no mapping", () => {
    withLinkedEntry(({ root, source, entry }) => {
      const target = "./../shared.js";
      writeFileSync(source, 'import "#helper";', "utf8");
      writeFileSync(path.join(root, "shared.js"), "", "utf8");
      writeFileSync(path.join(root, "alias/package.json"), JSON.stringify({ imports: { "#helper": target } }), "utf8");
      expect(analyzeModuleGraph([entry], { root }).violations.map(v => v.target)).toContain(target);
    });
  });

  it.each(["imports", "exports"])("enforces the lexical and physical package owner for %s", field => {
    const root = mkdtempSync(path.join(tmpdir(), "aistudy-mapped-owner-"));
    try {
      const owner = path.join(root, "packages/lite");
      const other = path.join(root, "packages/other");
      for (const dir of [owner, other]) mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(other, "public.js"), "", "utf8");
      symlinkSync(other, path.join(owner, "linked"), "junction");
      const entry = path.join(owner, "entry.ts");
      writeFileSync(entry, field === "imports" ? 'import "#helper";' : 'import "@aistudy/lite/feature";', "utf8");
      const check = (target: string) => {
        const map = field === "imports" ? { "#helper": target } : { "./feature": target };
        writeFileSync(path.join(owner, "package.json"), JSON.stringify({ name: "@aistudy/lite", [field]: map }), "utf8");
        return analyzeModuleGraph([entry], { root }).violations.map(v => v.target);
      };
      for (const target of ["./../other/public.js", "../other/public.js", "./linked/public.js"]) {
        expect(check(target), target).toEqual([target]);
      }
      writeFileSync(path.join(owner, "entry.d.ts"), "", "utf8");
      expect(check("./entry.ts")).toEqual([]);
      if (field === "imports") {
        writeFileSync(path.join(other, "package.json"), '{"name":"@aistudy/other","exports":"./public.js"}', "utf8");
        expect(check("@aistudy/other")).toEqual([]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips absent optional candidates and reports unreadable entries by repository-relative name", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aistudy-candidate-"));
    try {
      writeFileSync(path.join(root, "entry.ts"), "", "utf8");
      mkdirSync(path.join(root, "directory"));
      const loop = path.join(root, "loop");
      symlinkSync(loop, loop, "junction");
      symlinkSync(path.join(root, "missing"), path.join(root, "broken"), "junction");
      const graph = new ModuleGraph({ root });
      const absent = ["missing", "entry.ts/child.ts"];
      expect(graph.candidateFiles(["entry.ts"], absent)).toEqual([path.join(root, "entry.ts")]);
      for (const name of [...absent, "directory", "loop", "loop/entry.ts", "broken"]) {
        expect(() => graph.candidateFiles([name], [])).toThrowError(expect.objectContaining({
          name: "AssertionError", message: `Public candidate ${name} must be a readable file`,
        }));
      }
      for (const name of ["directory", "loop/entry.ts", "broken"]) {
        expect(() => graph.candidateFiles([], [name])).toThrowError(expect.objectContaining({
          name: "AssertionError", message: `Public candidate ${name} must be a readable file`,
        }));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("imports a disk file directly and through a junction, and reports a subpath beneath the file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aistudy-file-probe-"));
    try {
      const main = path.join(root, "main.ts");
      const dir = path.join(root, "portable");
      mkdirSync(dir);
      writeFileSync(path.join(dir, "entry.ts"), 'import "zod";', "utf8");
      symlinkSync(dir, path.join(root, "alias"), "junction");
      for (const name of ["portable", "alias"]) {
        const file = `./${name}/entry.ts`;
        writeFileSync(main, `import "${file}";\nimport "${file}/nested";`, "utf8");
        const { violations } = analyzeModuleGraph([main], { root });
        expect(violations.map(v => v.target)).toEqual([file + "/nested"]);
        expect(violations[0].chain).toContain(`main.ts:2 -> ${file}/nested`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports OS link loops and recursive module lookups through the same directory junction", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aistudy-link-cycle-"));
    try {
      const dir = path.join(root, "portable");
      mkdirSync(dir);
      const loop = path.join(dir, "loop");
      symlinkSync(loop, loop, "junction");
      symlinkSync(dir, path.join(dir, "again"), "junction");
      writeFileSync(path.join(dir, "entry.ts"), 'import "./loop/missing";\nimport "./again/entry";', "utf8");
      const cycle = analyzeModuleGraph([path.join(dir, "entry.ts")], { root });
      const targets = new Set(cycle.violations.map(v => v.target));
      expect(targets).toEqual(new Set(["portable/loop", "portable/again/loop", "portable/again/again"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires a versioned declaration's physical target to stay inside the package", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aistudy-versioned-owner-"));
    try {
      const owner = path.join(root, "node_modules/@types/local");
      const sibling = path.join(root, "other");
      for (const dir of [owner, sibling]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "index.d.ts"), "", "utf8");
      }
      writeFileSync(path.join(owner, "package.json"), '{"typesVersions":{"*":{"*":["v5/*"]}}}', "utf8");
      symlinkSync(sibling, path.join(owner, "v5"), "junction");
      const entry = path.join(root, "entry.d.ts");
      writeFileSync(entry, '/// <reference types="local" />', "utf8");
      expect(analyzeModuleGraph([entry], { root }).violations.map(v => v.target)).toEqual(["local"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      "index.ts": 'const id = <T>(v: T) => v;\nexport * from ".\\\\lib\\\\esm.mjs";\nimport type { T } from "./ambient";',
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
