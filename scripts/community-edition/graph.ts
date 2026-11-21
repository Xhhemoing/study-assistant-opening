import { isBuiltin } from "node:module";
import { posix } from "node:path";
import ts from "typescript";
import { readModuleEdges } from "./module-edges.ts";
import { GitSnapshot, isPublicSource, isRecord, isSafeGitPath, sourceExtension, sourceOwner } from "./snapshot.ts";

type Profile = "browser-ui" | "portable-runtime";
type Target = { path: string; typeOnly: boolean };
type Json = Record<string, unknown>;

const publicEntries = [
  ["@aistudy/jingwei", "packages/jingwei", ".", "src/index.ts", "browser-ui"],
  ["@aistudy/jingwei/react", "packages/jingwei", "./react", "src/react/index.ts", "browser-ui"],
  ["@aistudy/ui", "packages/ui", ".", "src/index.ts", "browser-ui"],
  ["@aistudy/domain/native", "packages/domain", "./native", "src/portability/native/index.ts", "portable-runtime"],
  ["@aistudy/domain/cartridge-sdk-lite", "packages/domain", "./cartridge-sdk-lite", "src/cartridge-sdk-lite/index.ts", "portable-runtime"],
  ["@aistudy/contracts", "packages/contracts", ".", "src/index.ts", "portable-runtime"],
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
  ".js": [".ts", ".tsx", ".d.ts"], ".jsx": [".tsx", ".d.ts"], ".mjs": [".mts", ".d.mts"], ".cjs": [".cts", ".d.cts"],
  ".ts": [".d.ts"], ".tsx": [".d.ts"], ".mts": [".d.mts"], ".cts": [".d.cts"],
};
const isDeclaration = (file: string) => declarations.some(ext => file.endsWith(ext));

function matchKey(map: Json, spec: string): { value: unknown; capture?: string } | undefined {
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

function expandConditions(value: unknown, capture?: string, typeOnly = false): { map: unknown; targets: Target[] } {
  if (typeof value === "string") {
    const path = capture === undefined ? value : value.replaceAll("*", () => capture);
    return { map: path, targets: [{ path, typeOnly }] };
  }
  if (value === null) return { map: value, targets: [] };
  if (Array.isArray(value) || isRecord(value)) {
    const children = Object.entries(value).map(([name, child]) => [name,
      expandConditions(child, capture, typeOnly || name === "types" || name.startsWith("types@"))] as const);
    return { map: Array.isArray(value) ? children.map(([, child]) => child.map)
      : Object.fromEntries(children.map(([name, child]) => [name, child.map])),
    targets: children.flatMap(([, child]) => child.targets) };
  }
  throw new Error("Invalid conditional package target");
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

type ManifestProjection = {
  source: Json;
  exports: Map<string, unknown>;
  imports: Map<string, unknown>;
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
    for (const [spec, owner, , source, profile] of publicEntries) {
      this.walk(`${owner}/${source}`, profile, [spec]);
      this.workspace(spec, profile, [spec]);
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

  private walk(file: string, profile: Profile, chain: string[]): void {
    const key = `${profile}:${file}`;
    if (this.visited.has(key)) return;
    if (!isPublicSource(file)) throw new Error(`Closed or unlisted source: ${[...chain, file].join(" -> ")}`);
    this.visited.add(key);
    this.files.add(file);
    this.owner(file);
    let edges = this.targetCache.get(file);
    if (!edges) {
      edges = readModuleEdges(file, this.snapshot.text(file));
      this.targetCache.set(file, edges);
    }
    if (/\.[jt]sx$/u.test(file)) this.specifier("react/jsx-runtime", file, profile, [...chain, file], false);
    for (const { spec, line, kind } of edges) {
      const next = [...chain, `${file}:${line}`];
      try {
        if (kind === "ambient") throw new Error(`Unresolved ambient types ${spec} in the Git tree`);
        if (kind === "path") this.local(localPath(posix.dirname(file), spec, sourceOwner(file)), true, profile, next);
        else this.specifier(spec, file, profile, next, kind === "type");
      } catch (error) {
        throw new Error(`${file}:${line} -> ${spec}: ${(error as Error).message}`, { cause: error });
      }
    }
  }

  private specifier(spec: string, from: string, profile: Profile, chain: string[], typeOnly: boolean, activeAliases = new Set<string>()): void {
    if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
      this.local(localPath(posix.dirname(from), spec, sourceOwner(from)), typeOnly, profile, chain);
      return;
    }
    if (spec.startsWith("#")) {
      const owner = this.owner(from);
      const manifest = this.manifest(owner);
      const match = isRecord(manifest.source.imports) && matchKey(manifest.source.imports, spec);
      if (!match || activeAliases.has(spec)) throw new Error(`Unresolved or cyclic package import ${spec}`);
      const expanded = expandConditions(match.value, match.capture, typeOnly);
      if (!expanded.targets.length) throw new Error(`Empty package import ${spec}`);
      manifest.imports.set(spec, expanded.map);
      const active = new Set([...activeAliases, spec]);
      for (const target of expanded.targets) {
        if (target.path.startsWith("./")) this.local(mappedPath(owner, target.path), target.typeOnly, profile, chain);
        else if (target.path.startsWith(".")) throw new Error(`Invalid local package target ${target.path}`);
        else this.specifier(target.path, from, profile, chain, target.typeOnly, active);
      }
      return;
    }
    if (entries.has(spec)) {
      const workspaceName = spec.split("/").slice(0, 2).join("/");
      if (entries.get(spec)![1] !== sourceOwner(from)) this.dependency(sourceOwner(from), workspaceName);
      this.workspace(spec, profile, chain, typeOnly);
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

  private workspace(spec: string, profile: Profile, chain: string[], typeOnly = false): void {
    const [, owner, key] = entries.get(spec)!;
    const manifest = this.manifest(owner);
    const match = exportMapping(manifest.source, key);
    if (!match) throw new Error(`Missing public export ${spec}`);
    const expanded = expandConditions(match.value, match.capture, typeOnly);
    if (!expanded.targets.some(target => typeOnly || !target.typeOnly)) throw new Error(`Missing runtime export ${spec}`);
    const cacheKey = `export:${profile}:${spec}:${typeOnly}`;
    if (this.visited.has(cacheKey)) return;
    this.visited.add(cacheKey);
    manifest.exports.set(key, expanded.map);
    for (const target of expanded.targets) {
      this.packageExport(owner, target, profile, chain);
    }
    const legacy = key === "." ? this.legacyTargets(owner, manifest, profile, chain, new Set()) : [];
    this.versionTargets(owner, manifest, [...expanded.targets, ...legacy].map(target => target.path), profile, chain);
  }

  private packageExport(owner: string, target: Target, profile: Profile, chain: string[]): void {
    const file = mappedPath(owner, target.path);
    if (!sourceExtension.test(file) || this.snapshot.entries.get(file)?.type !== "blob") {
      throw new Error(`Package export must name an exact source file with its extension: ${target.path}`);
    }
    if (!target.typeOnly && isDeclaration(file)) throw new Error(`Package export has no runtime source: ${target.path}`);
    this.local(file, target.typeOnly, profile, chain);
  }

  private legacyTargets(directory: string, manifest: ManifestProjection, profile: Profile, chain: string[], dirs: Set<string>): Target[] {
    const targets: Target[] = [];
    for (const name of ["main", "module", "types", "typings", "browser"]) {
      const value = manifest.source[name];
      if (value === undefined) continue;
      const values = name === "browser" && isRecord(value) ? Object.values(value).filter(item => item !== false) : [value];
      for (const target of values) {
        if (typeof target !== "string") throw new Error(`Invalid ${name} field in ${directory}`);
        const typeOnly = name === "types" || name === "typings";
        this.local(localPath(directory, target, directory), typeOnly, profile, chain, dirs);
        targets.push({ path: target, typeOnly });
      }
      manifest.legacy[name] = value;
    }
    return targets;
  }

  private local(file: string, typeOnly: boolean, profile: Profile, chain: string[], dirs = new Set<string>()): void {
    const exact = this.snapshot.entries.get(file);
    const found = new Set<string>();
    if (exact && exact.type !== "tree") found.add(file);
    else {
      // Node may select opaque assets ahead of an index or a TypeScript substitution.
      const fallback = [".js", ...opaqueExtensions].find(ext => this.snapshot.entries.has(file + ext));
      if (fallback) found.add(file + fallback);
    }
    const ext = posix.extname(file);
    if (!isDeclaration(file)) {
      const extensionCandidates = substitutes[ext]?.map(replacement => file.slice(0, -ext.length) + replacement)
        ?? extensionlessSources.map(replacement => file + replacement);
      for (const candidate of extensionCandidates) if (this.snapshot.entries.has(candidate)) found.add(candidate);
    }
    for (const target of found) this.walk(target, profile, chain);
    const directory = exact?.type === "tree" && this.directory(file, typeOnly, profile, chain, dirs);
    if (!directory && ![...found].some(target => typeOnly || !isDeclaration(target))) throw new Error(`Unresolved ${file}`);
  }

  private directory(directory: string, typeOnly: boolean, profile: Profile, chain: string[], dirs: Set<string>): boolean {
    if (dirs.has(directory)) throw new Error(`Cyclic directory entry ${directory}`);
    const next = new Set([...dirs, directory]);
    const manifest = this.snapshot.entries.has(`${directory}/package.json`) ? this.manifest(directory) : undefined;
    const match = manifest && exportMapping(manifest.source, ".");
    const index = `${directory}/index`;
    const hasIndex = [...extensionlessSources, ...opaqueExtensions]
      .some(extension => this.snapshot.entries.has(index + extension));
    if (hasIndex) this.local(index, typeOnly, profile, chain, next);
    if (!manifest) return hasIndex;
    if (manifest.source.exports !== undefined && !match) throw new Error(`Missing directory root export ${directory}`);
    const expanded = match ? expandConditions(match.value, match.capture, typeOnly) : undefined;
    const legacy = this.legacyTargets(directory, manifest, profile, chain, next);
    if (expanded) {
      manifest.exports.set(".", expanded.map);
      for (const target of expanded.targets) {
        this.packageExport(directory, target, profile, chain);
      }
    }
    const targets = [...(expanded?.targets ?? []), ...legacy];
    this.versionTargets(directory, manifest, targets.map(target => target.path), profile, chain);
    return hasIndex || targets.some(target => typeOnly || !target.typeOnly);
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
