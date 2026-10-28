import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { conversationPlanMetadataSchema, plannedBlockSchema, suggestedTaskSchema, type AcceptPlanInput, type Scope, type TaskItem } from "@aistudy/contracts";
import { admitOpeningConversationPlanReplay, assertOpeningConversationPlanCourse, consumeOpeningConversationPlanCandidate } from "./opening-conversation-plan";
import { parseSuggestionKey } from "@aistudy/domain";
import { assertCoachAcceptance } from "./opening-coach-plans";
import { assertOpeningSuggestedSelectionAllowed } from "./opening-suggestion-feedback";
import { OpeningPlanError } from "./opening-plan-error";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { readOpeningLearnerSnapshotCourses } from "./opening-learner-snapshot-read";
import { validateOpeningLocalReplan } from "./opening-local-replan-validation";
import { assertOpeningPlanConstraints } from "./opening-plan-constraints";
import { assertOpeningLearningManagementDraft } from "./opening-learning-management-draft";

/** One transaction owns selection, task creation and the accepted plan version. */
export async function acceptOpeningPlan(sql: Sql, scope: Scope, input: AcceptPlanInput, now: Date, options: { source?: "coach"; expectedDraftVersion?: number } = {}) {
  return sql.begin(async tx => {
    const [located] = await tx`SELECT day FROM opening_plan_drafts
      WHERE id=${input.draftId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    if (!located) throw new OpeningPlanError("NOT_FOUND", "draft not found");
    const day = new Date(located.day as string | Date).toISOString().slice(0, 10);
    // Same day lock as auto-draft recomputation, before any workspace/row lock.
    const digest = createHash("sha256").update(`opening-daily-draft:${scope.workspaceId}:${day}`).digest();
    await tx`SELECT pg_advisory_xact_lock(${digest.readInt32BE(0)}, ${digest.readInt32BE(4)})`;
    await lockWorkspaceLearningHistory(tx, scope);
    const owners = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
    if (!owners.length) throw new OpeningPlanError("NOT_FOUND", "workspace not found");
    await tx`INSERT INTO opening_plan_state (workspace_id, day, hard_blocks_fingerprint)
      VALUES (${scope.workspaceId}, ${day}::date, '') ON CONFLICT (workspace_id, day) DO NOTHING`;
    const [state] = await tx`SELECT accepted_version, accepted_blocks, hard_blocks_fingerprint FROM opening_plan_state
      WHERE workspace_id=${scope.workspaceId} AND day=${day}::date FOR UPDATE`;
    const [draft] = await tx`SELECT * FROM opening_plan_drafts
      WHERE id=${input.draftId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
    if (!draft) throw new OpeningPlanError("NOT_FOUND", "draft not found");
    const suggestions = suggestedTaskSchema.array().parse(draft.suggested_tasks ?? []);
    const known = new Set(suggestions.map(item => item.key));
    let selection = [...new Set(input.acceptSuggestedKeys ?? [...known])].sort();
    if (selection.some(key => !known.has(key))) throw new OpeningPlanError("VALIDATION", "unknown suggested task key");
    // Preserve receipts created before adaptive planning for ordinary drafts.
    const payloadHash = createHash("sha256").update(JSON.stringify({
      draftId: input.draftId, expectedBaseVersion: input.expectedBaseVersion,
      ...(options.source === "coach" ? { source: "coach", expectedDraftVersion: options.expectedDraftVersion }
        : suggestions.length ? { acceptSuggestedKeys: selection } : {}),
    })).digest("hex");
    const [receipt] = await tx`SELECT draft_id, payload_hash FROM opening_plan_acceptances
      WHERE workspace_id=${scope.workspaceId} AND client_key=${input.clientKey} FOR UPDATE`;
    if (receipt) {
      if (receipt.payload_hash !== payloadHash) throw new OpeningPlanError("CONFLICT", "clientKey selection differs", "selection_mismatch");
      if (draft.origin === "agent") {
        const meta = conversationPlanMetadataSchema.parse((draft.input_snapshot as { conversationPlan?: unknown } | null)?.conversationPlan);
        await admitOpeningConversationPlanReplay(tx, scope, meta.candidateId);
        await assertOpeningConversationPlanCourse(tx, scope, meta.courseId);
      }
      return draft;
    }
    await assertOpeningLearningManagementDraft(tx, scope, draft, now);
    if (draft.status !== "draft" || Number(draft.base_version) !== input.expectedBaseVersion
      || Number(state!.accepted_version) !== input.expectedBaseVersion
      || (draft.strategy_version !== "local-replan-v1" && state!.hard_blocks_fingerprint && state!.hard_blocks_fingerprint !== draft.hard_blocks_fingerprint)) {
      throw new OpeningPlanError("CONFLICT", "plan or draft changed; refresh", "stale_version");
    }
    const unplaced = new Set((draft.unscheduled_task_ids ?? []) as string[]);
    const parsedBlocks = plannedBlockSchema.array().max(200).safeParse(draft.blocks ?? []);
    if (!parsedBlocks.success) throw new OpeningPlanError("CONFLICT", "invalid stored plan blocks", "stale_version");
    const originalBlocks = parsedBlocks.data;
    if (options.source === "coach") {
      selection = (await assertCoachAcceptance(tx, scope, { day, draft, state: state!, blocks: originalBlocks, now, expectedDraftVersion: options.expectedDraftVersion })).acceptKeys;
    }
    const placed = new Set(originalBlocks.map(block => block.taskId));
    const selected = suggestions.filter(item => selection.includes(item.key) && placed.has(item.id) && !unplaced.has(item.id));
    if (draft.origin !== "agent") await assertOpeningSuggestedSelectionAllowed(tx, scope, day, selected);
    const conversationPlan = (draft.input_snapshot as { conversationPlan?: unknown } | null)?.conversationPlan;
    if (draft.origin === "agent" && (!conversationPlan || !localStrategy(draft) || suggestions.length !== 1 || selected.length !== 1)) throw new OpeningPlanError("VALIDATION", "invalid conversation draft");
    const savedMaterials = (draft.input_snapshot as { courseMaterialRevisions?: Record<string, string> } | null)?.courseMaterialRevisions;
    if (draft.origin !== "agent" && selected.some(item => item.courseId !== null)) {
      const current = new Map((await readOpeningLearnerSnapshotCourses(tx, scope)).map(course => [course.courseId, course.materialRevision]));
      if (selected.some(item => item.courseId !== null && (!savedMaterials?.[item.courseId]
        || savedMaterials[item.courseId] !== current.get(item.courseId)))) {
        throw new OpeningPlanError("CONFLICT", "course materials changed since generation", "source_unavailable");
      }
    }
    const selectedIds = new Set(selected.map(item => item.id));
    const suggestionIds = new Set(suggestions.map(item => item.id));
    const blocks = originalBlocks.filter(block => !suggestionIds.has(block.taskId) || selectedIds.has(block.taskId));
    if (draft.strategy_version && draft.strategy_version !== "local-replan-v1" && blocks.some(block => Date.parse(block.start) < now.getTime())) {
      throw new OpeningPlanError("CONFLICT", "a planned slot has expired", "slot_expired");
    }
    const local = draft.strategy_version === "local-replan-v1";
    if (local) {
      await validateOpeningLocalReplan(tx, scope, { day, state: state!, draft, blocks, now });
    } else {
      if ((draft.input_snapshot as { localReplan?: unknown } | null)?.localReplan) throw new OpeningPlanError("CONFLICT", "invalid local strategy", "stale_version");
      await assertOpeningPlanConstraints(tx, scope, day, blocks,
        (draft.input_snapshot as { autoDraft?: boolean } | null)?.autoDraft === true);
    }
    const taskIds = [...new Set(blocks.filter(block => !suggestionIds.has(block.taskId)).map(block => block.taskId))];
    if (!local && taskIds.length) {
      const tasks = await tx`SELECT id, version, status, not_before FROM opening_tasks
        WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND id IN ${tx(taskIds)}
        ORDER BY id FOR UPDATE`;
      const snapshot = (draft.input_snapshot as { tasks?: TaskItem[] } | null)?.tasks ?? [];
      if (tasks.length !== taskIds.length || tasks.some(task => task.status !== "pending"
        || Number(task.version) !== snapshot.find(original => original.id === task.id)?.version
        || blocks.some(block => block.taskId === task.id && task.not_before && Date.parse(block.start) < new Date(task.not_before as string | Date).getTime()))) {
        throw new OpeningPlanError("CONFLICT", "a planned task changed", "task_changed");
      }
    }
    const createdTaskVersions: Record<string, number> = {};
    for (const item of selected) {
      if (draft.origin === "agent") {
        const created = await consumeOpeningConversationPlanCandidate(tx, scope, conversationPlan, item);
        createdTaskVersions[created.taskId] = created.version;
        continue;
      }
      if (parseSuggestionKey(item.key)?.date !== day) throw new OpeningPlanError("VALIDATION", "invalid suggestion identity");
      if (item.courseId) {
        const available = await tx`SELECT c.id FROM courses c
          JOIN course_asset_memberships m ON m.course_id=c.id AND m.workspace_id=c.workspace_id AND m.asset_type='source'
          JOIN opening_sources s ON s.id=m.asset_id AND s.workspace_id=m.workspace_id
          WHERE c.id=${item.courseId} AND c.workspace_id=${scope.workspaceId} AND c.archived_at IS NULL
            AND s.upload_state='uploaded' AND s.parse_state='ready'
            AND EXISTS (SELECT 1 FROM opening_source_chunks k WHERE k.source_id=s.id AND k.source_version=s.version)
            AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
          ORDER BY s.id LIMIT 1 FOR SHARE OF c, m, s`;
        if (!available.length) throw new OpeningPlanError("CONFLICT", "course material unavailable", "source_unavailable");
      }
      const inserted = await tx`INSERT INTO opening_tasks
        (id, workspace_id, owner_user_id, title, minutes, due_at, priority, status, version, client_key, course_id, skill_label, requirement_key, origin)
        VALUES (${item.id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${item.title}, ${item.minutes}, NULL, 0, 'pending', 1,
          ${item.key}, ${item.courseId}, ${item.skillLabel}, ${item.requirementKey ?? null}, 'planner')
        ON CONFLICT (workspace_id, owner_user_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING id, version`;
      for (const task of inserted) createdTaskVersions[String(task.id)] = Number(task.version);
      const [task] = await tx`SELECT id, title, minutes, status, version, course_id, skill_label, requirement_key, origin FROM opening_tasks
        WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${item.key} FOR UPDATE`;
      if (!task || task.id !== item.id || task.status !== 'pending' || Number(task.version) !== 1
        || task.title !== item.title || Number(task.minutes) !== item.minutes || task.course_id !== item.courseId
        || task.skill_label !== item.skillLabel || task.requirement_key !== (item.requirementKey ?? null) || task.origin !== 'planner') {
        throw new OpeningPlanError("CONFLICT", "suggested task already changed", "task_changed");
      }
    }
    const nextVersion = Number(state!.accepted_version) + 1;
    await tx`UPDATE opening_plan_state SET accepted_version=${nextVersion}, accepted_blocks=${tx.json(blocks)},
      hard_blocks_fingerprint=${draft.hard_blocks_fingerprint}, updated_at=now()
      WHERE workspace_id=${scope.workspaceId} AND day=${day}::date`;
    const [updated] = await tx`UPDATE opening_plan_drafts SET status='accepted', version=${nextVersion},
      blocks=${tx.json(blocks)}, updated_at=now() WHERE id=${input.draftId} RETURNING *`;
    await tx`INSERT INTO opening_plan_acceptances (workspace_id, client_key, draft_id, day, accepted_version, payload_hash, source, before_blocks, created_task_versions)
      VALUES (${scope.workspaceId}, ${input.clientKey}, ${input.draftId}, ${day}::date, ${nextVersion}, ${payloadHash},
        ${options.source ?? "learner"}, ${tx.json(state!.accepted_blocks ?? [])}, ${tx.json(createdTaskVersions)})`;
    return updated!;
  });
}

function localStrategy(draft: Record<string, unknown>): boolean { return draft.strategy_version === "local-replan-v1"; }
