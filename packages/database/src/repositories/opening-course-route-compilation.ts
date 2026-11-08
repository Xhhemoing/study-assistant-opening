import { courseRouteActivityContextSchema, courseRequirementProgressSchema, teachingQuestionInteractionSchema, type CourseRequirementProgress, type Scope } from "@aistudy/contracts";
import { checkArithmeticAnswer } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import type { TeachingBlockRef } from "@aistudy/contracts";
import { teachingQuestionText } from "./opening-teaching-question";
import { readOpeningReservedSupply } from "./opening-course-reserved-selection";

type Block = { id: string; type: string; content: Record<string, unknown> };

async function readQuestionCoverage(db: Sql | TransactionSql, scope: Scope, courseId: string, activityId: string,
  revisionId: string, ordered: TeachingBlockRef[], blocks: Block[]) {
  const issued = await db`SELECT DISTINCT v.teaching_block_id FROM opening_learning_item_versions v
    WHERE v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId} AND v.course_id=${courseId}
      AND v.activity_id=${activityId} AND v.teaching_revision_id=${revisionId}
      AND EXISTS (SELECT 1 FROM opening_learning_attempts a WHERE a.item_version_id=v.id
        AND a.workspace_id=v.workspace_id AND a.owner_user_id=v.owner_user_id AND a.course_id=v.course_id AND a.activity_id=v.activity_id)`;
  const issuedIds = new Set(issued.map(row => String(row.teaching_block_id)));
  const coverage = { savedQuestions: 0, withReferenceAnswers: 0, issuedQuestions: 0, unexposedEligibility: "unknown" as const };
  const referenceChecks = { matched: 0, mismatched: 0, unsupported: 0 };
  const refs = [...ordered].sort((a, b) => a.position - b.position);
  const seen = new Set<string>();
  for (const [index, ref] of refs.entries()) {
    const prompt = blocks.find(block => block.id === ref.blockId);
    if (seen.has(ref.blockId) || ref.role === "answer_key" || !(ref.role === "prompt" || ["prompt", "question"].includes(ref.blockType))
      || !prompt || !["prompt", "question"].includes(prompt.type) || !teachingQuestionText(prompt.content)) continue;
    seen.add(ref.blockId);
    coverage.savedQuestions++;
    if (issuedIds.has(ref.blockId)) coverage.issuedQuestions++;
    const next = refs[index + 1];
    const answer = next && (next.role === "answer_key" || ["answer_key", "solution"].includes(next.blockType))
      ? blocks.find(block => block.id === next.blockId && ["answer_key", "solution"].includes(block.type)) : undefined;
    const reference = teachingQuestionText(answer?.content);
    if (reference) {
      coverage.withReferenceAnswers++;
      const interaction = teachingQuestionInteractionSchema.safeParse(prompt.content.interaction);
      const unsupported = prompt.content.interaction !== undefined && (!interaction.success
        || interaction.data.kind === "choice" || (interaction.data.kind === "numeric" && Boolean(interaction.data.unit)));
      const result = unsupported ? null : checkArithmeticAnswer(teachingQuestionText(prompt.content)!, reference);
      referenceChecks[result === "correct" ? "matched" : result === "incorrect" ? "mismatched" : "unsupported"]++;
    }
  }
  return { coverage, referenceChecks };
}

/** Current matching activity only; private block bodies stay inside this repository. */
export async function readCourseRouteCompilation(db: Sql | TransactionSql, scope: Scope, courseId: string, progress: CourseRequirementProgress[]) {
  const rows = await db`SELECT a.id,a.goal_json,a.generate_status,a.content_version,
    s.document_id,s.revision_number,s.verification_status,s.block_order,r.id AS revision_id,r.blocks,
    (s.version=a.content_version AND a.content_version>0 AND jsonb_array_length(s.block_order)>0
      AND r.id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(s.block_order) b
        WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.blocks) rb WHERE rb->>'id'=b->>'blockId'))
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(s.source_refs) ref
        WHERE NOT EXISTS (SELECT 1 FROM opening_sources src
          JOIN course_asset_memberships m ON m.asset_id=src.id AND m.workspace_id=src.workspace_id
            AND m.asset_type='source' AND m.course_id=a.course_id
          WHERE src.id::text=ref->>'sourceId' AND src.workspace_id=a.workspace_id
            AND src.version::text=ref->>'version' AND src.upload_state='uploaded' AND src.parse_state='ready'
            AND ((ref->>'chunkId' IS NULL AND ref->>'page' IS NULL) OR EXISTS (
              SELECT 1 FROM opening_source_chunks c
              WHERE c.source_id=src.id AND c.source_version=src.version
                AND (ref->>'chunkId' IS NULL OR c.id::text=ref->>'chunkId')
                AND (ref->>'page' IS NULL OR c.page::text=ref->>'page')))
            AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=src.workspace_id AND e.source_id=src.id)))) AS saved
    FROM opening_teaching_activities a
    LEFT JOIN opening_teaching_activity_specs s ON s.activity_id=a.id AND s.workspace_id=a.workspace_id AND s.owner_user_id=a.owner_user_id
    LEFT JOIN library_revisions r ON r.workspace_id=s.workspace_id AND r.document_id=s.document_id AND r.revision_number=s.revision_number
    WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} AND a.course_id=${courseId}
      AND a.status IN ('active','paused','completed') AND a.generate_status NOT IN ('cancelled','stale')
      AND a.goal_json ? 'courseRoute'
      AND NOT EXISTS (SELECT 1 FROM opening_learning_observations o JOIN opening_learning_observations root
        ON root.id=COALESCE(o.root_observation_id,o.id) AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
        WHERE o.id::text=a.goal_json->'courseRoute'->>'originObservationId' AND o.workspace_id=a.workspace_id
          AND o.owner_user_id=a.owner_user_id AND COALESCE(root.effective_head_id,root.id)<>o.id)
    ORDER BY a.updated_at DESC,a.id DESC`;
  for (const item of progress) {
    const row = rows.find(row => {
      const parsed = courseRouteActivityContextSchema.safeParse((row.goal_json as { courseRoute?: unknown }).courseRoute);
      const requirement = item.requirement;
      return parsed.success && parsed.data.requirementId === requirement.id && parsed.data.requirementRevision === requirement.revision
        && parsed.data.stableSkillId === requirement.stableSkillId && parsed.data.requirementKey === requirement.requirementKey;
    });
    const saved = !!row && row.saved === true && item.sourcesAvailable;
    const facts = saved
      ? await readQuestionCoverage(db, scope, courseId, String(row!.id), String(row!.revision_id), row!.block_order as TeachingBlockRef[], row!.blocks as Block[])
      : { coverage: { savedQuestions: 0, withReferenceAnswers: 0, issuedQuestions: 0, unexposedEligibility: "unknown" as const },
        referenceChecks: { matched: 0, mismatched: 0, unsupported: 0 } };
    const supply = await readOpeningReservedSupply(db, scope, item.requirement);
    item.reservedSupply = supply;
    item.questionCoverage = { ...facts.coverage, unexposedEligibility: supply.status };
    item.referenceChecks = facts.referenceChecks;
    item.compilation = courseRequirementProgressSchema.shape.compilation.parse({
      activityId: row ? String(row.id) : null, generateStatus: row?.generate_status ?? null,
      contentVersion: row ? Number(row.content_version) : 0, saved,
      documentId: saved ? String(row!.document_id) : null, revisionNumber: saved ? Number(row!.revision_number) : null,
      verificationStatus: saved ? row!.verification_status : null,
    });
  }
}
