import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { deriveTypecheckSet, tscArgs } from "../../scripts/typecheck.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const web = path.join(root, "apps/web");
function parse(file) {
  const config = ts.readConfigFile(file, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(file));
  assert.deepEqual(parsed.errors, []);
  return parsed;
}

test("dynamic workspace discovery selects both Web projects without losing other gates", () => {
  const tasks = deriveTypecheckSet(root);
  assert.equal(tasks.length, 11);
  assert.deepEqual(tasks.filter((entry) => entry.cwd === "apps/web").map((entry) => entry.project), ["tsconfig.json", "tsconfig.tests.json"]);
  assert.deepEqual(tasks.filter((entry) => entry.cwd !== "apps/web").map((entry) => entry.name), [
    "apps/worker", "packages/ai", "packages/config", "packages/contracts", "packages/database",
    "packages/domain", "packages/jingwei", "packages/ui", "tsconfig.e2e.json",
  ]);
  for (const entry of tasks) assert.deepEqual(tscArgs(entry), ["-p", entry.project, "--noEmit"]);
});

test("project roots retain the previous Web inputs, generated types and source aliases", () => {
  const product = parse(path.join(web, "tsconfig.json"));
  const tests = parse(path.join(web, "tsconfig.tests.json"));
  const legacy = ts.readConfigFile(path.join(web, "tsconfig.json"), ts.sys.readFile).config;
  legacy.exclude = ["node_modules", "src/**/*.test.ts"];
  const previous = ts.parseJsonConfigFileContent(legacy, ts.sys, web);
  const union = new Set([...product.fileNames, ...tests.fileNames]);
  for (const file of previous.fileNames) assert.ok(union.has(file), `lost input: ${file}`);
  assert.ok(tests.fileNames.some((file) => file.endsWith(".test.ts")));
  for (const config of [product, tests]) {
    assert.ok(config.raw.include.includes(".next/types/**/*.ts"));
    assert.equal(config.options.noEmit, true);
    assert.equal(config.options.incremental, true);
    assert.deepEqual(config.options.paths, product.options.paths);
  }
  assert.notEqual(product.options.tsBuildInfoFile, tests.options.tsBuildInfoFile);
});

test("incremental project checks catch warm leaf edits and non-root imported dependency errors", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tc-projects-"));
  const put = (name, value) => {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  };
  const check = () => {
    for (const project of ["product.json", "tests.json"]) {
      const result = spawnSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), ...tscArgs({ project })], { cwd: dir, encoding: "utf8" });
      if (result.status !== 0) return result;
    }
    return { status: 0 };
  };
  try {
    for (const name of ["product", "tests"]) put(`${name}.json`, {
      compilerOptions: { strict: true, noEmit: true, incremental: true, types: [], skipLibCheck: true, tsBuildInfoFile: `${name}.tsbuildinfo`, paths: { "@dep": ["./dep/index.ts"] } },
      files: [name === "product" ? "src/index.ts" : "src/index.test.ts", ".next/types/routes.ts"],
    });
    put("dep/index.ts", "export const value: number = 1;\n");
    put("src/index.ts", "export { value } from '@dep';\n");
    put("src/index.test.ts", "import { value } from './index'; const checked: number = value;\n");
    put(".next/types/routes.ts", "export {};\n");
    assert.equal(check().status, 0);
    for (const name of ["product", "tests"]) assert.ok(existsSync(path.join(dir, `${name}.tsbuildinfo`)));
    assert.equal(check().status, 0);
    // Only a non-root source changes after both caches are warm.
    put("dep/index.ts", "export const value: number = 'wrong';\n");
    let result = check();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /dep\/index.ts/);
    assert.match(result.stdout + result.stderr, /TS2322/);
    put("dep/index.ts", "export const value: number = 1;\n");
    assert.equal(check().status, 0);
    put("src/index.test.ts", "import { value } from './index'; const checked: string = value;\n");
    result = check();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /TS2322/);
    put("src/index.test.ts", "export {};\n");
    put("dep/index.ts", "export const value: number = 'wrong';\n");
    result = check();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /dep\/index.ts/);
    put("dep/index.ts", "export const value: number = 1;\n");
    put(".next/types/routes.ts", "const route: number = 'wrong'; export {};\n");
    result = check();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /routes.ts/);
    put(".next/types/routes.ts", "export {};\n");
    assert.equal(check().status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("extra project discovery and invalid workspace metadata fail closed", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tc-discovery-"));
  const put = (name, value) => writeFileSync(path.join(dir, name), JSON.stringify(value));
  try {
    put("extra.json", { files: [] });
    put("package.json", { aistudy: { typecheck: { extraProjects: ["extra.json"] } } });
    assert.deepEqual(tscArgs(deriveTypecheckSet(dir)[0]), ["-p", "extra.json", "--noEmit"]);
    put("package.json", { aistudy: { typecheck: { extraProjects: ["missing.json"] } } });
    assert.throws(() => deriveTypecheckSet(dir), /missing typecheck project/);
    mkdirSync(path.join(dir, "apps/web"), { recursive: true });
    put("package.json", { workspaces: ["apps/*"] });
    for (const config of [{ mode: "build" }, {}, { projects: [] }, { projects: "typo" }, { projects: [null] }]) {
      put("apps/web/package.json", { scripts: { typecheck: "tsc" }, aistudy: { typecheck: config } });
      assert.throws(() => deriveTypecheckSet(dir), /invalid typecheck projects/);
    }
    put("apps/web/package.json", { scripts: { typecheck: "tsc" }, aistudy: { typecheck: { projects: ["missing.json"] } } });
    assert.throws(() => deriveTypecheckSet(dir), /missing typecheck project/);
    put("apps/web/package.json", { scripts: { typecheck: "tsc" } });
    assert.throws(() => deriveTypecheckSet(dir), /missing typecheck project/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
