import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportCommunityEdition, queryCartridgeLiteCapability } from "../../scripts/export-community-edition";

const repo = process.cwd();
const localTemp = path.join(repo, ".local", "tmp");

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

function write(root: string, file: string, content: string): void {
  const output = path.join(root, file);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, content, "utf8");
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
  write(root, "package-lock.json", print({ lockfileVersion: 3, packages: {} }));
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
    expect(() => exportCommunityEdition({ commit, repository: repo, targetDirectory })).toThrow(/new or empty/u);
  }), 30_000);

  it("uses committed bytes and ignores unlisted and modified working-tree files", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const targetDirectory = path.join(directory, "edition");
    const candidate = "packages/domain/src/cartridge-sdk-lite/index.ts";
    const commit = fixture(repository, { "packages/domain/src/cartridge-sdk-lite/nonentry.ts": 'require("pg");\n' });
    write(repository, candidate, 'import "@aistudy/ai";\n');
    mkdirSync(targetDirectory);
    const result = exportCommunityEdition({ commit, repository, targetDirectory });
    expect(result.files).not.toContain("packages/domain/src/cartridge-sdk-lite/nonentry.ts");
    expect(readFileSync(path.join(targetDirectory, candidate), "utf8")).toBe("export {};\n");
  }));

  it.each([
    ['export * from "./edge";', 'export * from "@aistudy/ai";', /@aistudy\/ai/u],
    ['export * from "./edge";', 'export type T = import("postgres").T;', /postgres/u],
    ['export * from "./edge";', 'const get = (((arguments[2])["require"])); get("node:fs");', /node:fs/u],
    ['export * from "./edge";', 'const entry = "pg"; import(entry);', /Nonliteral module/u],
    ['export * from "./edge";', 'import transport = require("next/server"); export { transport };', /next\/server/u],
    ['export * from "./edge";', 'import { createRequire as make } from "node:module"; make(import.meta.url)("pg");', /node:module/u],
    ['export * from "./edge";', '/** @type {import("drizzle-orm").T} */\nexport const value = {};', /drizzle-orm/u],
    ['export * from "./edge";', '/// <reference path="../../opening/cartridges/private.ts" />', /Closed or unlisted/u],
  ] as const)("rejects a private or unresolved transitive edge (%s, %s)", (index, leaf, reason) => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const targetDirectory = path.join(directory, "edition");
    const commit = fixture(repository, {
      "packages/domain/src/cartridge-sdk-lite/index.ts": index,
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
