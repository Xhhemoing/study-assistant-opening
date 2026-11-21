import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { queryCartridgeLiteCapability } from "@aistudy/contracts/cartridge-lite";
import { CommunityGraph } from "./community-edition/graph.ts";
import { communityLicense, createPublicManifests } from "./community-edition/manifests.ts";
import { GitSnapshot, isRecord, isSafeGitPath } from "./community-edition/snapshot.ts";

export { queryCartridgeLiteCapability };

export type CommunityExportOptions = {
  commit: string;
  repository?: string;
  targetDirectory?: string;
  dryRun?: boolean;
};

const readme = `# AIstudy Community Edition

These source packages are available under Apache-2.0. Use \`npm ci\` to install the pinned dependencies. The packages expose TypeScript source for a TypeScript-aware bundler.

- \`@aistudy/jingwei\` and \`@aistudy/jingwei/react\` provide the artifact presentation core and React renderer.
- \`@aistudy/ui\` provides shared UI components.
- \`@aistudy/contracts\`, \`@aistudy/contracts/learner-portability\` and \`@aistudy/contracts/cartridge-lite\` provide data contracts.
- \`@aistudy/domain/native\` provides in-memory backup and restore primitives.
- \`@aistudy/domain/cartridge-sdk-lite\` provides Markdown, Obsidian, Anki TSV, Store ZIP, FSRS, and introductory L1–L2 cartridge operations.
`;

function ensureNewOrEmpty(directory: string): boolean {
  const existing = lstatSync(directory, { throwIfNoEntry: false });
  if (!existing) return false;
  if (!existing.isDirectory() || readdirSync(directory).length) throw new Error("Export target must be a new or empty directory");
  return true;
}

function checkWrittenLicenses(directory: string, sources: Iterable<string>): void {
  const verified = new Set<string>();
  function apache(file: string): void {
    if (verified.has(file)) return;
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(value) || value.license !== communityLicense) throw new Error(`Expected ${communityLicense} in ${path.relative(directory, file)}`);
    verified.add(file);
  }
  apache(path.join(directory, "package.json"));
  for (const source of sources) {
    let parent = path.dirname(path.join(directory, source));
    while (parent !== directory) {
      const file = path.join(parent, "package.json");
      if (lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
        apache(file);
        break;
      }
      parent = path.dirname(parent);
    }
    if (parent === directory) throw new Error(`No Community Edition package manifest governs ${source}`);
  }
}

function installExport(target: string, files: Map<string, Uint8Array | string>, sources: Set<string>): void {
  const absolute = path.resolve(target);
  const name = path.basename(absolute);
  if (!isSafeGitPath(name)) throw new Error("Invalid export directory name");
  const parent = realpathSync(path.dirname(absolute));
  const output = path.join(parent, name);
  if ([absolute, output].some(file => file.split(path.sep).some(segment => segment.toLowerCase() === ".git"))) {
    throw new Error("Export target cannot be inside Git metadata");
  }
  ensureNewOrEmpty(output);
  const staging = mkdtempSync(path.join(parent, ".community-edition-"));
  let removedEmptyTarget = false;
  try {
    for (const [file, content] of files) {
      const destination = path.join(staging, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, content, { flag: "wx" });
    }
    checkWrittenLicenses(staging, sources);
    if (ensureNewOrEmpty(output)) {
      rmdirSync(output);
      removedEmptyTarget = true;
    }
    renameSync(staging, output);
  } catch (error) {
    if (removedEmptyTarget && !lstatSync(output, { throwIfNoEntry: false })) mkdirSync(output);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Scan the candidate Git tree before creating any destination files. */
export function exportCommunityEdition(options: CommunityExportOptions): { commit: string; files: string[] } {
  if (!options.dryRun && !options.targetDirectory) throw new Error("An export requires a target directory");
  const snapshot = new GitSnapshot(options.repository ?? process.cwd(), options.commit);
  const graph = new CommunityGraph(snapshot);
  graph.scan();
  const { manifests, lock } = createPublicManifests(graph);
  const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
  const files = new Map<string, Uint8Array | string>();
  files.set("LICENSE", readFileSync(new URL("./community-edition/apache-2.0.txt", import.meta.url)));
  files.set("README.md", readme);
  files.set("package-lock.json", json(lock));
  for (const [file, manifest] of manifests) files.set(file, json(manifest));
  for (const file of graph.files) files.set(file, snapshot.read(file));
  const ordered = [...files.keys()].sort();
  if (new Set(ordered.map(file => file.toLowerCase())).size !== ordered.length || !ordered.every(isSafeGitPath)) {
    throw new Error("Export paths must be portable and unique");
  }
  if (!options.dryRun) installExport(options.targetDirectory!, new Map(ordered.map(file => [file, files.get(file)!])), graph.files);
  return { commit: snapshot.commit, files: ordered };
}

function main(): void {
  const { values } = parseArgs({ options: {
    commit: { type: "string" }, out: { type: "string" }, repo: { type: "string" },
    "dry-run": { type: "boolean" }, level: { type: "string" }, capability: { type: "string" },
  } });
  if (values.level) {
    console.log(JSON.stringify(queryCartridgeLiteCapability(values.level, values.capability)));
    return;
  }
  if (!values.commit) throw new Error("Usage: --commit <revision> [--out <directory> | --dry-run], or --level <level> [--capability <capability>]");
  const result = exportCommunityEdition({ commit: values.commit, repository: values.repo, targetDirectory: values.out, dryRun: values["dry-run"] });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
