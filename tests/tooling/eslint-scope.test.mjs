import assert from "node:assert/strict";
import { ESLint } from "eslint";
import test from "node:test";

const eslint = new ESLint();

test("local runtime and temp trees are ignored by the flat config", async () => {
  assert.equal(await eslint.isPathIgnored(".local/docling-venv/lib/python.py"), true);
  assert.equal(await eslint.isPathIgnored(".local/pgsql/include/server.h"), true);
  assert.equal(await eslint.isPathIgnored(".tmp/vendor.min.js"), true);
});

test("project sources stay linted", async () => {
  assert.equal(await eslint.isPathIgnored("apps/web/src/app/page.tsx"), false);
  assert.equal(await eslint.isPathIgnored("packages/domain/src/index.ts"), false);
  assert.equal(
    await eslint.isPathIgnored("scripts/notion-meeting-pipeline/notion-ui.mjs"),
    false,
  );
});

test("generated browser reports are ignored while browser specifications remain linted", async () => {
  assert.equal(await eslint.isPathIgnored("playwright-report/opening-isolated/trace/assets/vendor.js"), true);
  assert.equal(await eslint.isPathIgnored("test-results/opening-isolated/generated.js"), true);
  assert.equal(await eslint.isPathIgnored("tests/e2e/opening-workflow.spec.ts"), false);
});
