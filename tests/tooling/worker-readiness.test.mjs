import assert from "node:assert/strict";
import test from "node:test";
import { verifyWorkerReadiness, requiresWorkerReadiness } from "../../infra/deploy/hermes-health.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("only a matching restoration snapshot can use historical identity-only recovery", t => {
  const legacy = mkdtempSync(join(tmpdir(), "worker-readiness-legacy-"));
  t.after(() => rmSync(legacy, { recursive: true, force: true }));
  const restored = { version: 1, release: legacy, worker: { unitUser: "aistudy-worker", uid: 1001 } };
  assert.equal(requiresWorkerReadiness(legacy), true, "new releases never bypass readiness");
  assert.equal(requiresWorkerReadiness(legacy, { ...restored, release: "/other" }), true);
  assert.equal(requiresWorkerReadiness(legacy, { ...restored, worker: null }), true);
  assert.equal(requiresWorkerReadiness(legacy, restored), false);
  const runtime = join(legacy, "apps/worker/src/runtime");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "worker-readiness.ts"), "export {};\n");
  assert.equal(requiresWorkerReadiness(legacy, restored), true, "receipt-capable rollback still needs a fresh receipt");
});

const release = "/releases/current";
const configured = { WORKER_ROLE: "parser" };
const snapshot = { pid: 100, consumerPid: 101, consumerParentPid: 100, consumerCwd: release,
  consumerArgumentPaths: [`${release}/apps/worker/src/index.ts`], environment: configured };
const receipt = { version: 1, pid: 101, supervisorPid: 100, release, role: "parser",
  queueKinds: ["parse", "parse-media"], checkedAt: 1000, expiresAt: 16000 };

test("deployment accepts only fresh live consumer identity, including tsx child of systemd MainPID", () => {
  assert.doesNotThrow(() => verifyWorkerReadiness(receipt, snapshot, release, configured, 2000));
  assert.doesNotThrow(() => verifyWorkerReadiness({ ...receipt, pid: 100 }, { ...snapshot, consumerPid: 100 }, release, configured, 2000));
});
test("active systemd process alone, stale receipt, partial queues, wrong PID/release/role fail closed", () => {
  for (const patch of [null, { pid: 99 }, { release: "/old" }, { role: "learning" }, { queueKinds: ["parse"] },
    { queueKinds: ["parse", "parse-media", "tutor"] }, { expiresAt: 2000 }, { checkedAt: 3000 }, { expiresAt: 999999 }]) {
    assert.throws(() => verifyWorkerReadiness(patch === null ? null : { ...receipt, ...patch }, snapshot, release, configured, 2000), /not ready/);
  }
  assert.throws(() => verifyWorkerReadiness(receipt, { ...snapshot, consumerParentPid: 999 }, release, configured, 2000), /not ready/);
  assert.throws(() => verifyWorkerReadiness(receipt, { ...snapshot, consumerCwd: "/old" }, release, configured, 2000), /not ready/);
});
