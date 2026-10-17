#!/usr/bin/env node
import { readFileSync } from "node:fs";
const [sha, repository] = process.argv.slice(2);
try {
  const body = JSON.parse(readFileSync(0, "utf8"));
  const runs = body.workflow_runs.filter(run => run.head_sha === sha
    && run.head_branch === "feat/opening-release" && run.event === "push" && Number.isSafeInteger(run.id));
  const latest = runs.sort((a, b) => b.id - a.id)[0];
  if (!latest || latest.status !== "completed" || latest.conclusion !== "success"
    || latest.html_url !== `https://github.com/${repository}/actions/runs/${latest.id}`) process.exit(1);
  console.log(latest.html_url);
} catch {
  process.exit(1);
}
