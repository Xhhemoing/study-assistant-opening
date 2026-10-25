#!/usr/bin/env node
/** Read-only live PR/head/CI snapshot. Never rewrites STATUS or changes GitHub. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const repoDefault = "Xhhemoing/study-assistant-opening";
const branchDefault = "feat/opening-release";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function validateStatus(text) {
  const section = text.match(/^## 进行中\s*$([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1];
  if (section === undefined) throw new Error("STATUS must contain a 进行中 section");
  const entries = section.split("\n").filter(line => /^\s*(?:- |\|[^-])/.test(line));
  if (entries.length > 6) throw new Error(`STATUS has ${entries.length} active rows; maximum is 6`);
  const bytes = Buffer.byteLength(text);
  if (bytes > 6144) throw new Error(`STATUS is ${bytes} bytes; archive history to keep it within 6144 bytes`);
  return { activeRows: entries.length, bytes };
}

/** Only a completed successful CI run for this exact head can be labelled success. */
export function exactCi(runs, sha) {
  const run = runs.filter(row => row.headSha === sha && row.workflowName === "CI")
    .sort((a, b) => Number(b.databaseId) - Number(a.databaseId))[0];
  if (!run) return { state: "missing", runId: null, url: null };
  return { state: run.status === "completed" ? run.conclusion || "unknown" : run.status,
    runId: run.databaseId, url: run.url ?? null };
}

function cell(value) { return String(value ?? "—").replaceAll("|", "\\|").replace(/[\r\n]/g, " "); }
export function renderSnapshot(snapshot) {
  const lines = [`# Study GitHub 状态（${snapshot.observedAt}）`, "",
    `仓库：${snapshot.repo}；只读快照，不代表已部署或用户验收。`, "",
    `主干 ${cell(snapshot.trunk.branch)}：\`${snapshot.trunk.sha.slice(0, 12)}\`；精确 SHA push CI：${cell(snapshot.trunk.ci.state)}`,
    "", "| PR | head | base | 状态 / 草稿 | 精确 head CI | 分支门禁 |",
    "|---|---|---|---|---|---|"];
  for (const pr of snapshot.pullRequests) lines.push(
    `| [#${pr.number}](${pr.url}) ${cell(pr.title)} | \`${pr.headRefOid.slice(0, 12)}\` | ${cell(pr.baseRefName)} | ${cell(pr.state)}${pr.isDraft ? " / draft" : ""} | ${pr.ci.url ? `[${cell(pr.ci.state)}](${pr.ci.url})` : cell(pr.ci.state)} | ${cell(pr.mergeStateStatus)} |`);
  if (!snapshot.pullRequests.length) lines.push("", "没有符合筛选条件的 PR。");
  lines.push("", "成功只指该 SHA 的 CI；BEHIND/BLOCKED、审批、合并和部署仍需单独处理。获取失败会退出非零，不沿用旧快照冒充当前状态。");
  return lines.join("\n") + "\n";
}

export async function collectSnapshot({ repo = repoDefault, branch = branchDefault, prNumbers = [], gh } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Invalid repository");
  const query = gh ?? (async args => {
    const { stdout } = await exec("gh", args, { cwd: root, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  });
  const fields = "number,title,url,state,isDraft,headRefOid,baseRefName,mergeStateStatus";
  const trunk = await query(["api", `repos/${repo}/commits/${encodeURIComponent(branch)}`]);
  if (!/^[a-f0-9]{40}$/.test(trunk.sha ?? "")) throw new Error("GitHub did not return a valid trunk SHA");
  const runFields = "databaseId,headSha,status,conclusion,url,workflowName";
  const trunkRuns = await query(["run", "list", "-R", repo, "--branch", branch, "--event", "push", "--commit", trunk.sha, "--limit", "20", "--json", runFields]);
  const prs = prNumbers.length
    ? await Promise.all(prNumbers.map(n => query(["pr", "view", String(n), "-R", repo, "--json", fields])))
    : await query(["pr", "list", "-R", repo, "--state", "open", "--limit", "100", "--json", fields]);
  const results = [];
  // Bounded concurrency; no workflow dispatch or reruns.
  for (let i = 0; i < prs.length; i += 3) {
    const batch = await Promise.all(prs.slice(i, i + 3).map(async pr => {
      const runs = await query(["run", "list", "-R", repo, "--commit", pr.headRefOid, "--limit", "20", "--json", runFields]);
      return { ...pr, ci: exactCi(runs, pr.headRefOid) };
    }));
    results.push(...batch);
  }
  return { observedAt: new Date().toISOString(), repo,
    trunk: { branch, sha: trunk.sha, ci: exactCi(trunkRuns, trunk.sha) },
    pullRequests: results.sort((a, b) => a.number - b.number) };
}

async function main(args) {
  if (args.includes("--help")) {
    console.log("node scripts/status.mjs [--json] [--pr NUMBER ...] [--repo OWNER/REPO] [--check-status]\nRead-only. --check-status validates the local board without network access.");
    return;
  }
  let json = false, check = false, repo = repoDefault;
  const prNumbers = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") json = true;
    else if (arg === "--check-status") check = true;
    else if (arg === "--repo" && args[i + 1]) repo = args[++i];
    else if (arg === "--pr" && /^\d+$/.test(args[i + 1] ?? "")) prNumbers.push(Number(args[++i]));
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (check) {
    console.log(JSON.stringify(validateStatus(await readFile(path.join(root, "docs/STATUS.md"), "utf8"))));
    return;
  }
  const snapshot = await collectSnapshot({ repo, prNumbers: [...new Set(prNumbers)] });
  process.stdout.write(json ? JSON.stringify(snapshot, null, 2) + "\n" : renderSnapshot(snapshot));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    // Do not echo command environments, stderr credentials or raw API bodies.
    console.error(`Study status unavailable: ${error.code || error.name || "query failed"}`);
    process.exitCode = 1;
  });
}
