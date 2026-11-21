import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { exportCommunityEdition, queryCartridgeLiteCapability } from "../../scripts/export-community-edition";

const repo = process.cwd();
const localTemp = path.join(repo, ".local", "tmp");
const licenseTemplate = "scripts/community-edition/apache-2.0.txt";

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync), renameSync: vi.fn(fs.renameSync), rmdirSync: vi.fn(fs.rmdirSync) };
});

function git(cwd: string, ...args: string[]): Buffer {
  return execFileSync("git", ["-c", "user.name=Contract Test", "-c", "user.email=contract@example.invalid",
    "-c", "core.autocrlf=false", ...args], { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

function inLocalTemp(run: (directory: string) => void): void {
  mkdirSync(localTemp, { recursive: true });
  const directory = mkdtempSync(path.join(localTemp, "community-contract-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const print = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

function write(root: string, file: string, content: string | Buffer): void {
  const output = path.join(root, file);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, content, "utf8");
}

const fixtureToolchain = ["typescript", "@types/node", "@types/react", "@types/react-dom", "undici-types", "csstype"];

function compileIsolatedConsumer(directory: string): void {
  const env = { ...process.env, TMP: localTemp, TEMP: localTemp, TMPDIR: localTemp, NODE_PATH: "", npm_config_prefix: directory,
    npm_config_cache: path.join(repo, ".local", "npm-cache") };
  const options = { cwd: directory, env, encoding: "utf8", timeout: 110_000, windowsHide: true } as const;
  const npmArgs = ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"];
  if (process.env.npm_execpath) execFileSync(process.execPath, [process.env.npm_execpath, ...npmArgs], options);
  else if (process.platform === "win32") execFileSync("pwsh", ["-NoProfile", "-Command", "npm", ...npmArgs], options);
  else execFileSync("npm", npmArgs, options);

  const entrypoints = ["@aistudy/contracts", "@aistudy/contracts/cartridge-lite", "@aistudy/contracts/learner-portability",
    "@aistudy/domain/native", "@aistudy/domain/cartridge-sdk-lite", "@aistudy/jingwei", "@aistudy/jingwei/react", "@aistudy/ui"];
  write(directory, "consumer.ts", entrypoints.map((spec, index) => `export * as entry${index} from ${JSON.stringify(spec)};`).join("\n"));
  const compiler = spawnSync(process.execPath, [path.join(directory, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict",
    "--noUncheckedIndexedAccess", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler",
    "--jsx", "react-jsx", "--types", "node,react,react-dom", "--typeRoots", "./node_modules/@types", "--pretty", "false",
    "--listFiles", "consumer.ts"], options);
  expect(compiler.error).toBeUndefined();
  const paths = compiler.stdout.trim().split(/\r?\n/u);
  const diagnostics = paths.filter(line => /\bTS\d+:/u.test(line));
  expect(compiler.status, [...diagnostics, compiler.stderr].join("\n")).toBe(0);
  expect(diagnostics).toEqual([]);
  for (const file of paths) {
    const relative = path.relative(directory, path.resolve(directory, file));
    expect(relative.startsWith("..") || path.isAbsolute(relative), `Compiler read outside the export: ${file}`).toBe(false);
  }
}

function fixture(root: string, extras: Record<string, string> = {}): string {
  const entries = {
    contracts: { ".": "./src/index.ts", "./learner-portability": "./src/learner-portability/index.ts", "./cartridge-lite": "./src/cartridge-lite/index.ts" },
    domain: { "./native": "./src/portability/native/index.ts", "./cartridge-sdk-lite": "./src/cartridge-sdk-lite/index.ts" },
    jingwei: { ".": "./src/index.ts", "./react": "./src/react/index.ts" },
    ui: { ".": "./src/index.ts" },
  };
  mkdirSync(root);
  git(root, "init", "--quiet", "--template=");
  write(root, "package.json", print({ name: "private-fixture", license: "UNLICENSED", version: "0.0.0" }));
  const privateLock = JSON.parse(git(repo, "show", "HEAD:package-lock.json").toString("utf8"));
  const packages = Object.fromEntries(fixtureToolchain.map(name => [`node_modules/${name}`, privateLock.packages[`node_modules/${name}`]]));
  write(root, "package-lock.json", print({ lockfileVersion: 3, packages }));
  write(root, licenseTemplate, git(repo, "show", `HEAD:${licenseTemplate}`));
  for (const [pkg, exports] of Object.entries(entries)) {
    write(root, `packages/${pkg}/package.json`, print({ name: `@aistudy/${pkg}`, license: "UNLICENSED", version: "0.0.0", type: "module", exports }));
    for (const file of Object.values(exports)) write(root, `packages/${pkg}/${file}`, "export {};\n");
  }
  for (const [file, content] of Object.entries(extras)) write(root, file, content);
  git(root, "add", "--all");
  return git(root, "commit-tree", git(root, "write-tree").toString("ascii").trim(), "-m", "test candidate").toString("ascii").trim();
}

describe("Community Edition extraction", () => {
  it("dry-runs and exports only public blobs from an exact repository commit", () => inLocalTemp(directory => {
    const requested = process.env.AISTUDY_COMMUNITY_TEST_COMMIT ?? "HEAD";
    const commit = git(repo, "rev-parse", "--verify", `${requested}^{commit}`).toString("ascii").trim();
    const targetDirectory = path.join(directory, "edition");
    const dry = exportCommunityEdition({ commit, repository: repo, targetDirectory, dryRun: true });
    expect(dry.commit).toBe(commit);
    expect(existsSync(targetDirectory)).toBe(false);
    const result = exportCommunityEdition({ commit, repository: repo, targetDirectory });
    expect(result).toEqual(dry);

    const assertFiles = (relative = ""): string[] => readdirSync(path.join(targetDirectory, relative), { withFileTypes: true })
      .flatMap(entry => {
        const file = relative ? `${relative}/${entry.name}` : entry.name;
        expect(entry.isSymbolicLink()).toBe(false);
        return entry.isDirectory() ? assertFiles(file) : [file];
      });
    expect(assertFiles().sort()).toEqual(result.files);
    expect(result.files.some(file => /(?:^|\/)(?:\.git|fixtures|migrations|ai-policy)(?:\/|$)|^packages\/(?:ai|database)\//u.test(file))).toBe(false);
    expect(result.files).toContain("packages/domain/src/cartridge-sdk-lite/index.ts");
    for (const name of ["package.json", "packages/contracts/package.json", "packages/domain/package.json", "packages/ui/package.json", "packages/jingwei/package.json"]) {
      const original = JSON.parse(git(repo, "show", `${commit}:${name}`).toString("utf8"));
      expect(original.license).toBe("UNLICENSED");
      const generated = JSON.parse(readFileSync(path.join(targetDirectory, name), "utf8"));
      expect(generated.license).toBe("Apache-2.0");
      expect(JSON.stringify(generated)).not.toMatch(/@aistudy\/(?:ai|database)|cartridge-is-proxy/u);
    }
    expect(readFileSync(path.join(targetDirectory, "LICENSE"), "utf8")).toMatch(/Apache License\s+Version 2\.0/u);
    const publicFile = "packages/domain/src/cartridge-sdk-lite/index.ts";
    expect(readFileSync(path.join(targetDirectory, publicFile))).toEqual(git(repo, "show", `${commit}:${publicFile}`));
    const lock = JSON.parse(readFileSync(path.join(targetDirectory, "package-lock.json"), "utf8"));
    expect(lock.packages[""].license).toBe("Apache-2.0");
    expect(lock.packages["node_modules/ts-fsrs"].integrity).toMatch(/^sha512-/u);
    expect(Object.keys(lock.packages)).not.toContain("node_modules/next");
    expect(Object.keys(lock.packages)).toEqual(expect.arrayContaining(fixtureToolchain.map(name => `node_modules/${name}`)));
    expect(() => exportCommunityEdition({ commit, repository: repo, targetDirectory })).toThrow(/must not exist/u);
    compileIsolatedConsumer(targetDirectory);
  }), 120_000);

  it("uses committed bytes and ignores unlisted and modified working-tree files", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const targetDirectory = path.join(directory, "edition");
    const candidate = "packages/domain/src/cartridge-sdk-lite/index.ts";
    const commit = fixture(repository, { "packages/domain/src/cartridge-sdk-lite/nonentry.ts": 'require("pg");\n' });
    write(repository, candidate, 'import "@aistudy/ai";\n');
    const result = exportCommunityEdition({ commit, repository, targetDirectory });
    expect(result.files).not.toContain("packages/domain/src/cartridge-sdk-lite/nonentry.ts");
    expect(readFileSync(path.join(targetDirectory, candidate), "utf8")).toBe("export {};\n");
  }));

  it("reads the committed Apache text even when its working copy is changed or absent", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const commit = fixture(repository);
    const committed = git(repository, "show", `${commit}:${licenseTemplate}`);
    write(repository, licenseTemplate, "Changed working-tree license");
    const reads = vi.mocked(readFileSync);
    const original = reads.getMockImplementation()!;
    reads.mockImplementation((file, options) => {
      if (String(file).replaceAll("\\", "/").endsWith(licenseTemplate)) throw new Error("Working-tree license is unavailable");
      return original(file, options);
    });
    try {
      for (const name of ["changed", "absent"]) {
        const targetDirectory = path.join(directory, name);
        exportCommunityEdition({ commit, repository, targetDirectory });
        expect(readFileSync(path.join(targetDirectory, "LICENSE"))).toEqual(committed);
        if (name === "changed") unlinkSync(path.join(repository, licenseTemplate));
      }
    } finally {
      reads.mockImplementation(original);
    }
  }));

  it("rejects a candidate whose committed Apache license has been altered", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const targetDirectory = path.join(directory, "edition");
    const commit = fixture(repository, { [licenseTemplate]: "Apache License\nVersion 2.0, January 2004\nAltered terms.\n" });
    expect(() => exportCommunityEdition({ commit, repository, targetDirectory })).toThrow(/approved text/u);
    expect(readdirSync(directory)).toEqual(["source"]);
  }));

  it("preserves existing empty directories and publishes to a new path with one rename", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const commit = fixture(repository);
    const targetDirectory = path.join(directory, "edition");
    const empty = path.join(directory, "existing");
    mkdirSync(empty);
    const inode = lstatSync(empty).ino;
    const renames = vi.mocked(renameSync);
    const removals = vi.mocked(rmdirSync);
    renames.mockClear();
    removals.mockClear();
    expect(() => exportCommunityEdition({ commit, repository, targetDirectory: empty })).toThrow(/must not exist/u);
    expect(lstatSync(empty).ino).toBe(inode);
    expect(readdirSync(empty)).toEqual([]);
    expect(renames).not.toHaveBeenCalled();
    expect(removals).not.toHaveBeenCalled();
    expect(readdirSync(directory).sort()).toEqual(["existing", "source"]);

    exportCommunityEdition({ commit, repository, targetDirectory });
    expect(renames).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/\.community-edition-/u), targetDirectory);
    expect(path.dirname(String(renames.mock.calls[0]?.[0]))).toBe(directory);
    expect(removals).not.toHaveBeenCalled();
    expect(existsSync(path.join(targetDirectory, "LICENSE"))).toBe(true);
  }));

  it("requires exact paths for all package export conditions", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const commit = fixture(repository, { "packages/domain/package.json": print({
      name: "@aistudy/domain", license: "UNLICENSED", version: "0.0.0", type: "module",
      exports: { "./native": "./src/portability/native/index.ts", "./cartridge-sdk-lite": {
        types: "./src/cartridge-sdk-lite/index.ts", default: "./src/cartridge-sdk-lite/index",
      } },
    }) });
    expect(() => exportCommunityEdition({ commit, repository, dryRun: true })).toThrow(/exact source file with its extension/u);
  }));

  it.each([
    ["a string target", "./src/cartridge-sdk-lite/helper"],
    ["a nested condition", { types: "./src/cartridge-sdk-lite/helper.ts", default: "./src/cartridge-sdk-lite/helper" }],
  ])("requires exact local paths for package imports with %s", (_description, target) => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const commit = fixture(repository, {
      "packages/domain/package.json": print({
        name: "@aistudy/domain", license: "UNLICENSED", version: "0.0.0", type: "module",
        exports: { "./native": "./src/portability/native/index.ts", "./cartridge-sdk-lite": "./src/cartridge-sdk-lite/index.ts" },
        imports: { "#helper": target },
      }),
      "packages/domain/src/cartridge-sdk-lite/index.ts": 'export * from "#helper";',
      "packages/domain/src/cartridge-sdk-lite/helper.ts": "export const publicValue = 1;",
    });
    expect(() => exportCommunityEdition({ commit, repository, dryRun: true })).toThrow(/Package import must name an exact source file/u);
  }));

  it("requires an index for a relative directory with package exports", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const group = "packages/domain/src/cartridge-sdk-lite/group";
    const extras = {
      "packages/domain/src/cartridge-sdk-lite/index.ts": 'export * from "./group";',
      [group + "/package.json"]: print({ exports: "./actual.ts" }),
      [group + "/actual.ts"]: "export const publicValue = 1;",
    };
    const commit = fixture(repository, extras);
    expect(() => exportCommunityEdition({ commit, repository, dryRun: true })).toThrow(/Unresolved .*\/group/u);

    const index = group + "/index.ts";
    write(repository, index, "export const publicValue = 2;");
    git(repository, "add", "--", index);
    const indexed = git(repository, "commit-tree", git(repository, "write-tree").toString("ascii").trim(), "-m", "directory index").toString("ascii").trim();
    const result = exportCommunityEdition({ commit: indexed, repository, dryRun: true });
    expect(result.files).toContain(index);
    expect(result.files).not.toContain(group + "/actual.ts");
  }));

  it.each(["cts", "mts"])("rejects extensionless relative lookups of .%s", extension => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const commit = fixture(repository, {
      "packages/domain/src/cartridge-sdk-lite/index.ts": 'export * from "./leaf";',
      [`packages/domain/src/cartridge-sdk-lite/leaf.${extension}`]: "export const publicValue = 1;",
    });
    expect(() => exportCommunityEdition({ commit, repository, dryRun: true })).toThrow(/Unresolved .*\/leaf/u);
  }));

  it.each([
    ['export * from "@aistudy/ai";', /@aistudy\/ai/u],
    ['export type T = import("postgres").T;', /postgres/u],
    ['const get = (((arguments[2])["require"])); get("node:fs");', /node:fs/u],
    ['const entry = "pg"; import(entry);', /Nonliteral module/u],
    ['import transport = require("next/server"); export { transport };', /next\/server/u],
    ['import { createRequire as make } from "node:module"; make(import.meta.url)("pg");', /node:module/u],
    ['/** @type {import("drizzle-orm").T} */\nexport const value = {};', /drizzle-orm/u],
    ['/// <reference path="../../opening/cartridges/private.ts" />', /Closed or unlisted/u],
  ] as const)("rejects a private or unresolved transitive edge (%s)", (leaf, reason) => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const targetDirectory = path.join(directory, "edition");
    const commit = fixture(repository, {
      "packages/domain/src/cartridge-sdk-lite/index.ts": 'export * from "./edge.cjs";',
      "packages/domain/src/cartridge-sdk-lite/edge.cts": leaf,
      "packages/domain/opening/cartridges/private.ts": "export {};\n",
    });
    expect(() => exportCommunityEdition({ commit, repository, targetDirectory })).toThrow(reason);
    expect(existsSync(targetDirectory)).toBe(false);
    expect(readdirSync(directory)).toEqual(["source"]);
  }));

  it("checks every condition and each matching versioned declaration", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const targetDirectory = path.join(directory, "edition");
    const owner = "packages/jingwei";
    const manifest = { name: "@aistudy/jingwei", license: "UNLICENSED", version: "0.0.0", type: "module",
      exports: { ".": "./src/index.ts", "./react": "./src/react/index.ts" },
      imports: { "#helper": { default: "./src/helper.ts", browser: "./src/browser.ts" } },
      typesVersions: { ">=5": { "src/index": ["src/versioned.d.ts"] } },
    };
    const extras = {
      [`${owner}/package.json`]: print(manifest),
      [`${owner}/src/index.ts`]: 'export * from "#helper";\n',
      [`${owner}/src/helper.ts`]: "export {};\n",
      [`${owner}/src/browser.ts`]: 'import "node:crypto";\n',
      [`${owner}/src/versioned.d.ts`]: 'export type T = import("server-only").T;\n',
    };
    const importCommit = fixture(repository, extras);
    expect(() => exportCommunityEdition({ commit: importCommit, repository, targetDirectory })).toThrow(/node:crypto/u);
    write(repository, `${owner}/src/browser.ts`, "export {};\n");
    git(repository, "add", "--", `${owner}/src/browser.ts`);
    const versionCommit = git(repository, "commit-tree", git(repository, "write-tree").toString("ascii").trim(), "-m", "version candidate").toString("ascii").trim();
    expect(() => exportCommunityEdition({ commit: versionCommit, repository, targetDirectory })).toThrow(/server-only/u);
    expect(existsSync(targetDirectory)).toBe(false);
  }));

  it("reports unavailable capabilities", () => {
    expect(queryCartridgeLiteCapability("L1", "exact_text")).toEqual({ status: "available" });
    expect(queryCartridgeLiteCapability("L2", "SeededRecipe")).toEqual({ status: "unavailable" });
    for (const level of ["L3", "L4"]) expect(queryCartridgeLiteCapability(level)).toEqual({ status: "unsupported_level" });
  });
});
