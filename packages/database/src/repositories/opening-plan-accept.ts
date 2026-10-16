import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { suggestedTaskSchema, type AcceptPlanInput, type PlannedBlock, type Scope, type TaskItem } from "@aistudy/contracts";
import { parseSuggestionKey } from "@aistudy/domain";
import { OpeningPlanError } from "./opening-plan-error";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";

/** One transaction owns selection, task creation and the accepted plan version. */
export async function acceptOpeningPlan(sql: Sql, scope: Scope, input: AcceptPlanInput, now: Date) {
  return sql.begin(async tx => {
    const [located] = await tx`SELECT day FROM opening_plan_drafts
      WHERE id=${input.draftId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    if (!located) throw new OpeningPlanError("NOT_FOUND", "draft not found");
    const day = new Date(located.day as string | Date).toISOString().slice(0, 10);
    // Same day lock as auto-draft recomputation, before any workspace/row lock.
    const digest = createHash("sha256").update(`opening-daily-draft:${scope.workspaceId}:${day}`).digest();
    await tx`SELECT pg_advisory_xact_lock(${digest.readInt32BE(0)}, ${digest.readInt32BE(4)})`;
    await lockWorkspaceLearningHistory(tx, scope);
    await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
    await tx`INSERT INTO opening_plan_state (workspace_id, day, hard_blocks_fingerprint)
      VALUES (${scope.workspaceId}, ${day}::date, '') ON CONFLICT (workspace_id, day) DO NOTHING`;
    const [state] = await tx`SELECT accepted_version, hard_blocks_fingerprint FROM opening_plan_state
      WHERE workspace_id=${scope.workspaceId} AND day=${day}::date FOR UPDATE`;
    const [draft] = await tx`SELECT * FROM opening_plan_drafts
      WHERE id=${input.draftId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
    if (!draft) throw new OpeningPlanError("NOT_FOUND", "draft not found");
    const suggestions = suggestedTaskSchema.array().parse(draft.suggested_tasks ?? []);
    const known = new Set(suggestions.map(item => item.key));
    const selection = [...new Set(input.acceptSuggestedKeys ?? [...known])].sort();
    if (selection.some(key => !known.has(key))) throw new OpeningPlanError("VALIDATION", "unknown suggested task key");
    // Preserve receipts created before adaptive planning for ordinary drafts.
    const payloadHash = createHash("sha256").update(JSON.stringify({
      draftId: input.draftId, expectedBaseVersion: input.expectedBaseVersion,
      ...(suggestions.length ? { acceptSuggestedKeys: selection } : {}),
    })).digest("hex");
    const [receipt] = await tx`SELECT draft_id, payload_hash FROM opening_plan_acceptances
      WHERE workspace_id=${scope.workspaceId} AND client_key=${input.clientKey} FOR UPDATE`;
    if (receipt) {
      if (receipt.payload_hash !== payloadHash) throw new OpeningPlanError("CONFLICT", "clientKey selection differs", "selection_mismatch");
      return draft;
    }
    if (draft.status !== "draft" || Number(draft.base_version) !== input.expectedBaseVersion
      || Number(state!.accepted_version) !== input.expectedBaseVersion
      || (state!.hard_blocks_fingerprint && state!.hard_blocks_fingerprint !== draft.hard_blocks_fingerprint)) {
      throw new OpeningPlanError("CONFLICT", "plan or draft changed; refresh", "stale_version");
    }
    const unplaced = new Set((draft.unscheduled_task_ids ?? []) as string[]);
    const originalBlocks = (draft.blocks ?? []) as PlannedBlock[];
    const placed = new Set(originalBlocks.map(block => block.taskId));
    const selected = suggestions.filter(item => selection.includes(item.key) && placed.has(item.id) && !unplaced.has(item.id));
    const selectedIds = new Set(selected.map(item => item.id));
    const suggestionIds = new Set(suggestions.map(item => item.id));
    const blocks = originalBlocks.filter(block => !suggestionIds.has(block.taskId) || selectedIds.has(block.taskId));
    if (draft.strategy_version && blocks.some(block => Date.parse(block.start) < now.getTime())) {
      throw new OpeningPlanError("CONFLICT", "a planned slot has expired", "slot_expired");
    }
    const taskIds = [...new Set(blocks.filter(block => !suggestionIds.has(block.taskId)).map(block => block.taskId))];
    if (taskIds.length) {
      const tasks = await tx`SELECT id, version, status FROM opening_tasks
        WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND id IN ${tx(taskIds)}
        ORDER BY id FOR UPDATE`;
      const snapshot = (draft.input_snapshot as { tasks?: TaskItem[] } | null)?.tasks ?? [];
      if (tasks.length !== taskIds.length || tasks.some(task => task.status !== "pending"
        || Number(task.version) !== snapshot.find(original => original.id === task.id)?.version)) {
        throw new OpeningPlanError("CONFLICT", "a planned task changed", "task_changed");
      }
    }
    for (const item of selected) {
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
      await tx`INSERT INTO opening_tasks
        (id, workspace_id, owner_user_id, title, minutes, due_at, priority, status, version, client_key, course_id, skill_label, origin)
        VALUES (${item.id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${item.title}, ${item.minutes}, NULL, 0, 'pending', 1,
          ${item.key}, ${item.courseId}, ${item.skillLabel}, 'planner')
        ON CONFLICT (workspace_id, owner_user_id, client_key) WHERE client_key IS NOT NULL DO NOTHING`;
      const [task] = await tx`SELECT id, title, minutes, status, version, course_id, skill_label, origin FROM opening_tasks
        WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${item.key} FOR UPDATE`;
      if (!task || task.id !== item.id || task.status !== 'pending' || Number(task.version) !== 1
        || task.title !== item.title || Number(task.minutes) !== item.minutes || task.course_id !== item.courseId
        || task.skill_label !== item.skillLabel || task.origin !== 'planner') {
        throw new OpeningPlanError("CONFLICT", "suggested task already changed", "task_changed");
      }
    }
    const nextVersion = Number(state!.accepted_version) + 1;
    await tx`UPDATE opening_plan_state SET accepted_version=${nextVersion}, accepted_blocks=${tx.json(blocks)},
      hard_blocks_fingerprint=${draft.hard_blocks_fingerprint}, updated_at=now()
      WHERE workspace_id=${scope.workspaceId} AND day=${day}::date`;
    const [updated] = await tx`UPDATE opening_plan_drafts SET status='accepted', version=${nextVersion},
      blocks=${tx.json(blocks)}, updated_at=now() WHERE id=${input.draftId} RETURNING *`;
    await tx`INSERT INTO opening_plan_acceptances (workspace_id, client_key, draft_id, day, accepted_version, payload_hash)
      VALUES (${scope.workspaceId}, ${input.clientKey}, ${input.draftId}, ${day}::date, ${nextVersion}, ${payloadHash})`;
    return updated!;
  });
}
