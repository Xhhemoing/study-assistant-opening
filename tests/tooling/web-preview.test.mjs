import assert from "node:assert/strict";
import test from "node:test";

async function configFor(overrides) {
  const previous = { ...process.env };
  try {
    delete process.env.AISTUDY_WEB_PREVIEW;
    delete process.env.OPENING_E2E;
    Object.assign(process.env, overrides);
    return (await import(`../../apps/web/next.config.mjs?case=${Math.random()}`)).default;
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

test("preview build and start select a directory separate from development and E2E", async () => {
  const config = await configFor({ AISTUDY_WEB_PREVIEW: "1" });
  assert.equal(config.distDir, ".next-preview");
  assert.equal(config.typescript.tsconfigPath, "tsconfig.preview.json");
  assert.equal(config.output, undefined);
});

test("ordinary development and deployment keep their existing configuration", async () => {
  const config = await configFor({});
  assert.equal(config.distDir, undefined);
  assert.equal(config.output, "standalone");
});

test("isolated E2E configuration is preserved", async () => {
  const config = await configFor({ OPENING_E2E: "1" });
  assert.equal(config.distDir, ".next-opening-e2e");
  assert.equal(config.typescript.tsconfigPath, "tsconfig.opening-e2e.json");
  assert.equal(config.output, undefined);
});
