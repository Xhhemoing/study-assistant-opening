import { isBuiltin } from "node:module";
import { posix } from "node:path";
import ts from "typescript";
import { readModuleEdges, type ResolutionMode } from "./module-edges.ts";
import { declarationCompanion, GitSnapshot, isDeclaration, isPublicFile, isRecord, isSafeGitPath, sourceExtension, sourceOwner } from "./snapshot.ts";

type Profile = "browser-ui" | "portable-runtime";
type Target = { path: string; typeOnly: boolean };
type PackageMatch = { value: unknown; capture?: string };
type Selection = { file: string; route: Array<string | number> };
type SelectedTargets = { types?: string; runtime?: Selection };
type PackageTarget = { bundler: SelectedTargets; node: SelectedTargets };
type PackageProjection = { original: unknown; modes: Partial<Record<ResolutionMode, PackageTarget>> };
type Json = Record<string, unknown>;

const publicEntries = [
  ["@aistudy/jingwei", "packages/jingwei", ".", "src/index.ts", "browser-ui"],
  ["@aistudy/jingwei/react", "packages/jingwei", "./react", "src/react/index.ts", "browser-ui"],
  ["@aistudy/ui", "packages/ui", ".", "src/index.ts", "browser-ui"],
  ["@aistudy/domain/native", "packages/domain", "./native", "src/portability/native/index.ts", "portable-runtime"],
  ["@aistudy/domain/cartridge-sdk-lite", "packages/domain", "./cartridge-sdk-lite", "src/cartridge-sdk-lite/index.ts", "portable-runtime"],
  ["@aistudy/contracts", "packages/contracts", ".", "src/community.ts", "portable-runtime", "./community"],
  ["@aistudy/contracts/learner-portability", "packages/contracts", "./learner-portability", "src/learner-portability/index.ts", "portable-runtime"],
  ["@aistudy/contracts/cartridge-lite", "packages/contracts", "./cartridge-lite", "src/cartridge-lite/index.ts", "portable-runtime"],
] as const;

const entries = new Map<string, (typeof publicEntries)[number]>(publicEntries.map(entry => [entry[0], entry]));
const portable = new Set(["zod", "ts-fsrs"]);
const browser = new Set([...portable, "react", "react/jsx-runtime", "react-dom", "lucide-react",
  "@radix-ui/react-dialog", "@radix-ui/react-tabs", "@radix-ui/react-toast"]);
const declarations = [".d.ts", ".d.mts", ".d.cts"];
const extensionlessSources = [".ts", ".tsx", ".d.ts", ".js", ".jsx"];
const opaqueExtensions = [".json", ".node", ".wasm"];
const substitutes: Record<string, string[]> = {
  ".js": [".ts", ".tsx", ".d.ts"], ".jsx": [".tsx", ".ts", ".d.ts"], ".mjs": [".mts", ".d.mts"], ".cjs": [".cts", ".d.cts"],
  ".ts": [".d.ts"], ".tsx": [".d.ts"], ".mts": [".d.mts"], ".cts": [".d.cts"],
};
const declarationOptions: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowArbitraryExtensions: true, resolveJsonModule: false,
};

function matchKey(map: Json, spec: string): PackageMatch | undefined {
  if (Object.hasOwn(map, spec)) return { value: map[spec] };
  const keys = Object.keys(map).filter(key => {
    const star = key.indexOf("*");
    return star !== -1 && star === key.lastIndexOf("*") && spec.length >= key.length - 1
      && spec.startsWith(key.slice(0, star)) && spec.endsWith(key.slice(star + 1));
  }).sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length);
  const key = keys[0];
  if (!key) return undefined;
  const star = key.indexOf("*");
  return { value: map[key], capture: spec.slice(star, spec.length - (key.length - star - 1)) };
}

function selectTarget(
  match: PackageMatch, mode: ResolutionMode, node: boolean, lookupType?: (target: string) => string | undefined,
): Selection | null | undefined {
  function visit(value: unknown, route: Selection["route"]): Selection | null | undefined {
    if (typeof value === "string") {
      const path = match.capture === undefined ? value : value.replaceAll("*", () => match.capture!);
      const file = lookupType ? lookupType(path) : path;
      return file === undefined ? undefined : { file, route };
    }
    if (value === null) return null;
    if (Array.isArray(value)) {
      for (const [index, branch] of value.entries()) {
        const target = visit(branch, [...route, index]);
        if (target) return target;
      }
      return undefined;
    }
    if (!isRecord(value)) throw new Error("Invalid conditional package target");
    for (const [name, branch] of Object.entries(value)) {
      if (lookupType && name.startsWith("types@")) throw new Error(`Unsupported versioned types condition ${name}`);
      if (name !== mode && name !== "default" && !(lookupType && name === "types") && !(node && name === "node")) continue;
      const target = visit(branch, [...route, name]);
      if (target !== undefined) return target;
    }
    return undefined;
  }
  return visit(match.value, []);
}

function exportMapping(manifest: Json, key: string) {
  const map = manifest.exports;
  return isRecord(map) && Object.keys(map).some(name => name.startsWith(".")) ? matchKey(map, key)
    : key === "." && map !== undefined ? { value: map } : undefined;
}

function localPath(base: string, spec: string, limit?: string): string {
  if (!spec || spec.includes("\\") || spec.includes(":") || spec.startsWith("/") || /%[\da-f]{2}/iu.test(spec)) {
    throw new Error(`Invalid local path ${spec}`);
  }
  const file = posix.join(base, spec).replace(/\/$/u, "");
  if (!isSafeGitPath(file) || (limit && file !== limit && !file.startsWith(`${limit}/`))) {
    throw new Error(`Path escapes the public package: ${spec}`);
  }
  return file;
}

function mappedPath(directory: string, target: string): string {
  if (!target.startsWith("./") || !isSafeGitPath(target.slice(2))) throw new Error(`Invalid local package target ${target}`);
  return localPath(directory, target, directory);
}

function recordTarget(map: Map<string, PackageProjection>, key: string, mode: ResolutionMode, match: PackageMatch, target: PackageTarget): void {
  const projection = map.get(key) ?? { original: match.value, modes: {} };
  const previous = projection.modes[mode];
  projection.modes[mode] = { bundler: { ...previous?.bundler, ...target.bundler }, node: { ...previous?.node, ...target.node } };
  map.set(key, projection);
}

function pruneRuntime(value: unknown, selections: Selection[], depth = 0): unknown {
  const leaf = selections.find(selection => selection.route.length === depth);
  if (leaf) return leaf.file;
  const descend = (child: unknown, key: string | number) => {
    const matches = selections.filter(selection => selection.route[depth] === key);
    return matches.length ? pruneRuntime(child, matches, depth + 1) : undefined;
  };
  if (Array.isArray(value)) return value.map(descend).filter(child => child !== undefined);
  return Object.fromEntries(Object.entries(value as Json).map(([key, child]) => [key, descend(child, key)]).filter(([, child]) => child !== undefined));
}

export function publicMappings(mappings: Map<string, PackageProjection>): Json {
  return Object.fromEntries([...mappings].map(([key, { original, modes }]) => {
    const branches = Object.entries(modes);
    const runtime = branches.flatMap(([, { bundler, node }]) => [bundler.runtime, node.runtime].filter(selection => selection !== undefined));
    const needsNode = runtime.some(selection => selection.route.includes("node"))
      || branches.some(([, { bundler, node }]) => node.types && node.types !== bundler.types);
    if (!needsNode) {
      return [key, Object.fromEntries(branches.map(([mode, { bundler }]) => [mode, { types: bundler.types, default: bundler.runtime?.file }]))];
    }
    // Retain the original order of matched runtime conditions. A separate
    // type overlay preserves the compiler's mode-specific declaration choices.
    const types = {
      node: Object.fromEntries(branches.map(([mode, selected]) => [mode, selected.node.types])),
      ...Object.fromEntries(branches.map(([mode, selected]) => [mode, selected.bundler.types])),
    };
    const selected = runtime.length ? pruneRuntime(original, runtime) : undefined;
    return [key, { types, ...(isRecord(selected) ? selected : { default: selected }) }];
  }));
}

type ManifestProjection = {
  source: Json;
  exports: Map<string, PackageProjection>;
  imports: Map<string, PackageProjection>;
  versions: Map<string, Map<string, string[]>>;
  legacy: Json;
};

export class CommunityGraph {
  readonly snapshot: GitSnapshot;
  readonly files = new Set<string>();
  readonly manifests = new Map<string, ManifestProjection>();
  readonly dependencies = new Map<string, Set<string>>();
  private readonly visited = new Set<string>();
  private readonly targetCache = new Map<string, ReturnType<typeof readModuleEdges>>();

  constructor(snapshot: GitSnapshot) {
    this.snapshot = snapshot;
  }

  scan(): void {
    for (const [spec, owner, key, source, profile, sourceKey = key] of publicEntries) {
      this.walk(`${owner}/${source}`, profile, [spec]);
      this.workspace(spec, profile, [spec], "import", false);
      const match = exportMapping(this.manifest(owner).source, sourceKey);
      if (match && (selectTarget(match, "require", false) || selectTarget(match, "require", true))) {
        this.workspace(spec, profile, [spec], "require", false, true);
      }
    }
  }

  private manifest(directory: string): ManifestProjection {
    let manifest = this.manifests.get(directory);
    if (manifest) return manifest;
    const source = this.snapshot.manifest(`${directory}/package.json`);
    manifest = { source, exports: new Map(), imports: new Map(), versions: new Map(), legacy: {} };
    this.manifests.set(directory, manifest);
    return manifest;
  }

  private owner(file: string): string {
    const root = sourceOwner(file);
    for (let directory = posix.dirname(file); directory !== root; directory = posix.dirname(directory)) {
      if (this.snapshot.entries.has(`${directory}/package.json`)) {
        this.manifest(directory);
        return directory;
      }
    }
    this.manifest(root);
    return root;
  }

  private dependency(from: string, name: string): void {
    if (name === from) return;
    const deps = this.dependencies.get(from) ?? new Set<string>();
    deps.add(name);
    this.dependencies.set(from, deps);
  }

  private walk(file: string, profile: Profile, chain: string[], allowJson = false): void {
    const json = file.endsWith(".json");
    if (!isPublicFile(file) || (json && !allowJson)) throw new Error(`Closed or unlisted source: ${[...chain, file].join(" -> ")}`);
    const key = `${profile}:${file}`;
    if (this.visited.has(key)) return;
    this.visited.add(key);
    this.files.add(file);
    const packageType = this.manifest(this.owner(file)).source.type;
    if (json) {
      JSON.parse(this.snapshot.text(file));
      const declaration = declarationCompanion(file);
      if (declaration && this.snapshot.entries.has(declaration)) this.walk(declaration, profile, chain);
      return;
    }
    let edges = this.targetCache.get(file);
    if (!edges) {
      edges = readModuleEdges(file, this.snapshot.text(file), packageType);
      this.targetCache.set(file, edges);
    }
    for (const { spec, line, kind, mode } of edges) {
      const next = [...chain, `${file}:${line}`];
      try {
        if (kind === "ambient") throw new Error(`Unresolved ambient types ${spec} in the Git tree`);
        if (kind === "path") this.local(localPath(posix.dirname(file), spec, sourceOwner(file)), true, profile, next);
        else this.specifier(spec, file, profile, next, mode, kind === "type");
      } catch (error) {
        throw new Error(`${file}:${line} -> ${spec}: ${(error as Error).message}`, { cause: error });
      }
    }
  }

  private specifier(spec: string, from: string, profile: Profile, chain: string[], mode: ResolutionMode, typeOnly: boolean): void {
    if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
      this.local(localPath(posix.dirname(from), spec, sourceOwner(from)), typeOnly, profile, chain);
      return;
    }
    if (spec.startsWith("#")) {
      const owner = this.owner(from);
      const manifest = this.manifest(owner);
      const match = isRecord(manifest.source.imports) && matchKey(manifest.source.imports, spec);
      if (!match) throw new Error(`Unresolved package import ${spec}`);
      const target = this.projectTarget(owner, match, "import", mode, typeOnly, profile, chain);
      recordTarget(manifest.imports, spec, mode, match, target);
      return;
    }
    if (entries.has(spec)) {
      const workspaceName = spec.split("/").slice(0, 2).join("/");
      if (entries.get(spec)![1] !== sourceOwner(from)) this.dependency(sourceOwner(from), workspaceName);
      this.workspace(spec, profile, chain, mode, typeOnly);
      return;
    }
    if ((profile === "browser-ui" ? browser : portable).has(spec)) {
      this.dependency(sourceOwner(from), spec === "react/jsx-runtime" ? "react" : spec);
      return;
    }
    if (profile === "portable-runtime" && (spec === "node:crypto" || spec === "node:buffer")) return;
    if (spec.startsWith("node:") || isBuiltin(spec)) throw new Error(`Node module is unavailable in ${profile}: ${spec}`);
    throw new Error(`Closed or unresolved module ${spec}`);
  }

  private workspace(spec: string, profile: Profile, chain: string[], mode: ResolutionMode, typeOnly: boolean, allowNodeOnly = false): void {
    const [, owner, key, , , sourceKey = key] = entries.get(spec)!;
    const manifest = this.manifest(owner);
    const match = exportMapping(manifest.source, sourceKey);
    if (!match) throw new Error(`Missing public export ${spec}`);
    const cacheKey = `export:${profile}:${spec}:${mode}:${typeOnly}:${allowNodeOnly}`;
    if (this.visited.has(cacheKey)) return;
    this.visited.add(cacheKey);
    const target = this.projectTarget(owner, match, "export", mode, typeOnly, profile, chain, allowNodeOnly);
    recordTarget(manifest.exports, key, mode, match, target);
    const legacy = key === "." && sourceKey === key ? this.legacyTargets(owner, manifest, profile, chain) : [];
    const names = [target.bundler.types, target.bundler.runtime?.file, target.node.types, target.node.runtime?.file]
      .filter(name => name !== undefined);
    this.versionTargets(owner, manifest, [...names, ...legacy.map(entry => entry.path)], profile, chain);
  }

  private projectTarget(
    owner: string, match: PackageMatch, kind: "import" | "export", mode: ResolutionMode, typeOnly: boolean, profile: Profile, chain: string[],
    allowNodeOnly = false,
  ): PackageTarget {
    const lookup = (file: string) => this.declarationTarget(owner, file, kind, mode);
    const collect = (node: boolean): SelectedTargets => {
      const runtime = !typeOnly ? selectTarget(match, mode, node) : undefined;
      const types = selectTarget(match, mode, node, lookup) ?? (kind === "import"
        ? selectTarget(match, mode, node, file => file.endsWith(".json") ? file : undefined) : undefined);
      const environment = node ? "Node" : "Bundler";
      const nodeOnly = !node && allowNodeOnly && !runtime;
      if (!types && !nodeOnly) throw new Error(`Package ${kind} has no active type target in ${mode} mode (${environment})`);
      if (!typeOnly && !runtime && !nodeOnly) throw new Error(`Package ${kind} has no active runtime target in ${mode} mode (${environment})`);
      if (types) this.packageTarget(owner, { path: types.file, typeOnly: true }, profile, chain, kind);
      if (runtime) this.packageTarget(owner, { path: runtime.file, typeOnly: false }, profile, chain, kind);
      return { ...(types ? { types: types.file } : {}), ...(runtime ? { runtime } : {}) };
    };
    return { bundler: collect(false), node: collect(true) };
  }

  private declarationTarget(owner: string, target: string, kind: "import" | "export", mode: ResolutionMode): string | undefined {
    const file = this.mappedFile(owner, target, kind);
    // Probe a single target with JS and JSON inference disabled. This preserves
    // Bundler's declaration substitution without letting an untyped JS leaf
    // shadow a later types condition. The host exposes only committed paths.
    const root = "/" + owner;
    const packageJson = root + "/package.json";
    const host: ts.ModuleResolutionHost = {
      fileExists: path => path === packageJson || (path.startsWith(root + "/")
        && /\.(?:[cm]?ts|tsx)$/u.test(path) && this.snapshot.entries.get(path.slice(1))?.type === "blob"),
      readFile: path => path === packageJson ? JSON.stringify({ imports: { "#target": target } }) : undefined,
      getCurrentDirectory: () => "/",
    };
    const resolutionMode = mode === "require" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext;
    const resolved = ts.resolveModuleName("#target", root + "/lookup.ts", declarationOptions, host, undefined, undefined, resolutionMode).resolvedModule;
    if (!resolved) return undefined;
    // Keeping a JSON target also exports its data when the compiler finds the
    // companion via an entirely type-only edge.
    if (file.endsWith(".json") && this.snapshot.entries.has(file)) return target;
    return "." + resolved.resolvedFileName.slice(root.length);
  }

  private mappedFile(owner: string, target: string, kind: "import" | "export"): string {
    const file = mappedPath(owner, target);
    if (!sourceExtension.test(file) && !file.endsWith(".json")) {
      throw new Error(`Package ${kind} must name an exact source file with its extension: ${target}`);
    }
    return file;
  }

  private packageTarget(owner: string, target: Target, profile: Profile, chain: string[], kind: "import" | "export"): void {
    const file = this.mappedFile(owner, target.path, kind);
    const json = file.endsWith(".json");
    if (this.snapshot.entries.get(file)?.type !== "blob") {
      throw new Error(`Package ${kind} must name an exact source file with its extension: ${target.path}`);
    }
    if (!target.typeOnly && isDeclaration(file)) throw new Error(`Package ${kind} has no runtime source: ${target.path}`);
    if (json) this.walk(file, profile, chain, true);
    else this.local(file, target.typeOnly, profile, chain);
  }

  private legacyTargets(directory: string, manifest: ManifestProjection, profile: Profile, chain: string[]): Target[] {
    const targets: Target[] = [];
    for (const name of ["main", "module", "types", "typings", "browser"]) {
      const value = manifest.source[name];
      if (value === undefined) continue;
      const values = name === "browser" && isRecord(value) ? Object.values(value).filter(item => item !== false) : [value];
      for (const target of values) {
        if (typeof target !== "string") throw new Error(`Invalid ${name} field in ${directory}`);
        const typeOnly = name === "types" || name === "typings";
        this.local(localPath(directory, target, directory), typeOnly, profile, chain);
        targets.push({ path: target, typeOnly });
      }
      manifest.legacy[name] = value;
    }
    return targets;
  }

  private local(file: string, typeOnly: boolean, profile: Profile, chain: string[]): void {
    const ext = posix.extname(file);
    const declaration = declarationCompanion(file);
    if (ext !== ".json" && declaration && this.snapshot.entries.has(declaration)) {
      if (!typeOnly) throw new Error(`Unsupported runtime asset ${file}`);
      this.walk(declaration, profile, chain);
      return;
    }
    const exact = this.snapshot.entries.get(file);
    const found = new Set<string>();
    if (!isDeclaration(file) && ext !== ".json") {
      const extensionCandidates = substitutes[ext]?.map(replacement => file.slice(0, -ext.length) + replacement)
        ?? extensionlessSources.map(replacement => file + replacement);
      for (const candidate of extensionCandidates) {
        if (!this.snapshot.entries.has(candidate)) continue;
        found.add(candidate);
        if (ext === ".js" || ext === ".jsx") break;
      }
    }
    if (exact && exact.type !== "tree") found.add(file);
    else {
      // Node may select opaque assets ahead of an index or a TypeScript substitution.
      const fallback = [".js", ...opaqueExtensions].find(ext => this.snapshot.entries.has(file + ext));
      if (fallback) found.add(file + fallback);
    }
    if (exact?.type === "tree") {
      if (this.snapshot.entries.has(`${file}/package.json`)) {
        throw new Error(`Relative directory ${file} has a package.json. Import an explicit file.`);
      }
      for (const extension of [...extensionlessSources, ...opaqueExtensions]) {
        const index = `${file}/index${extension}`;
        if (this.snapshot.entries.has(index)) found.add(index);
      }
    }
    for (const target of found) this.walk(target, profile, chain, target === file && ext === ".json");
    if (![...found].some(target => typeOnly || !isDeclaration(target))) throw new Error(`Unresolved ${file}`);
  }

  private versionTargets(directory: string, manifest: ManifestProjection, names: string[], profile: Profile, chain: string[]): void {
    const versions = manifest.source.typesVersions;
    if (versions === undefined) return;
    if (!isRecord(versions)) throw new Error(`Invalid typesVersions in ${directory}`);
    const versionRange = (ts as typeof ts & { VersionRange: { tryParse(text: string): unknown } }).VersionRange;
    const queries = new Set((names.length ? names : ["index"]).flatMap(name => {
      const file = posix.normalize(name);
      const extension = posix.extname(file);
      const stem = isDeclaration(file) ? file.replace(/\.d\.[cm]?ts$/u, "") : file.slice(0, file.length - extension.length);
      return [file, stem, ...declarations.map(ext => stem + ext)];
    }));
    for (const [selector, mapping] of Object.entries(versions)) {
      if (!versionRange.tryParse(selector) || !isRecord(mapping)) throw new Error(`Invalid typesVersions selector ${selector}`);
      const used = manifest.versions.get(selector) ?? new Map<string, string[]>();
      for (const query of queries) {
        const match = matchKey(mapping, query);
        if (!match) continue;
        if (!Array.isArray(match.value) || !match.value.length) throw new Error(`Invalid typesVersions mapping for ${query}`);
        const replacements = match.value.map((replacement: unknown) => {
          if (typeof replacement !== "string") throw new Error(`Invalid typesVersions target for ${query}`);
          const target = match.capture === undefined ? replacement : replacement.replaceAll("*", () => match.capture!);
          const file = localPath(directory, target, directory);
          const declaration = [file, ...declarations.map(ext => file + ext)].find(candidate =>
            isDeclaration(candidate) && this.snapshot.entries.has(candidate));
          if (!declaration) throw new Error(`Unresolved versioned declaration ${target}`);
          this.walk(declaration, profile, chain);
          return target;
        });
        used.set(query, replacements);
      }
      if (used.size) manifest.versions.set(selector, used);
    }
  }
}
