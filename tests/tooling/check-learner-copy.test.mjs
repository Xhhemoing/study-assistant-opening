import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scanner = fileURLToPath(new URL("../../scripts/check-learner-copy.mjs", import.meta.url));
function fixture(t, files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "learner-copy-"));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); rmSync(root, { recursive: true, force: true }); });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content, "utf8");
  }
  return root;
}
function scan(root, ...args) {
  return spawnSync(process.execPath, [scanner, ...args, root], { encoding: "utf8" });
}

test("strict mode detects each new learner jargon term", t => {
  const words = ["无每", "推断", "生效层", "优先层", "资格", "影子"];
  const root = fixture(t, { "view.tsx": words.map(word => `const value${words.indexOf(word)} = "${word}";`).join("\n") });
  const result = scan(root, "--strict", "--json");
  assert.equal(result.status, 1, result.stderr);
  const hits = JSON.parse(result.stdout);
  assert.deepEqual(hits.flatMap(hit => hit.terms), words);
  assert.deepEqual(hits.map(hit => hit.line), [1, 2, 3, 4, 5, 6]);
});

test("finds multiline JSX and both static sides of interpolated templates", t => {
  const root = fixture(t, { "view.tsx": [
    "const copy = <div>", "  无每 N 分钟必问控件；无停留时间卡住推断。", "</div>;",
    "const template = `", "资格：${count}", "影子记录", "`;",
    "const fragments = `生效层 ${name} 优先层`;",
  ].join("\n") });
  const result = scan(root, "--strict", "--json");
  assert.equal(result.status, 1, result.stderr);
  const hits = JSON.parse(result.stdout);
  assert.deepEqual([...new Set(hits.flatMap(hit => hit.terms))].sort(), ["无每", "推断", "资格", "影子", "生效层", "优先层"].sort());
  assert.ok(hits.some(hit => hit.line === 2 && hit.terms.includes("推断")));
  assert.ok(hits.some(hit => hit.line === 6 && hit.terms.includes("影子")));
});

test("only genuine same-line comments with a nonempty reason suppress copy findings", t => {
  const root = fixture(t, { "view.tsx": [
    'const saved = "核验旧问题"; // learner-copy-ignore: legacy header kept for saved questions',
    'const bare = "核验学习内容"; // learner-copy-ignore',
    'const empty = "核验学习内容"; // learner-copy-ignore:   ',
    'const fake = "核验 learner-copy-ignore: this is displayed text";',
    'const comments = <div>{/* learner-copy-ignore: explicit diagnostic copy */}核验设置</div>;',
  ].join("\n") });
  const result = scan(root, "--strict", "--json");
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).map(hit => hit.line), [2, 3, 4]);
});

test("ignores comments and excludes API, server, service, test and private tooling files", t => {
  const root = fixture(t, {
    "view.tsx": '// 核验内容\n/* 多行\n"核验内容"\n*/\nconst safe = "开始学习";',
    "api/route.ts": 'const text = "核验接口";',
    "features/server/load.ts": 'const text = "核验结果";',
    "features/course-service.ts": 'const text = "核验结果";',
    "features/view.test.tsx": 'const text = "核验结果";',
    "features/view.spec.ts": 'const text = "核验结果";',
    "features/__tests__/fixture.tsx": 'const text = "核验结果";',
    "node_modules/example/index.ts": 'const text = "核验结果";',
    "features/opening/v3/shell/features.ts": 'const text = "核验设置";',
  });
  const result = scan(root, "--strict", "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
  const direct = scan(path.join(root, "api/route.ts"), "--strict", "--json");
  assert.equal(direct.status, 0, direct.stderr);
  assert.deepEqual(JSON.parse(direct.stdout), []);
});

test("keeps report-only text output, JSON, explicit file targets and existing ASCII checks", t => {
  const root = fixture(t, { "view.tsx": 'const text = "学习 workspace";' });
  const result = scan(path.join(root, "view.tsx"));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /view\.tsx:1\s+\[workspace\]/);
  assert.match(result.stdout, /1 learner-copy findings/);
  const strict = scan(path.join(root, "view.tsx"), "--strict", "--json");
  assert.equal(strict.status, 1, strict.stderr);
  assert.deepEqual(JSON.parse(strict.stdout)[0].terms, ["workspace"]);
});

test("preserves ASCII jargon checks across interpolated template text without scanning expression identifiers", t => {
  const root = fixture(t, { "view.tsx": [
    'const unsafe = `开始学习 ${name} workspace`;',
    'const safe = `开始学习 ${schema} 已准备`;',
  ].join("\n") });
  const result = scan(root, "--strict", "--json");
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).map(hit => ({ line: hit.line, terms: hit.terms })), [{ line: 1, terms: ["workspace"] }]);
});
