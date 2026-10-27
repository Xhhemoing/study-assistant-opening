import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = fileURLToPath(new URL("../../scripts/check-api-contracts.mjs", import.meta.url));
function fixture(t, client) {
  const tempRoot = path.resolve(tmpdir());
  const root = mkdtempSync(path.join(tempRoot, "aistudy-api 空间-"));
  t.after(() => {
    const relative = path.relative(tempRoot, root);
    assert.ok(!path.isAbsolute(relative) && !relative.startsWith("..") && relative.startsWith("aistudy-api 空间-"));
    rmSync(root, { recursive: true, force: true });
  });
  const write = (file, text) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  };
  write("scripts/check-api-contracts.mjs", "");
  copyFileSync(checker, path.join(root, "scripts/check-api-contracts.mjs"));
  write("apps/web/src/app/api/items/special/route.ts", `
    export async function GET() {}
    const serverOnly = "/api/not-a-client-request";
  `);
  write("apps/web/src/app/api/items/[id]/route.ts", "export const POST = async () => {};");
  write("apps/web/src/app/(opening)/opening/library/page.tsx", 'export default function Page() { return <a href="/opening/library">Library</a>; }');
  write("apps/web/src/features/client.ts", client);
  return path.join(root, "scripts/check-api-contracts.mjs");
}
function run(script, ...args) {
  // Resolve from the script, not the caller's cwd. The fixture path is URL-encoded.
  return spawnSync(process.execPath, [script, "--json", ...args], { cwd: tmpdir(), encoding: "utf8" });
}

test("scans real routes, grouped pages, and clients from a space/unicode script path", t => {
  const script = fixture(t, `
    fetch("/api/items/special", { method: "GET" });
    fetch(\`/api/items/\${id}\`, { method: "POST" });
  `);
  const result = run(script, "--strict");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { routes: 2, pages: 1, findings: [] });
});

test("strict mode reports scanned client errors and prefers static routes over dynamic ones", t => {
  const script = fixture(t, `
    fetch("/api/missing", { method: "GET" });
    fetch("/api/items/special", { method: "POST" });
    const link = { href: "/opening/missing" };
  `);
  const result = run(script, "--strict");
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.routes, 2);
  assert.equal(report.pages, 1);
  assert.deepEqual(report.findings.map(item => item.kind).sort(), ["method-not-exported", "missing-page", "missing-route"]);
  assert.ok(report.findings.every(item => item.file.replaceAll("\\", "/") === "apps/web/src/features/client.ts"));
  const method = report.findings.find(item => item.kind === "method-not-exported");
  assert.equal(method.method, "POST");
  assert.deepEqual(method.exported, ["GET"]);
  assert.ok(method.route.replaceAll("\\", "/").endsWith("/api/items/special/route.ts"));
  assert.equal(run(script).status, 0, "observational mode must keep its existing exit semantics");
});
