import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpeningDatasetRepository } from "../../packages/database/src/repositories/opening-dataset";
import { OPENING_DATASET_POLICY_VERSION } from "@aistudy/contracts";
import { createOpeningPrivacyRepository, createOpeningMemoryRepository } from "@aistudy/database";
import { createOpeningFixture, insertTestTeachingActivity, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
let repo: ReturnType<typeof createOpeningDatasetRepository>;
const grant = () => repo.grantConsent(f.scope, { policyVersion: OPENING_DATASET_POLICY_VERSION, consented: true, expiresAt: new Date(Date.now() + 3600000).toISOString() });
beforeAll(async () => { f = await createOpeningFixture(); repo = createOpeningDatasetRepository(f.sql); });
afterAll(async () => { await f?.close(); });

describe("synthetic deidentified dataset repository", () => {
  it("gates all three views on explicit versioned, unexpired, unrevoked epoch consent", async () => {
    await expect(repo.read(f.scope)).rejects.toThrow(/consent/);
    await expect(repo.grantConsent(f.scope, { policyVersion: "wrong", consented: true, expiresAt: new Date(Date.now() + 3600000).toISOString() } as never)).rejects.toThrow(/consent/);
    const id = await grant();
    await expect(repo.read({ ...f.scope, ownerUserId: f.otherScope.ownerUserId })).rejects.toThrow();
    await expect(repo.revokeConsent(f.otherScope, id)).rejects.toThrow();
    await repo.revokeConsent(f.scope, id);
    await expect(repo.read(f.scope)).rejects.toThrow(/consent/);
    const newer = await grant();
    await f.sql`UPDATE opening_dataset_consents SET expires_at=now()-interval '1 second', granted_at=now()-interval '1 hour' WHERE id=${newer}`;
    await expect(repo.read(f.scope)).rejects.toThrow(/consent/);
    await grant();
    await f.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${f.scope.workspaceId}`;
    await expect(repo.read(f.scope)).rejects.toThrow(/consent/);
  });

  it("joins within an export, rotates identities, excludes deleted source and memory lineage", async () => {
    const source = randomUUID(), conversation = randomUUID(), turn = randomUUID();
    await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
      VALUES(${source},${f.scope.workspaceId},'private@example.com','application/pdf',1,${'a'.repeat(64)},0,'uploaded','ready')`;
    const activity = await insertTestTeachingActivity(f.sql, f.scope);
    await f.sql`UPDATE opening_teaching_activities SET source_ids=${[source]}::uuid[],generate_status='ready' WHERE id=${activity}`;
    await f.sql`INSERT INTO opening_conversations(id,workspace_id,owner_user_id,title) VALUES(${conversation},${f.scope.workspaceId},${f.scope.ownerUserId},'secret')`;
    await f.sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status,source_ids,source_versions)
      VALUES(${turn},${f.scope.workspaceId},${conversation},'user','private@example.com','explain','complete',${[source]}::uuid[],${f.sql.json({[source]:0})})`;
    const session = randomUUID(), attempt = randomUUID();
    await f.sql`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,activity_id,skill_label,source_ids) VALUES(${session},${f.scope.workspaceId},${f.scope.ownerUserId},${activity},'secret',${[source]}::uuid[])`;
    await f.sql`INSERT INTO opening_learning_attempts(id,workspace_id,owner_user_id,session_id,activity_id,skill_label,source_ids,source_versions,client_key,create_intent,history_revision)
      VALUES(${attempt},${f.scope.workspaceId},${f.scope.ownerUserId},${session},${activity},'secret',${[source]}::uuid[],${f.sql.json({[source]:0})},${randomUUID()},'{}',0)`;
    await grant();
    const a = await repo.read(f.scope), b = await repo.read(f.scope);
    expect(a.dialogueEvaluation).toHaveLength(1);
    expect(a.answerSequences).toHaveLength(1);
    expect(a.coursePackageQuality).toHaveLength(1);
    expect(a.answerSequences[0].sequence).toBe(a.coursePackageQuality[0].identity);
    expect(a.dialogueEvaluation[0].sources).toEqual(a.coursePackageQuality[0].sources);
    expect(a.dialogueEvaluation[0].identity).not.toBe(b.dialogueEvaluation[0].identity);
    for (const secret of [source,turn,attempt,activity,conversation,f.scope.workspaceId,f.scope.ownerUserId,'private@example.com','secret']) expect(JSON.stringify(a)).not.toContain(secret);
    const privacy = createOpeningPrivacyRepository(f.sql);
    await privacy.recordExclusions(f.sql,f.scope,{ sourceIds:[source],memoryId:randomUUID(),deletedAt:new Date() });
    await expect(repo.read(f.scope)).rejects.toThrow(/consent/);
    await grant();
    const after = await repo.read(f.scope);
    expect(after.dialogueEvaluation).toEqual([]);
    expect(after.answerSequences).toEqual([]);
    expect(after.coursePackageQuality).toEqual([]);
    const bare = randomUUID();
    await f.sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status,source_ids,source_versions)
      VALUES(${bare},${f.scope.workspaceId},${conversation},'user','memory-private','explain','complete','{}','{}')`;
    const memories = createOpeningMemoryRepository(f.sql);
    const memory = await memories.proposeMemory(f.scope,{text:'memory-private',sourceTurnIds:[bare],expiresAt:null});
    await memories.deleteMemory(f.scope,{id:memory.id,expectedVersion:memory.version,deleteSourceText:false,clientKey:randomUUID()});
    await expect(repo.read(f.scope)).rejects.toThrow(/consent/);
    await grant();
    expect((await repo.read(f.scope)).dialogueEvaluation).toEqual([]);
    await grantOther();
    expect((await repo.read(f.otherScope)).dialogueEvaluation).toEqual([]);
  });
});
async function grantOther() { await repo.grantConsent(f.otherScope,{policyVersion:OPENING_DATASET_POLICY_VERSION,consented:true,expiresAt:new Date(Date.now() + 3600000).toISOString()}); }
