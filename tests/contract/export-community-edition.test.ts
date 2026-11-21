import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { readModuleEdges } from "../../scripts/community-edition/module-edges";
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
const bundlerOptions: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, resolveJsonModule: true, allowArbitraryExtensions: true,
};
const resolveBundler = (spec: string, from: string, mode: ts.ResolutionMode = ts.ModuleKind.ESNext, host = ts.sys as ts.ModuleResolutionHost) =>
  ts.resolveModuleName(spec, from, bundlerOptions, host, undefined, undefined, mode)
    .resolvedModule?.resolvedFileName;
const sdkEntry = "packages/domain/src/cartridge-sdk-lite/index.ts";
const sdkDirectory = path.posix.dirname(sdkEntry);
const domainManifest = (imports: Record<string, unknown>) => print({
  name: "@aistudy/domain", license: "UNLICENSED", version: "0.0.0", type: "module",
  exports: { "./native": "./src/portability/native/index.ts", "./cartridge-sdk-lite": "./src/cartridge-sdk-lite/index.ts" },
  imports,
});

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
  const source = entrypoints.map((spec, index) => `export * as entry${index} from ${JSON.stringify(spec)};`).join("\n");
  write(directory, "consumer.ts", source);
  const compiler = spawnSync(process.execPath, [path.join(directory, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict",
    "--noUncheckedIndexedAccess", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler",
    "--jsx", "react-jsx", "--types", "node,react,react-dom", "--typeRoots", "./node_modules/@types", "--pretty", "false",
    "--listFiles", "consumer.ts"], options);
  expect(compiler.error).toBeUndefined();
  const paths = compiler.stdout.trim().split(/\r?\n/u);
  const diagnostics = paths.filter(line => /\bTS\d+:/u.test(line));
  expect(compiler.status, [...diagnostics, compiler.stderr].join("\n")).toBe(0);
  expect(diagnostics).toEqual([]);

  const compilerOptions: ts.CompilerOptions = {
    ...bundlerOptions, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    strict: true, noUncheckedIndexedAccess: true, noEmit: true,
    types: ["node", "react", "react-dom"], typeRoots: [path.join(directory, "node_modules/@types")],
  };
  const entry = path.join(directory, "memory-consumer.ts");
  const host = ts.createCompilerHost(compilerOptions);
  const getSourceFile = host.getSourceFile;
  host.getCurrentDirectory = () => directory;
  host.getDefaultLibLocation = () => path.join(directory, "node_modules/typescript/lib");
  host.getDefaultLibFileName = settings => path.join(host.getDefaultLibLocation!(), ts.getDefaultLibFileName(settings));
  host.getSourceFile = (file, target, onError, fresh) => path.normalize(file) === entry
    ? ts.createSourceFile(file, source, target) : getSourceFile(file, target, onError, fresh);
  const program = ts.createProgram([entry], compilerOptions, host);
  expect(ts.getPreEmitDiagnostics(program).map(diagnostic => diagnostic.messageText)).toEqual([]);
  for (const file of [...paths, ...program.getSourceFiles().map(sourceFile => sourceFile.fileName)]) {
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
      "packages/domain/package.json": domainManifest({ "#helper": target }),
      [sdkEntry]: 'export * from "#helper";',
      "packages/domain/src/cartridge-sdk-lite/helper.ts": "export const publicValue = 1;",
    });
    expect(() => exportCommunityEdition({ commit, repository, dryRun: true })).toThrow(/Package import must name an exact source file/u);
  }));

  it.each([
    ["main", "entry"], ["types", "entry"], ["typings", "entry"], ["module", "index"], ["exports", "index"],
  ])("rejects a relative directory governed by %s and preserves explicit file resolution", (field, selected) => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const group = sdkDirectory + "/group";
    const extras = {
      [sdkEntry]: 'export * from "./group";',
      [group + "/package.json"]: print({ [field]: "./entry.js" }),
      [group + "/entry.ts"]: "export const publicValue = 1;",
      [group + "/index.ts"]: "export const publicValue = 2;",
    };
    const commit = fixture(repository, extras);
    const from = path.join(repository, sdkEntry);
    expect(path.normalize(resolveBundler("./group", from)!)).toBe(path.join(repository, group, selected + ".ts"));
    expect(() => exportCommunityEdition({ commit, repository, dryRun: true })).toThrow(/relative directory.*package\.json/iu);
    write(repository, sdkEntry, 'export * from "./group/entry.js";');
    git(repository, "add", "--", sdkEntry);
    const explicit = git(repository, "commit-tree", git(repository, "write-tree").toString("ascii").trim(), "-m", "explicit file").toString("ascii").trim();
    const targetDirectory = path.join(directory, "edition");
    const result = exportCommunityEdition({ commit: explicit, repository, targetDirectory });
    const resolved = resolveBundler("./group/entry.js", path.join(targetDirectory, sdkEntry));
    expect(path.normalize(resolved!)).toBe(path.join(targetDirectory, group, "entry.ts"));
    expect(result.files).toContain(group + "/entry.ts");
    expect(result.files).not.toContain(group + "/index.ts");
  }));

  it.each([
    ['import { x } from "#foo"; export { x };', { worker: "./src/cartridge-sdk-lite/foo.ts" }, /active type target/u],
    ['import type { X } from "#foo"; export type { X };', { deno: "./src/cartridge-sdk-lite/foo.ts" }, /active type target/u],
    ['import { x } from "#foo"; export { x };', { types: "./src/cartridge-sdk-lite/foo.d.ts" }, /active runtime target/u],
    ['export * from "#foo";', "./src/cartridge-sdk-lite/foo.d.mts", /no runtime source/u],
    ['export { x } from "#foo";', "./src/cartridge-sdk-lite/foo.d.cts", /no runtime source/u],
    ['void import("#foo");', { types: "./src/cartridge-sdk-lite/foo.d.ts" }, /active runtime target/u],
    ['import "#foo";', { types: "./src/cartridge-sdk-lite/foo.d.ts" }, /active runtime target/u],
    ['require("#foo");', { types: "./src/cartridge-sdk-lite/foo.d.ts" }, /require.*ESM/u],
    ['import { type X } from "#foo";', { types: "./src/cartridge-sdk-lite/foo.d.ts" }, /active runtime target/u],
    ['export { type X } from "#foo";', { types: "./src/cartridge-sdk-lite/foo.d.ts" }, /active runtime target/u],
  ] as const)("rejects package imports without the target needed by %s", (source, mapping, reason) => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const commit = fixture(repository, {
      "packages/domain/package.json": domainManifest({ "#foo": mapping }),
      [sdkEntry]: source,
      [sdkDirectory + "/foo.ts"]: "export const x = 1; export type X = string;",
      ...Object.fromEntries([".d.ts", ".d.mts", ".d.cts"].map(ext => [
        sdkDirectory + "/foo" + ext, "export declare const x: number; export type X = string;",
      ])),
    });
    expect(() => exportCommunityEdition({ commit, repository, dryRun: true })).toThrow(reason);
  }));

  it.each([
    [{ "custom-inactive": "./src/index.ts" }, /active type target/u],
    [{ types: "./src/index.ts" }, /active runtime target/u],
    [{ "types@>=5": "./src/types.ts", default: "./src/index.ts" }, /unsupported versioned types condition/iu],
  ] as const)("requires active type and runtime targets for public workspace exports", (mapping, reason) => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const commit = fixture(repository, {
      "packages/ui/package.json": print({
        name: "@aistudy/ui", license: "UNLICENSED", version: "0.0.0", type: "module", exports: { ".": mapping },
      }),
      "packages/ui/src/types.ts": "export type Example = string;",
    });
    expect(() => exportCommunityEdition({ commit, repository, dryRun: true })).toThrow(reason);
  }));

  it("allows type-only syntax and preserves first-match conditional order", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const from = path.join(repository, sdkEntry);
    const typeTarget = "./src/cartridge-sdk-lite/only-types.d.ts";
    const runtimeTarget = "./src/cartridge-sdk-lite/runtime.ts";
    const actual = sdkDirectory + "/runtime.ts";
    const commit = fixture(repository, {
      "packages/domain/package.json": domainManifest({
        "#type": { types: typeTarget },
        "#ordered": { worker: "./src/private.ts", default: runtimeTarget, types: typeTarget, import: "./src/shadowed.ts" },
      }),
      [sdkEntry]: [
        'import type { X } from "#type";',
        'import type { X as Y } from "#type";',
        'export type { X as Z } from "#type";',
        'export * from "#ordered";',
        'import { type x } from "#ordered";',
        'export type { X, Y };',
      ].join("\n"),
      [sdkDirectory + "/only-types.d.ts"]: "export type X = string;",
      [actual]: "export const x = 1;",
      "packages/domain/src/private.ts": 'import "@aistudy/ai";',
      "packages/domain/src/shadowed.ts": 'import "@aistudy/ai";',
    });
    expect(path.normalize(resolveBundler("#ordered", from)!)).toBe(path.join(repository, actual));
    const targetDirectory = path.join(directory, "edition");
    const result = exportCommunityEdition({ commit, repository, targetDirectory });
    expect(result.files).not.toContain("packages/domain/src/private.ts");
    expect(result.files).not.toContain("packages/domain/src/shadowed.ts");
    const generated = JSON.parse(readFileSync(path.join(targetDirectory, "packages/domain/package.json"), "utf8"));
    expect(generated.imports["#type"]).toEqual({ import: { types: typeTarget } });
    expect(generated.imports["#ordered"]).toEqual({ import: { types: runtimeTarget, default: runtimeTarget } });
    for (const spec of ["#type", "#ordered"]) {
      const after = resolveBundler(spec, path.join(targetDirectory, sdkEntry));
      expect(path.relative(targetDirectory, after!)).toBe(path.relative(repository, resolveBundler(spec, from)!));
    }
  }));

  it("selects a typed workspace export after an untyped earlier JS branch", () => inLocalTemp(directory => {
    const owner = "packages/ui";
    const spec = "@aistudy/ui";
    const manifest = {
      name: spec, license: "UNLICENSED", version: "0.0.0", type: "module",
      exports: { import: "./src/jsentry.js", types: "./src/api.d.ts" },
    };
    const virtual = new Map([
      ["/ui/package.json", print(manifest)],
      ["/ui/src/jsentry.js", "export const x = 1;"],
      ["/ui/src/api.d.ts", "export declare const x: number;"],
    ]);
    const host: ts.ModuleResolutionHost = {
      fileExists: file => virtual.has(file), readFile: file => virtual.get(file), getCurrentDirectory: () => "/",
    };
    expect(ts.version).toBe("5.8.3");
    expect(resolveBundler(spec, "/ui/consumer.ts", ts.ModuleKind.ESNext, host)).toBe("/ui/src/api.d.ts");
    const repository = path.join(directory, "source");
    const commit = fixture(repository, Object.fromEntries([...virtual].map(([file, contents]) => [owner + file.slice(3), contents])));
    const targetDirectory = path.join(directory, "edition");
    const result = exportCommunityEdition({ commit, repository, targetDirectory });
    expect(result.files).toEqual(expect.arrayContaining([owner + "/src/api.d.ts", owner + "/src/jsentry.js"]));
    const consumer = owner + "/consumer.ts";
    write(targetDirectory, consumer, 'import { x } from "@aistudy/ui"; export const n: number = x;');
    const entry = path.join(targetDirectory, consumer);
    expect(path.normalize(resolveBundler(spec, entry)!)).toBe(path.join(targetDirectory, owner, "src/api.d.ts"));
    const program = ts.createProgram([entry], { ...bundlerOptions, strict: true, noEmit: true, types: [] });
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => diagnostic.messageText)).toEqual([]);
  }));

  it.each([
    ["js", "export const x = 1;"], ["json", '{ "x": 1 }'],
  ])("rejects a public .%s target without a declaration", (extension, contents) => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const commit = fixture(repository, {
      "packages/ui/package.json": print({
        name: "@aistudy/ui", license: "UNLICENSED", version: "0.0.0", type: "module", exports: { import: "./src/entry." + extension },
      }),
      ["packages/ui/src/entry." + extension]: contents,
    });
    expect(() => exportCommunityEdition({ commit, repository, dryRun: true })).toThrow(/active type target/u);
  }));

  it("gives an exported internal alias both its JavaScript runtime and its declared type", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const runtime = sdkDirectory + "/jsentry.js";
    const declaration = sdkDirectory + "/api.d.ts";
    const commit = fixture(repository, {
      "packages/domain/package.json": domainManifest({
        "#api": { import: "./src/cartridge-sdk-lite/jsentry.js", types: "./src/cartridge-sdk-lite/api.d.ts" },
      }),
      [sdkEntry]: 'import { x } from "#api"; export const n: number = x;',
      [runtime]: "export const x = 1;",
      [declaration]: "export declare const x: number;",
    });
    const targetDirectory = path.join(directory, "edition");
    const result = exportCommunityEdition({ commit, repository, targetDirectory });
    expect(result.files).toEqual(expect.arrayContaining([runtime, declaration]));
    const entry = path.join(targetDirectory, sdkEntry);
    expect(path.normalize(resolveBundler("#api", entry)!)).toBe(path.join(targetDirectory, declaration));
    const program = ts.createProgram([entry], { ...bundlerOptions, strict: true, noEmit: true, types: [] });
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => diagnostic.messageText)).toEqual([]);
  }));

  it("records resolution modes and keeps inline type specifiers as runtime edges", () => {
    const text = [
      'import type { A } from "#override" with { "resolution-mode": "import" };',
      'import { type B } from "#inline-import";',
      'export { type C } from "#inline-export";',
      'import D = require("#equals");',
      'const load = require; load("#alias");',
      'void import("#dynamic");',
      'type E = import("#type-query", { with: { "resolution-mode": "require" } }).E;',
    ].join("\n");
    expect(readModuleEdges("modes.cts", text).map(({ spec, kind, mode }) => [spec, kind, mode])).toEqual([
      ["#override", "type", "import"], ["#inline-import", "module", "require"], ["#inline-export", "module", "require"],
      ["#equals", "module", "require"], ["#alias", "module", "require"], ["#dynamic", "module", "import"],
      ["#type-query", "type", "require"],
    ]);
    const options = { ...bundlerOptions, verbatimModuleSyntax: true };
    const emit = ts.transpileModule('import { type B } from "#inline-import";', { compilerOptions: options }).outputText;
    expect(emit).toMatch(/import\s+\{\s*\}\s+from\s+["']#inline-import["']/u);
  });

  it("applies the ImportTypeNode resolution-mode override in an ESM file", () => {
    const source = 'type T = import("#mode", { with: { "resolution-mode": "require" } }).Value;';
    expect(readModuleEdges("test.mts", source)).toEqual([{ spec: "#mode", line: 1, mode: "require", kind: "type" }]);
  });

  it.each([".d.ts", ".d.mts", ".d.cts", ".d.css.ts"])("treats every static declaration-file edge as type-only in %s", extension => {
    const source = 'import { type Shape } from "#shape"; export { Shape } from "#shape"; import "#shape";';
    expect(readModuleEdges("api" + extension, source).map(edge => edge.kind)).toEqual(["type", "type", "type"]);
  });

  it("keeps ESM imports and ignores lexically local require bindings", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const runtime = sdkDirectory + "/format.ts";
    const commit = fixture(repository, {
      "packages/domain/package.json": domainManifest({ "#format": {
        import: "./src/cartridge-sdk-lite/format.ts", require: "./src/private.cjs",
      } }),
      [sdkEntry]: [
        'export { esm } from "#format";',
        'export function param(require: (name: string) => unknown) { return require("#format"); }',
        'export function variable() { const require = (name: string) => name; return require("#local"); }',
        'export function nested() { function require(name: string) { return name; } return require("#local"); }',
        'export { other } from "./binding";',
      ].join("\n"),
      [sdkDirectory + "/binding.ts"]: 'import { require } from "./local"; export const other = require("#local");',
      [sdkDirectory + "/local.ts"]: "export const require = (name: string) => name;",
      [runtime]: "export const esm = true;",
    });
    const targetDirectory = path.join(directory, "edition");
    const result = exportCommunityEdition({ commit, repository, targetDirectory });
    expect(result.files).toContain(runtime);
    const generated = JSON.parse(readFileSync(path.join(targetDirectory, "packages/domain/package.json"), "utf8"));
    expect(generated.imports).toEqual({ "#format": { import: { types: "./src/cartridge-sdk-lite/format.ts", default: "./src/cartridge-sdk-lite/format.ts" } } });
  }));

  it("recognizes a lexically bound createRequire loader", () => {
    const source = 'import { createRequire as makeRequire } from "node:module"; const require = makeRequire(import.meta.url); require("#format");';
    expect(readModuleEdges("test.mts", source)).toEqual([
      { spec: "node:module", line: 1, kind: "module", mode: "import" },
      { spec: "#format", line: 1, kind: "module", mode: "require" },
    ]);
  });

  it("distinguishes ESM ambient declarations from a CommonJS wrapper binding", () => {
    const ambient = 'declare const require: (name: string) => unknown; require("#format");';
    expect(() => readModuleEdges("test.ts", ambient, "module")).toThrow(/Ambient require.*ESM/u);
    const wrapper = 'var require; require("#format");';
    expect(readModuleEdges("test.cjs", wrapper)).toEqual([{ spec: "#format", line: 1, kind: "module", mode: "require" }]);
  });

  it("retains mode-specific runtime and declaration files for ESM and CommonJS aliases", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const commit = fixture(repository, {
      "packages/domain/package.json": domainManifest({
        "#format": {
          import: { types: "./src/cartridge-sdk-lite/format.d.mts", default: "./src/cartridge-sdk-lite/format.mjs" },
          require: { types: "./src/cartridge-sdk-lite/format.d.cts", default: "./src/cartridge-sdk-lite/format.cjs" },
        },
      }),
      [sdkEntry]: 'export { es } from "#format"; import "./consume.cjs";',
      [sdkDirectory + "/consume.cjs"]: 'module.exports = require("#format");',
      [sdkDirectory + "/format.mjs"]: "export const es = 1;",
      [sdkDirectory + "/format.d.mts"]: "export declare const es: number;",
      [sdkDirectory + "/format.cjs"]: "module.exports = { common: 2 };",
      [sdkDirectory + "/format.d.cts"]: "export declare const common: number;",
    });
    const targetDirectory = path.join(directory, "edition");
    const result = exportCommunityEdition({ commit, repository, targetDirectory });
    for (const ext of [".mjs", ".d.mts", ".cjs", ".d.cts"]) expect(result.files).toContain(sdkDirectory + "/format" + ext);
    const generated = JSON.parse(readFileSync(path.join(targetDirectory, "packages/domain/package.json"), "utf8"));
    expect(generated.imports["#format"]).toEqual({
      import: { types: "./src/cartridge-sdk-lite/format.d.mts", default: "./src/cartridge-sdk-lite/format.mjs" },
      require: { types: "./src/cartridge-sdk-lite/format.d.cts", default: "./src/cartridge-sdk-lite/format.cjs" },
    });
    for (const [mode, ext] of [[ts.ModuleKind.ESNext, ".d.mts"], [ts.ModuleKind.CommonJS, ".d.cts"]] as const) {
      for (const root of [repository, targetDirectory]) {
        expect(path.normalize(resolveBundler("#format", path.join(root, sdkEntry), mode)!))
          .toBe(path.join(root, sdkDirectory, "format" + ext));
      }
    }
    const entry = path.join(targetDirectory, sdkDirectory, "consume.cjs");
    const load = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(require(process.argv[1])))", entry], { encoding: "utf8" });
    expect(load.status, load.stderr).toBe(0);
    expect(JSON.parse(load.stdout)).toEqual({ common: 2 });
  }));

  it.each(["imports", "exports"])("preserves Node and Bundler selections in ordered %s", field => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const owner = field === "imports" ? "packages/domain" : "packages/ui";
    const source = field === "imports" ? sdkDirectory : owner + "/src";
    const spec = field === "imports" ? "#mode" : "@aistudy/ui";
    const relative = "./" + path.posix.relative(owner, source);
    const map = { import: relative + "/mode.mjs", node: relative + "/node.cjs", require: relative + "/fallback.cjs" };
    const manifest = field === "imports" ? domainManifest({ [spec]: map })
      : print({ name: spec, version: "0.0.0", license: "UNLICENSED", type: "module", exports: map });
    const commit = fixture(repository, {
      [owner + "/package.json"]: manifest,
      ...(field === "imports" ? { [sdkEntry]: 'import "#mode"; import "./use.cjs";', [sdkDirectory + "/use.cjs"]: 'require("#mode");' } : {}),
      [source + "/mode.mjs"]: 'export const mode = "esm";',
      [source + "/mode.d.mts"]: 'export declare const mode: "esm";',
      [source + "/node.cjs"]: 'exports.mode = "node";',
      [source + "/node.d.cts"]: 'export declare const mode: "node";',
      [source + "/fallback.cjs"]: 'exports.mode = "bundler";',
      [source + "/fallback.d.cts"]: 'export declare const mode: "bundler";',
    });
    const targetDirectory = path.join(directory, "edition");
    const result = exportCommunityEdition({ commit, repository, targetDirectory });
    for (const file of ["mode.mjs", "mode.d.mts", "node.cjs", "node.d.cts", "fallback.cjs", "fallback.d.cts"]) {
      expect(result.files).toContain(source + "/" + file);
    }
    const output = JSON.parse(readFileSync(path.join(targetDirectory, owner, "package.json"), "utf8"));
    const mapping = field === "imports" ? output.imports[spec] : output.exports["."];
    expect(Object.keys(mapping).filter(key => key !== "types")).toEqual(["import", "node", "require"]);
    for (const root of [repository, targetDirectory]) {
      const cwd = path.join(root, owner);
      const commands = [
        ["commonjs", "process.stdout.write(require(" + JSON.stringify(spec) + ").mode)", "node"],
        ["module", "import { mode } from " + JSON.stringify(spec) + "; process.stdout.write(mode)", "esm"],
      ];
      for (const [mode, script, selected] of commands) {
        const child = spawnSync(process.execPath, ["--input-type=" + mode, "-e", script!], { cwd, encoding: "utf8" });
        expect(child.status, child.stderr).toBe(0);
        expect(child.stdout).toBe(selected);
      }
      expect(path.normalize(resolveBundler(spec, path.join(root, owner, "use.cts"), ts.ModuleKind.CommonJS)!))
        .toBe(path.join(root, source, "fallback.d.cts"));
    }
  }));

  it("rejects a CommonJS value edge into an import-only alias", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const commit = fixture(repository, {
      "packages/domain/package.json": domainManifest({
        "#format": { types: "./src/cartridge-sdk-lite/format.d.ts", import: "./src/cartridge-sdk-lite/format.mjs" },
      }),
      [sdkEntry]: 'import "./consume.cjs";',
      [sdkDirectory + "/consume.cjs"]: 'module.exports = require("#format");',
      [sdkDirectory + "/format.mjs"]: "export const es = 1;",
      [sdkDirectory + "/format.d.ts"]: "export declare const es: number;",
    });
    expect(() => exportCommunityEdition({ commit, repository, dryRun: true })).toThrow(/require.*active runtime target|active runtime target.*require/u);
  }));

  it("validates and retains CommonJS branches of workspace exports", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const commit = fixture(repository, {
      "packages/ui/package.json": print({
        name: "@aistudy/ui", license: "UNLICENSED", version: "0.0.0", type: "module",
        exports: { import: "./src/index.ts", require: "./src/common.cjs" },
      }),
      "packages/ui/src/common.cjs": "module.exports = { common: 1 };",
      "packages/ui/src/common.d.cts": "export declare const common: number;",
    });
    const targetDirectory = path.join(directory, "edition");
    const result = exportCommunityEdition({ commit, repository, targetDirectory });
    expect(result.files).toEqual(expect.arrayContaining(["packages/ui/src/common.cjs", "packages/ui/src/common.d.cts"]));
    const from = path.join(targetDirectory, "packages/ui/use.cts");
    expect(path.normalize(resolveBundler("@aistudy/ui", from, ts.ModuleKind.CommonJS)!))
      .toBe(path.join(targetDirectory, "packages/ui/src/common.d.cts"));
    const requireSelf = spawnSync(process.execPath, ["-e", 'process.stdout.write(JSON.stringify(require("@aistudy/ui")))'], {
      cwd: path.dirname(from), encoding: "utf8",
    });
    expect(requireSelf.status, requireSelf.stderr).toBe(0);
    expect(JSON.parse(requireSelf.stdout)).toEqual({ common: 1 });
  }));

  it.each(["require", "node"])("rejects an unreferenced public %s branch with a missing target", condition => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const commit = fixture(repository, {
      "packages/ui/package.json": print({
        name: "@aistudy/ui", license: "UNLICENSED", version: "0.0.0", type: "module",
        exports: { import: "./src/index.ts", [condition]: "./src/missing.cjs" },
      }),
    });
    expect(() => exportCommunityEdition({ commit, repository, dryRun: true })).toThrow(/require|missing\.cjs/u);
  }));

  it("retains a Node-only public CommonJS branch for external consumers", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const commit = fixture(repository, {
      "packages/ui/package.json": print({
        name: "@aistudy/ui", license: "UNLICENSED", version: "0.0.0", type: "module",
        exports: { import: "./src/index.ts", node: "./src/compat.cjs" },
      }),
      "packages/ui/src/compat.cjs": "exports.ok = true;",
      "packages/ui/src/compat.d.cts": "export declare const ok: true;",
    });
    const targetDirectory = path.join(directory, "edition");
    const result = exportCommunityEdition({ commit, repository, targetDirectory });
    expect(result.files).toContain("packages/ui/src/compat.cjs");
    const child = spawnSync(process.execPath, ["-p", 'require("@aistudy/ui").ok'], {
      cwd: path.join(targetDirectory, "packages/ui"), encoding: "utf8",
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe("true");
  }));

  it.each(["#data/*.json", "#data/*"])("exports and compiles explicit JSON through %s", pattern => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const json = sdkDirectory + "/data/config.json";
    const commit = fixture(repository, {
      "packages/domain/package.json": domainManifest({
        [pattern]: "./src/cartridge-sdk-lite/data/" + (pattern.endsWith(".json") ? "*.json" : "*"),
      }),
      [sdkEntry]: 'import config from "#data/config.json"; export const enabled: boolean = config.enabled;',
      [json]: '{ "enabled": true }\n',
      [sdkDirectory + "/data/unreferenced.json"]: '{ "enabled": false }\n',
    });
    const targetDirectory = path.join(directory, "edition");
    const result = exportCommunityEdition({ commit, repository, targetDirectory });
    const from = path.join(targetDirectory, sdkEntry);
    expect(result.files).toContain(json);
    expect(result.files).not.toContain(sdkDirectory + "/data/unreferenced.json");
    expect(readFileSync(path.join(targetDirectory, json))).toEqual(git(repository, "show", commit + ":" + json));
    expect(path.normalize(resolveBundler("#data/config.json", from)!)).toBe(path.join(targetDirectory, json));
    const program = ts.createProgram([from], { ...bundlerOptions, strict: true, noEmit: true, types: [] });
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => diagnostic.messageText)).toEqual([]);
  }));

  it.each(["#data/cfg.json", "./cfg.json"])("preserves the declaration companion for %s", spec => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const json = sdkDirectory + "/cfg.json";
    const declaration = sdkDirectory + "/cfg.d.json.ts";
    const commit = fixture(repository, {
      "packages/domain/package.json": domainManifest({ "#data/*": "./src/cartridge-sdk-lite/*" }),
      [sdkEntry]: 'import config from ' + JSON.stringify(spec) + '; export const typed: "enabled" = config.mode;',
      [json]: '{ "mode": "enabled" }\n',
      [declaration]: 'declare const config: { mode: "enabled" }; export default config;',
    });
    const targetDirectory = path.join(directory, "edition");
    const result = exportCommunityEdition({ commit, repository, targetDirectory });
    const from = path.join(targetDirectory, sdkEntry);
    expect(result.files).toEqual(expect.arrayContaining([json, declaration]));
    expect(path.normalize(resolveBundler(spec, from)!)).toBe(path.join(targetDirectory, declaration));
    const program = ts.createProgram([from], { ...bundlerOptions, strict: true, noEmit: true, types: [] });
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => diagnostic.messageText)).toEqual([]);
  }));

  it("rejects private dependencies of a JSON declaration companion", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const commit = fixture(repository, {
      [sdkEntry]: 'import "./cfg.json";',
      [sdkDirectory + "/cfg.json"]: "{}",
      [sdkDirectory + "/cfg.d.json.ts"]: 'export type T = import("server-only").T;',
    });
    expect(() => exportCommunityEdition({ commit, repository, dryRun: true })).toThrow(/server-only/u);
  }));

  it("compiles relative .jsx substitution, arbitrary declarations, and type-only declaration imports", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const commit = fixture(repository, {
      "packages/domain/package.json": domainManifest({ "#shape": { types: "./src/cartridge-sdk-lite/shape.d.ts" } }),
      [sdkEntry]: [
        'import { label } from "./leaf.jsx";', 'import css from "./card.css";', 'import icon from "./icon.svg";',
        'export const model: { title: string } = { title: label + css + icon };',
      ].join("\n"),
      [sdkDirectory + "/leaf.jsx"]: 'export const label = "fallback";',
      [sdkDirectory + "/leaf.ts"]: 'export const label: string = "typed";',
      [sdkDirectory + "/card.d.css.ts"]: 'import { type Shape } from "#shape"; declare const css: Shape; export default css;',
      [sdkDirectory + "/icon.d.svg.ts"]: 'declare const icon: string; export default icon;',
      [sdkDirectory + "/shape.d.ts"]: "export type Shape = string;",
    });
    const targetDirectory = path.join(directory, "edition");
    const result = exportCommunityEdition({ commit, repository, targetDirectory });
    for (const file of ["leaf.ts", "card.d.css.ts", "icon.d.svg.ts", "shape.d.ts"]) expect(result.files).toContain(sdkDirectory + "/" + file);
    const from = path.join(targetDirectory, sdkEntry);
    expect(path.normalize(resolveBundler("./leaf.jsx", from)!)).toBe(path.join(targetDirectory, sdkDirectory, "leaf.ts"));
    const program = ts.createProgram([from], { ...bundlerOptions, strict: true, noEmit: true, types: [] });
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => diagnostic.messageText)).toEqual([]);
  }));

  it("rejects a forbidden edge reached through an arbitrary declaration companion", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const commit = fixture(repository, {
      [sdkEntry]: 'import "./card.css";',
      [sdkDirectory + "/card.d.css.ts"]: 'export type Secret = import("@aistudy/ai").T;',
    });
    expect(() => exportCommunityEdition({ commit, repository, dryRun: true })).toThrow(/@aistudy\/ai/u);
  }));

  it("retains both JSON and its declaration in a workspace export", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const commit = fixture(repository, {
      "packages/ui/package.json": print({
        name: "@aistudy/ui", license: "UNLICENSED", version: "0.0.0", type: "module", exports: "./src/cfg.json",
      }),
      "packages/ui/src/cfg.json": '{ "mode": "enabled" }\n',
      "packages/ui/src/cfg.d.json.ts": 'declare const cfg: { mode: "enabled" }; export default cfg;',
    });
    const targetDirectory = path.join(directory, "edition");
    const result = exportCommunityEdition({ commit, repository, targetDirectory });
    expect(result.files).toEqual(expect.arrayContaining(["packages/ui/src/cfg.json", "packages/ui/src/cfg.d.json.ts"]));
    const consumer = "packages/ui/consumer.ts";
    write(targetDirectory, consumer, 'import cfg from "@aistudy/ui"; export const mode: "enabled" = cfg.mode;');
    const program = ts.createProgram([path.join(targetDirectory, consumer)], { ...bundlerOptions, strict: true, noEmit: true, types: [] });
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => diagnostic.messageText)).toEqual([]);
  }));

  it("keeps closed JSON outside the export even when a wildcard matches", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const commit = fixture(repository, {
      "packages/domain/package.json": domainManifest({ "#data/*": "./src/cartridge-sdk-lite/data/*" }),
      [sdkEntry]: 'import "#data/ai-policy.json";',
      [sdkDirectory + "/data/ai-policy.json"]: "{}",
    });
    expect(() => exportCommunityEdition({ commit, repository, dryRun: true })).toThrow(/Closed or unlisted source/u);
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

  it("checks selected conditions and each matching versioned declaration", () => inLocalTemp(directory => {
    const repository = path.join(directory, "source");
    const targetDirectory = path.join(directory, "edition");
    const owner = "packages/jingwei";
    const manifest = { name: "@aistudy/jingwei", license: "UNLICENSED", version: "0.0.0", type: "module",
      exports: { ".": "./src/index.ts", "./react": "./src/react/index.ts" },
      imports: { "#helper": { types: "./src/helper.ts", import: "./src/browser.ts", default: "./src/helper.ts" } },
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
