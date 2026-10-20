#!/usr/bin/env -S node --import tsx
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createScopedOpeningSystemQueryReader, createSqlClient, readOpeningSystemQueryAuthorization } from "../packages/database/src/index";
import { materialRetrievalEvaluationSchema } from "../packages/contracts/src/opening/material-retrieval-evaluation";
import { runMaterialRetrievalEvaluation } from "../packages/ai/src/opening/material-retrieval-evaluation";
import { createFixtureMaterialReader, loadMaterialRetrievalFixture } from "./study-retrieval/fixture";

async function main(): Promise<void> {
  const args = process.argv.slice(2), fixture = args.includes("--fixture");
  if (args.includes("--help")) {
    console.log("Usage: node --import tsx scripts/study-retrieval-eval.ts --annotations FILE [--output FILE] [--fixture]\nLive mode reads DATABASE_URL without printing it. --fixture replays the existing allowlisted teaching corpus; no PostgreSQL or production claims.");
    return;
  }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fixture") continue;
    if (!["--annotations", "--output"].includes(args[i]!) || !args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error("Invalid CLI options; use --help");
    if (options.has(args[i]!)) throw new Error("Duplicate CLI option");
    options.set(args[i]!, args[++i]!);
  }
  const annotations = options.get("--annotations");
  if (!annotations) throw new Error("--annotations is required");
  const parsed = materialRetrievalEvaluationSchema.safeParse(JSON.parse(await readFile(annotations, "utf8")));
  if (!parsed.success) throw new Error("Invalid retrieval annotation protocol");
  const dataset = parsed.data;
  let report;
  if (fixture) {
    if (dataset.annotationProvenance !== "development_fixture") throw new Error("Fixture replay requires development_fixture provenance");
    const chunks = await loadMaterialRetrievalFixture(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
    report = { ...await runMaterialRetrievalEvaluation(dataset, createFixtureMaterialReader(chunks, dataset.scope), { mode: "fixture_replay" }),
      fixtureOrigins: chunks.map(({ id, originPath, originalChunkId }) => ({ id, originPath, originalChunkId })) };
  } else {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for live scoped-reader evaluation");
    const sql = createSqlClient(process.env.DATABASE_URL);
    try {
      await readOpeningSystemQueryAuthorization(sql, dataset.scope, "system_record_lookup");
      report = await runMaterialRetrievalEvaluation(dataset, createScopedOpeningSystemQueryReader(sql, dataset.scope, { purpose: "system_record_lookup" }), { mode: "scoped_postgres_reader" });
    } finally { await sql.end({ timeout: 5 }); }
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`, output = options.get("--output");
  if (output) await writeFile(output, serialized, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ datasetId: report.datasetId, mode: report.mode, coverage: report.coverage, aggregate: report.aggregate, ...(output ? { output } : {}) }, null, 2));
  if (!output) console.log(serialized);
}
main().catch(() => {
  // Never dump database driver objects, connection URLs, or annotation bodies.
  console.error("Retrieval evaluation failed; check input, owner scope and database availability. No successful report was claimed.");
  process.exitCode = 1;
});
