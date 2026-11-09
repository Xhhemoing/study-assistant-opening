import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("writer protocol exercises real kernel/process/filesystem boundaries", {
  skip: process.platform !== "linux" ? "writer protocol requires Linux SO_PEERCRED and pidfd" : false,
}, () => {
  // Inherit both streams: unittest's case list, failures and skip totals remain
  // visible, and execFileSync propagates a nonzero Python exit as a Node failure.
  execFileSync("python3", ["-c", `
import sys
import unittest
suite = unittest.defaultTestLoader.discover('tests/tooling', pattern='hermes_writer_protocol_test.py')
if suite.countTestCases() == 0:
    raise RuntimeError('Writer protocol discovery collected no tests')
result = unittest.TextTestRunner(verbosity=2).run(suite)
sys.exit(0 if result.wasSuccessful() else 1)
`], { cwd: root, stdio: "inherit" });
});
