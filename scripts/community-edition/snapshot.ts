import { execFileSync } from "node:child_process";
import { posix } from "node:path";

export const packageRoots = ["packages/contracts", "packages/domain", "packages/jingwei", "packages/ui"] as const;
export const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const sourceRoots = [
  "packages/contracts/src/", "packages/domain/src/portability/native/", "packages/domain/src/cartridge-sdk-lite/",
  "packages/jingwei/src/", "packages/ui/src/",
];
const closedSegment = /^(?:ai-policy|epistemic|symbolic-equivalence|pedagogical-retrieval|tutor-graph|cartridge-compiler|stage0-simulator|diagnostic-placement|remedy-clinic|rubric-calibration|exam-forecast|commercial-resilience|resilience-canary-shredding|metacognition|multimodal-evidence|offline-companion-bridge|stack-408-v1|ielts-writing-speaking-v1)$/iu;
const closedProduct = /(?:^|[-_.])(?:0109|l3|l4|flagship|seeded-recipe)(?:$|[-_.])/iu;
const workspaceManifests: ReadonlySet<string> = new Set(packageRoots.map(root => `${root}/package.json`));

export function isSafeGitPath(file: string): boolean {
  return file.split("/").every(part => part.length > 0 && part !== "." && part !== ".."
    && !/^(?:\.git|node_modules|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)
    && !/[\\:\p{Cc}<>"|?*]|[. ]$/u.test(part));
}

export function isPublicSource(file: string): boolean {
  return isSafeGitPath(file) && sourceRoots.some(root => file.startsWith(root))
    && !file.split("/").some(part => closedProduct.test(part) || closedSegment.test(part.replace(/(?:\.d)?\.[cm]?[jt]sx?$/u, "")))
    && !/(?:^|\/)opening\/(?:cartridges|exam-sprint|share|teachback-arena|span-[^/]+)\//iu.test(file)
    && !/(?:^|\/)(?:fixtures|__fixtures__|__tests__|seeds|migrations)\//iu.test(file)
    && !/\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(file) && sourceExtension.test(file);
}

export function sourceOwner(file: string): string {
  const owner = packageRoots.find(root => file.startsWith(`${root}/`));
  if (!owner) throw new Error(`No public package owns ${file}`);
  return owner;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

type TreeEntry = { mode: string; oid: string; type: string };

export class GitSnapshot {
  readonly commit: string;
  readonly entries = new Map<string, TreeEntry>();
  private readonly blobs = new Map<string, Buffer>();

  constructor(repo: string, revision: string) {
    const git = (args: string[], input?: string) => execFileSync("git", ["--no-replace-objects", ...args], {
      cwd: repo, input, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.commit = git(["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]).toString("ascii").trim();
    const tree = git(["ls-tree", "-r", "-t", "-z", this.commit]);
    for (let start = 0; start < tree.length;) {
      const end = tree.indexOf(0, start);
      const separator = tree.indexOf(9, start);
      if (end < 0 || separator < 0 || separator >= end) throw new Error("Invalid Git tree record");
      const [mode, type, oid] = tree.toString("ascii", start, separator).split(" ");
      if (!mode || !type || !oid) throw new Error("Invalid Git tree metadata");
      try {
        const name = utf8.decode(tree.subarray(separator + 1, end));
        this.entries.set(name, { mode, type, oid });
      } catch (error) {
        const name = tree.toString("utf8", separator + 1, end);
        if (sourceRoots.some(root => name.startsWith(root))) throw new Error("Non-UTF-8 pathname in a public source root", { cause: error });
      }
      start = end + 1;
    }

    const oids = [...new Set([...this.entries].filter(([file, entry]) => this.isRegular(entry) && (
      workspaceManifests.has(file) || file === "package-lock.json" || file === "package.json"
      || isPublicSource(file) || (sourceRoots.some(root => file.startsWith(root)) && posix.basename(file) === "package.json")
    )).map(([, entry]) => entry.oid))];
    if (oids.length === 0) return;
    const result = git(["cat-file", "--batch"], oids.join("\n") + "\n");
    let offset = 0;
    for (const oid of oids) {
      const end = result.indexOf(10, offset);
      if (end < 0) throw new Error("Truncated Git blob output");
      const [actual, type, sizeText] = result.toString("ascii", offset, end).split(" ");
      const size = Number(sizeText);
      const next = end + size + 1;
      if (actual !== oid || type !== "blob" || !Number.isSafeInteger(size) || size < 0 || result[next] !== 10) {
        throw new Error(`Invalid Git blob ${oid}`);
      }
      this.blobs.set(oid, result.subarray(end + 1, next));
      offset = next + 1;
    }
    if (offset !== result.length) throw new Error("Unexpected Git blob data");
  }

  private isRegular(entry: TreeEntry): boolean {
    return entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");
  }

  read(file: string): Buffer {
    const entry = this.entries.get(file);
    const value = entry && this.isRegular(entry) && this.blobs.get(entry.oid);
    if (!value) throw new Error(`Expected an allowlisted regular Git blob at ${file}`);
    return value;
  }

  text(file: string): string {
    return utf8.decode(this.read(file));
  }

  manifest(file: string): Record<string, unknown> {
    const value: unknown = JSON.parse(this.text(file));
    if (!isRecord(value)) throw new Error(`Expected an object in ${file}`);
    return value;
  }
}
