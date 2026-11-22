import { posix } from "node:path";
import { publicMappings, type CommunityGraph } from "./graph.ts";
import { isRecord, packageRoots } from "./snapshot.ts";

type Json = Record<string, unknown>;
export const communityLicense = "Apache-2.0";
const declarationDependencies: Partial<Record<string, readonly string[]>> = {
  "@aistudy/domain": ["@types/node"],
  "@aistudy/jingwei": ["@types/react", "@types/react-dom"],
  "@aistudy/ui": ["@types/react", "@types/react-dom"],
};

function object(value: unknown, label: string): Json {
  if (!isRecord(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function dependencyMap(value: unknown): Json {
  return value === undefined ? {} : object(value, "dependency map");
}

function packageVersion(value: unknown): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/u.test(value)) throw new Error("Invalid package version");
  return value;
}

function registryRange(value: unknown): string {
  if (typeof value !== "string" || !/^[\w*.~^<>=|+ -]+$/u.test(value)) throw new Error("Nonregistry dependency version");
  return value;
}

function lockPath(locked: Json, from: string, name: string): string | undefined {
  for (let directory = from;; directory = posix.dirname(directory)) {
    if (posix.basename(directory) !== "node_modules") {
      const candidate = posix.join(directory, "node_modules", name);
      if (Object.hasOwn(locked, candidate)) return candidate;
    }
    if (directory === "." || !directory) return undefined;
  }
}

function allowedRegistryEntry(entry: Json, name: string): Json {
  const version = packageVersion(entry.version);
  const basename = name.split("/").at(-1);
  const resolved = typeof entry.resolved === "string" ? new URL(entry.resolved) : undefined;
  if (!resolved || !["registry.npmjs.org", "registry.npmmirror.com"].includes(resolved.host) || resolved.protocol !== "https:"
    || resolved.username || resolved.password || resolved.search || resolved.hash
    || decodeURIComponent(resolved.pathname) !== `/${name}/-/${basename}-${version}.tgz`
    || typeof entry.integrity !== "string" || !/^sha(?:1|256|384|512)-[A-Za-z0-9+/=]+$/u.test(entry.integrity)) {
    throw new Error(`Unverified public registry blob for ${name}`);
  }
  const keep = new Set(["version", "resolved", "integrity", "license", "dependencies", "optionalDependencies", "peerDependencies",
    "peerDependenciesMeta", "bin", "engines", "os", "cpu", "libc", "hasInstallScript", "optional"]);
  return Object.fromEntries(Object.entries(entry).filter(([key]) => keep.has(key)));
}

const optionalPeer = (meta: Json, name: string): boolean => isRecord(meta[name]) && meta[name].optional === true;

export function createPublicManifests(graph: CommunityGraph): { manifests: Map<string, Json>; lock: Json } {
  const rootSource = graph.snapshot.manifest("package.json");
  const rootLock = graph.snapshot.manifest("package-lock.json");
  if (rootLock.lockfileVersion !== 3) throw new Error("Expected an npm v3 package lock");
  const locked = object(rootLock.packages, "lock packages");
  const publicNames = new Map<string, string>(packageRoots.map(directory => [`@aistudy/${posix.basename(directory)}`, directory]));
  const lockPackages = new Map<string, Json>();

  function includeRegistry(name: string, directory: string, optional = false): Json | undefined {
    if (!/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/u.test(name)
      || /^(?:@aistudy\/|@aws-sdk\/|(?:next|postgres|pg|drizzle-orm|ioredis|jose|server-only)$)/u.test(name)) {
      throw new Error(`Closed or invalid lock dependency ${name}`);
    }
    const path = lockPath(locked, directory, name);
    if (!path) {
      if (optional) return undefined;
      throw new Error(`Missing locked dependency ${name} from ${directory}`);
    }
    const known = lockPackages.get(path);
    if (known) return known;
    const entry = allowedRegistryEntry(object(locked[path], `lock entry ${path}`), name);
    lockPackages.set(path, entry);
    const dependencies = dependencyMap(entry.dependencies);
    const optionalDeps = dependencyMap(entry.optionalDependencies);
    for (const [dep, version] of Object.entries({ ...dependencies, ...optionalDeps })) {
      registryRange(version);
      includeRegistry(dep, path, Object.hasOwn(optionalDeps, dep));
    }
    const peerMeta = dependencyMap(entry.peerDependenciesMeta);
    for (const [dep, version] of Object.entries(dependencyMap(entry.peerDependencies))) {
      registryRange(version);
      if (!optionalPeer(peerMeta, dep)) includeRegistry(dep, posix.dirname(path));
    }
    return entry;
  }

  const compiler = includeRegistry("typescript", "");
  const root = {
    name: "aistudy-community-edition", version: packageVersion(rootSource.version),
    license: communityLicense, workspaces: [...packageRoots], engines: { node: ">=20" },
    devDependencies: { typescript: packageVersion(compiler?.version) },
  };
  const manifests = new Map<string, Json>([["package.json", { ...root, private: true }]]);
  lockPackages.set("", root);

  for (const [directory, projection] of [...graph.manifests].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const { source, legacy, exports, imports, versions } = projection;
    const manifest: Json = { license: communityLicense };
    if (source.type !== undefined) {
      if (source.type !== "module" && source.type !== "commonjs") throw new Error(`Invalid module type in ${directory}`);
      manifest.type = source.type;
    }
    Object.assign(manifest, legacy);
    if (exports.size) manifest.exports = publicMappings(exports);
    if (imports.size) manifest.imports = publicMappings(imports);
    if (versions.size) manifest.typesVersions = Object.fromEntries([...versions].map(([key, values]) => [key, Object.fromEntries(values)]));

    const expectedName = `@aistudy/${posix.basename(directory)}`;
    if (publicNames.get(expectedName) === directory) {
      if (source.name !== expectedName) throw new Error(`Invalid public package name in ${directory}`);
      manifest.name = expectedName;
      manifest.version = packageVersion(source.version);
      const direct = dependencyMap(source.dependencies);
      const peers = dependencyMap(source.peerDependencies);
      const peerMeta = dependencyMap(source.peerDependenciesMeta);
      const publicDirect = new Map<string, string>();
      const publicPeers = new Map<string, string>();
      const publicPeerMeta = new Map<string, { optional: true }>();
      for (const dep of [...(graph.dependencies.get(directory) ?? [])].sort()) {
        const workspace = publicNames.get(dep);
        if (workspace) {
          const version = packageVersion(graph.manifests.get(workspace)?.source.version);
          publicDirect.set(dep, version);
        } else {
          const external = includeRegistry(dep, directory);
          if (Object.hasOwn(peers, dep) && !Object.hasOwn(direct, dep)) {
            publicPeers.set(dep, registryRange(peers[dep]));
            if (optionalPeer(peerMeta, dep)) publicPeerMeta.set(dep, { optional: true });
          } else publicDirect.set(dep, registryRange(direct[dep] ?? external?.version));
        }
      }
      for (const name of declarationDependencies[expectedName] ?? []) {
        publicDirect.set(name, packageVersion(includeRegistry(name, directory)?.version));
      }
      if (publicDirect.size) manifest.dependencies = Object.fromEntries(publicDirect);
      if (publicPeers.size) manifest.peerDependencies = Object.fromEntries(publicPeers);
      if (publicPeerMeta.size) manifest.peerDependenciesMeta = Object.fromEntries(publicPeerMeta);
      const lockFields = new Set(["name", "version", "license", "dependencies", "peerDependencies", "peerDependenciesMeta"]);
      lockPackages.set(directory, Object.fromEntries(Object.entries(manifest).filter(([key]) => lockFields.has(key))));
      lockPackages.set(`node_modules/${expectedName}`, { resolved: directory, link: true });
    }
    manifests.set(`${directory}/package.json`, manifest);
  }

  const lock = {
    name: root.name, version: root.version, lockfileVersion: 3, requires: true,
    packages: Object.fromEntries([...lockPackages].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
  };
  return { manifests, lock };
}
