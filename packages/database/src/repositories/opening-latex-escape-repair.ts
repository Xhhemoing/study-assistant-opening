import { repairDecodedLatexInJson } from "@aistudy/ai";
import type { Sql } from "postgres";

/**
 * Maintenance: find model LaTeX that a plain JSON.parse decoded into control
 * characters before parseModelJson existed (TAB+"imes" for \times, FF+"rac" for
 * \frac, ...) and, with apply, write the repaired text back.
 *
 * Mutable copies are repaired in place:
 *   - library_blocks of teaching unit documents (current document body);
 *   - opening_learning_observations.ai_evaluation (AI grading feedback/criteria).
 * library_revisions is append-only and is never written: the pinned teaching
 * revision is repaired at read time (client-init and answer-key reads) instead,
 * so its rows are only counted here.
 */
export type LatexRepairTableReport = {
  /** Rows whose JSON text could hold a decoded escape (cheap SQL prefilter). */
  scanned: number;
  /** Rows with at least one repair. */
  affected: number;
  /** Total repaired command occurrences. */
  repairs: number;
  /** Rows written (0 in dry run, or when the row changed concurrently). */
  updated: number;
};

export type LatexRepairReport = {
  apply: boolean;
  libraryBlocks: LatexRepairTableReport;
  aiEvaluations: LatexRepairTableReport;
  /** Count only: append-only, repaired at read time. */
  teachingRevisions: Omit<LatexRepairTableReport, "updated">;
  samples: Array<{ table: string; id: string; before: string; after: string }>;
};

export type LatexRepairOptions = {
  apply?: boolean;
  workspaceId?: string;
  batchSize?: number;
  maxSamples?: number;
};

// jsonb::text renders TAB/FF/BS/LF/CR as \t \f \b \n \r; a decoded command is one of
// those immediately followed by a letter. Over-matches intact "\\times"; JS decides.
const PREFILTER = String.raw`\\[tfbnr][A-Za-z]`;
const UUID_MIN = "00000000-0000-0000-0000-000000000000";

const emptyReport = (): LatexRepairTableReport => ({ scanned: 0, affected: 0, repairs: 0, updated: 0 });

function sampleOf(before: unknown, after: unknown): { before: string; after: string } {
  const a = JSON.stringify(before);
  const b = JSON.stringify(after);
  let start = 0;
  while (start < a.length && a[start] === b[start]) start += 1;
  const from = Math.max(0, start - 30);
  return { before: a.slice(from, from + 100), after: b.slice(from, from + 100) };
}

export async function repairOpeningLatexEscapes(sql: Sql, options: LatexRepairOptions = {}): Promise<LatexRepairReport> {
  const apply = options.apply === true;
  const batchSize = options.batchSize ?? 500;
  const maxSamples = options.maxSamples ?? 10;
  const workspaceId = options.workspaceId ?? null;
  const report: LatexRepairReport = {
    apply,
    libraryBlocks: emptyReport(),
    aiEvaluations: emptyReport(),
    teachingRevisions: { scanned: 0, affected: 0, repairs: 0 },
    samples: [],
  };
  const sample = (table: string, id: string, before: unknown, after: unknown) => {
    if (report.samples.length < maxSamples) report.samples.push({ table, id, ...sampleOf(before, after) });
  };

  for (let after = UUID_MIN; ;) {
    const rows = await sql<{ id: string; content: Record<string, unknown> }[]>`
      SELECT b.id, b.content FROM library_blocks b
      WHERE b.id > ${after}::uuid
        AND (${workspaceId}::uuid IS NULL OR b.workspace_id = ${workspaceId}::uuid)
        AND EXISTS (SELECT 1 FROM opening_teaching_units u
          WHERE u.document_id = b.document_id AND u.workspace_id = b.workspace_id)
        AND b.content::text ~ ${PREFILTER}
      ORDER BY b.id LIMIT ${batchSize}`;
    if (!rows.length) break;
    after = rows[rows.length - 1]!.id;
    for (const row of rows) {
      report.libraryBlocks.scanned += 1;
      const { value, repairs } = repairDecodedLatexInJson(row.content);
      if (!repairs) continue;
      report.libraryBlocks.affected += 1;
      report.libraryBlocks.repairs += repairs;
      sample("library_blocks", row.id, row.content, value);
      if (!apply) continue;
      // Compare-and-set on the content we read so a concurrent edit is never overwritten.
      const written = await sql`UPDATE library_blocks SET content = ${sql.json(value as never)}
        WHERE id = ${row.id} AND content = ${sql.json(row.content as never)} RETURNING id`;
      report.libraryBlocks.updated += written.length;
    }
  }

  for (let after = UUID_MIN; ;) {
    const rows = await sql<{ id: string; ai_evaluation: Record<string, unknown> }[]>`
      SELECT o.id, o.ai_evaluation FROM opening_learning_observations o
      WHERE o.id > ${after}::uuid
        AND (${workspaceId}::uuid IS NULL OR o.workspace_id = ${workspaceId}::uuid)
        AND o.ai_evaluation IS NOT NULL
        AND o.ai_evaluation::text ~ ${PREFILTER}
      ORDER BY o.id LIMIT ${batchSize}`;
    if (!rows.length) break;
    after = rows[rows.length - 1]!.id;
    for (const row of rows) {
      report.aiEvaluations.scanned += 1;
      const { value, repairs } = repairDecodedLatexInJson(row.ai_evaluation);
      if (!repairs) continue;
      report.aiEvaluations.affected += 1;
      report.aiEvaluations.repairs += repairs;
      sample("opening_learning_observations.ai_evaluation", row.id, row.ai_evaluation, value);
      if (!apply) continue;
      const written = await sql`UPDATE opening_learning_observations SET ai_evaluation = ${sql.json(value as never)}
        WHERE id = ${row.id} AND ai_evaluation = ${sql.json(row.ai_evaluation as never)} RETURNING id`;
      report.aiEvaluations.updated += written.length;
    }
  }

  for (let after = UUID_MIN; ;) {
    const rows = await sql<{ id: string; blocks: unknown }[]>`
      SELECT r.id, r.blocks FROM library_revisions r
      WHERE r.id > ${after}::uuid
        AND (${workspaceId}::uuid IS NULL OR r.workspace_id = ${workspaceId}::uuid)
        AND EXISTS (SELECT 1 FROM opening_teaching_units u
          WHERE u.document_id = r.document_id AND u.workspace_id = r.workspace_id)
        AND r.blocks::text ~ ${PREFILTER}
      ORDER BY r.id LIMIT ${batchSize}`;
    if (!rows.length) break;
    after = rows[rows.length - 1]!.id;
    for (const row of rows) {
      report.teachingRevisions.scanned += 1;
      const { repairs } = repairDecodedLatexInJson(row.blocks);
      if (!repairs) continue;
      report.teachingRevisions.affected += 1;
      report.teachingRevisions.repairs += repairs;
    }
  }
  return report;
}
