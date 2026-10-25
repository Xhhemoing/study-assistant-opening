#!/usr/bin/env tsx
/**
 * Repair model LaTeX that the pre-parseModelJson JSON.parse decoded into control
 * characters (\times -> TAB+"imes", \frac -> FF+"rac", \beta -> BS+"eta",
 * \neq -> LF+"eq", \right -> CR+"ight") in stored teaching blocks and AI grading
 * feedback. Dry run by default; prints counts and a few redacted-length samples.
 *
 *   DATABASE_URL=... npx tsx scripts/opening-repair-latex-escapes.ts            # dry run
 *   DATABASE_URL=... npx tsx scripts/opening-repair-latex-escapes.ts --apply    # write
 *   ... --workspace <uuid>   limit to one workspace
 *   ... --no-samples         counts only (samples contain learner/model text)
 *
 * Idempotent: a second --apply finds nothing. library_revisions is append-only and
 * is only counted; the server repairs pinned revisions when it reads them.
 */
import { createSqlClient, repairOpeningLatexEscapes } from "../packages/database/src/index.ts";

function usage(message?: string): never {
  if (message) console.error(message);
  console.error("Usage: DATABASE_URL=... tsx scripts/opening-repair-latex-escapes.ts [--apply] [--workspace <uuid>] [--no-samples]");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let apply = false;
  let workspaceId: string | undefined;
  let samples = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg === "--no-samples") samples = false;
    else if (arg === "--workspace") {
      workspaceId = args[index += 1];
      if (!workspaceId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(workspaceId)) usage("--workspace needs a UUID");
    } else usage(`Unknown argument: ${arg}`);
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) usage("DATABASE_URL is required");

  const sql = createSqlClient(databaseUrl, { max: 1 });
  try {
    const report = await repairOpeningLatexEscapes(sql, { apply, workspaceId, maxSamples: samples ? 10 : 0 });
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...report }, null, 2));
    if (!apply && (report.libraryBlocks.affected || report.aiEvaluations.affected)) {
      console.error("Dry run only. Re-run with --apply to write the repaired rows.");
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
