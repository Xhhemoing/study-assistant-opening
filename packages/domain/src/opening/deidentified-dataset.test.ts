import { describe, expect, it } from "vitest";
import { projectOpeningDataset } from "./deidentified-dataset";

const scope = { workspaceId: "workspace-private", ownerUserId: "user-private" };
const row = { id: "turn-private", workspace_id: scope.workspaceId, conversation_id: "conversation-private", source_ids: [], role: "user", status: "complete", text: "secret@example.com", object_key: "private/object", created_at: "2026-10-31T12:00:00Z" };
const token = (kind: string, id: string) => `opaque-${kind}-${id.length}`;
describe("deidentified dataset projection", () => {
  it("uses only allowlisted categorical fields and opaque relationships", () => {
    const result = projectOpeningDataset({ scope, privacyEpoch: 0, tables: {
      opening_conversations: [{ id: row.conversation_id, workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId }],
      opening_turns: [row, { ...row, id: "reply-private", role: "assistant" }],
    } }, token);
    expect(result.dialogueEvaluation).toHaveLength(2);
    expect(result.dialogueEvaluation[0].sequence).toBe(result.dialogueEvaluation[1].sequence);
    for (const secret of [scope.workspaceId, scope.ownerUserId, row.id, row.text, row.object_key]) expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("rejects foreign ownership, missing source lineage and deleted turns", () => {
    const project = (tables: Record<string, Record<string, unknown>[]>, deletedTurnIds: string[] = []) => projectOpeningDataset({scope,privacyEpoch:1,tables,deletedTurnIds},token);
    const conversation = { id: row.conversation_id,workspace_id:scope.workspaceId,owner_user_id:scope.ownerUserId };
    expect(project({opening_conversations:[{...conversation,owner_user_id:'foreign'}],opening_turns:[row]}).dialogueEvaluation).toEqual([]);
    expect(project({opening_conversations:[conversation],opening_turns:[{...row,source_ids:['missing']}]}).dialogueEvaluation).toEqual([]);
    expect(project({opening_conversations:[conversation],opening_turns:[row]},[row.id]).dialogueEvaluation).toEqual([]);
    expect(project({opening_teaching_activities:[{...row,owner_user_id:'foreign'}]}).coursePackageQuality).toEqual([]);
  });
  it("never passes arbitrary outcomes or status text through the allowlist", () => {
    const activity = {id:'activity',workspace_id:scope.workspaceId,owner_user_id:scope.ownerUserId,source_ids:[],generate_status:'secret@example.com'};
    const result = projectOpeningDataset({scope,privacyEpoch:0,tables:{
      opening_teaching_activities:[activity],
      opening_learning_attempts:[{...activity,id:'attempt',activity_id:'activity',observation_id:'observation'}],
      opening_learning_observations:[{...activity,id:'observation',source_turn_ids:[],outcome:'secret@example.com'}],
    }},token);
    expect(result.answerSequences[0].outcome).toBe('unknown');
    expect(result.coursePackageQuality[0].generated).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret@example.com');
  });
});
