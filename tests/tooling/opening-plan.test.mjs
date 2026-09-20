import assert from "node:assert/strict";
import test from "node:test";
import { validateTaskGraph, validateMigrationReservations } from "../../scripts/validate-opening-plan.mjs";

const task = (id, dependsOn = []) => ({
  id, dependsOn, owner: "INTEGRATOR", plan: "sample.md", status: "planned", evidence: [],
});

test("rejects planned migration numbers already occupied by a different migration", () => {
  assert.deepEqual(validateMigrationReservations(["0020_opening_chunks.sql"], ["0020_opening_memory.sql"]),
    ["migration number collision: 0020_opening_memory.sql conflicts with 0020_opening_chunks.sql"]);
});

test("allows references to existing migrations and rejects conflicting future reservations", () => {
  assert.deepEqual(validateMigrationReservations(["0020_opening_chunks.sql"], ["0020_opening_chunks.sql", "0022_memory.sql"]), []);
  assert.equal(validateMigrationReservations([], ["0022_memory.sql", "0022_planning.sql"]).length, 1);
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
