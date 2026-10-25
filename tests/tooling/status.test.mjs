import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSnapshot, exactCi, renderSnapshot, validateStatus } from "../../scripts/status.mjs";

const sha = "a".repeat(40), other = "b".repeat(40);
test("CI state requires this exact head and the CI workflow", () => {
  assert.equal(exactCi([{ headSha: other, workflowName: "CI", status: "completed", conclusion: "success", databaseId: 9 }], sha).state, "missing");
  assert.equal(exactCi([{ headSha: sha, workflowName: "Other", status: "completed", conclusion: "success", databaseId: 9 }], sha).state, "missing");
  const runs = [{ headSha: sha, workflowName: "CI", status: "completed", conclusion: "success", databaseId: 1 },
    { headSha: sha, workflowName: "CI", status: "in_progress", conclusion: "", databaseId: 2 }];
  assert.equal(exactCi(runs, sha).state, "in_progress");
  assert.equal(exactCi([{ ...runs[1], status: "completed", conclusion: "failure" }], sha).state, "failure");
});
test("board checks only active rows and retains history elsewhere", () => {
  const text = "# 状态\n## 进行中\n" + "- active\n".repeat(6) + "## 已知限制\n- not active\n";
  assert.equal(validateStatus(text).activeRows, 6);
  assert.throws(() => validateStatus(text.replace("## 已知限制", "- seventh\n## 已知限制")), /maximum is 6/);
  assert.throws(() => validateStatus("## 进行中\n" + "中".repeat(2200)), /6144/);
  assert.throws(() => validateStatus("# empty"), /进行中/);
});
test("queries trunk push CI and each PR head without mutating GitHub", async () => {
  const calls = [];
  const gh = async args => {
    calls.push(args);
    if (args[0] === "api") return { sha };
    if (args[0] === "pr") return { number: 122, title: "test|title", url: "https://example.test/pr/122", state: "OPEN", isDraft: true, headRefOid: other, baseRefName: "base", mergeStateStatus: "BEHIND" };
    return [{ databaseId: 4, workflowName: "CI", headSha: args[args.indexOf("--commit") + 1], status: "completed", conclusion: "success", url: "https://example.test/run/4" }];
  };
  const result = await collectSnapshot({ prNumbers: [122], gh });
  assert.equal(result.trunk.sha, sha); assert.equal(result.pullRequests[0].headRefOid, other);
  assert.equal(result.trunk.ci.state, "success");
  assert(calls.some(args => args.includes("--event") && args.includes("push")));
  assert(calls.filter(args => args[0] === "run").every(args => args[1] === "list"));
  const text = renderSnapshot(result);
  assert.match(text, /test\\\|title/); assert.match(text, /BEHIND/); assert.match(text, /不代表已部署/);
});
test("query failure is not replaced with an older successful snapshot", async () => {
  await assert.rejects(collectSnapshot({ gh: async () => { throw new Error("offline"); } }), /offline/);
});
