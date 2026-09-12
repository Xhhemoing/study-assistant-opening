import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const config = readFileSync(new URL(".npmrc", root), "utf8");
const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));

test("installation uses the official HTTPS registry without global config changes", () => {
  assert.match(config, /^registry=https:\/\/registry\.npmjs\.org\/?$/m);
  assert.match(config, /^replace-registry-host=always$/m);
});

test("locked tarballs contain no HTTP or incompatible Tencent /npm prefix", () => {
  for (const [name, pkg] of Object.entries(lock.packages)) {
    const resolved = pkg.resolved;
    if (typeof resolved !== "string" || !resolved.startsWith("http")) continue;
    const url = new URL(resolved);
    assert.equal(url.protocol, "https:", name);
    assert.notEqual(url.hostname, "mirrors.tencentyun.com", name);
  }
});
