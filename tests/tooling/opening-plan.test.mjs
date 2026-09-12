import assert from "node:assert/strict";
import test from "node:test";
import { validateTaskGraph } from "../../scripts/validate-opening-plan.mjs";

const task = (id, dependsOn = []) => ({
  id, dependsOn, owner: "INTEGRATOR", plan: "sample.md", status: "planned", evidence: [],
});

test("accepts an acyclic task graph", () => {
  assert.deepEqual(validateTaskGraph([task("A"), task("B", ["A"])]), []);
});

test("rejects unknown dependencies and cycles", () => {
  assert.ok(validateTaskGraph([task("A", ["missing"])]).some(x => x.includes("missing")));
  assert.ok(validateTaskGraph([task("A", ["B"]), task("B", ["A"])]).some(x => x.includes("cycle")));
});

test("rejects duplicate IDs and unsupported verified claims", () => {
  assert.ok(validateTaskGraph([task("A"), task("A")]).some(x => x.includes("duplicate")));
  assert.ok(validateTaskGraph([{ ...task("A"), status: "verified" }]).some(x => x.includes("evidence")));
});

test("does not allow verified work before its dependency is verified", () => {
  const b = { ...task("B", ["A"]), status: "verified", evidence: ["result.md"] };
  assert.ok(validateTaskGraph([task("A"), b]).some(x => x.includes("not verified")));
});
