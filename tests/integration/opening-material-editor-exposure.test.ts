import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,expect,it } from "vitest";
import { createOpeningMaterialManifestRepository, createOpeningLearningAttemptRepository, readOpeningCourseEvidence } from "@aistudy/database";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { createOpeningFixture,type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
let fixture:OpeningFixture;
beforeAll(async()=>{fixture=await createOpeningFixture();});
beforeEach(async()=>{await fixture.reset();});
afterAll(async()=>{await fixture.close();});
async function setup() {
 const f=await learningAttemptFixture(fixture),{sql,scope}=fixture;
 await sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text) VALUES(${f.sourceId},1,2,'private answer page')`;
 const question={family:'T1',number:'1',subquestion:''};
 const manifest={role:'mixed',sections:[{startPage:1,endPage:1,role:'exercise'},{startPage:2,endPage:2,role:'answer_key'}],
  questions:[{...question,page:1,stem:'1/2 + 1/2?'}],answers:[{page:2,questionSourceId:f.sourceId,questionSourceVersion:1,question,text:'THE SECRET ANSWER',status:'unverified',reason:''}]};
 const repo=createOpeningMaterialManifestRepository(sql);
 const result=await repo.write(scope,f.sourceId,{sourceVersion:1,expectedRevision:0,manifest});
 return {...f,repo,manifest,question,result};
}
it('ordinary classification reads and writes return no answer text, and metadata-only edits retain hidden answers',async()=>{
 const f=await setup(),{sql,scope}=fixture;
 expect(f.result).toMatchObject({answerCount:1,answersWithheld:true,manifest:{answers:[]}});
 expect(JSON.stringify(await f.repo.read(scope,f.sourceId))).not.toContain('THE SECRET ANSWER');
 const before=await sql`SELECT id FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId}`;
 await f.repo.read(scope,f.sourceId);
 expect(await sql`SELECT id FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId}`).toHaveLength(before.length);
 await f.repo.write(scope,f.sourceId,{sourceVersion:1,expectedRevision:1,manifest:{...f.manifest,answers:[]},mergeAnswerLinks:true});
 const [row]=await sql`SELECT material_manifest FROM opening_source_versions WHERE source_id=${f.sourceId} AND version=1`;
 expect(row!.material_manifest.answers).toEqual([expect.objectContaining(f.manifest.answers[0]!)]);
 expect(row!.material_manifest.answers[0]).toMatchObject({reviewedBy:scope.ownerUserId,reviewedAt:expect.any(String)});
});
it('explicit editor reveal records durable exposure before returning text and replay does not duplicate it',async()=>{
 const f=await setup(),{sql,scope}=fixture;
 const result=await f.repo.revealForEditing(scope,f.sourceId);
 expect(result).toMatchObject({answersWithheld:false,manifest:{answers:[{text:'THE SECRET ANSWER'}]}});
 const rows=await sql`SELECT delivered,level,kind,context_anchor FROM opening_help_exposures
  WHERE workspace_id=${scope.workspaceId} AND release_key LIKE 'material-editor:%'`;
 expect(rows).toEqual([expect.objectContaining({delivered:true,kind:'solution',level:'revealed',context_anchor:expect.objectContaining({sourceId:f.sourceId,sourceVersion:1,page:1})})]);
 await f.repo.revealForEditing(scope,f.sourceId);
 expect(await sql`SELECT id FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId} AND release_key LIKE 'material-editor:%'`).toHaveLength(1);
 await expect(f.repo.revealForEditing(fixture.otherScope,f.sourceId)).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('editor exposure before an attempt exists cannot become independent mastery in a later canonical attempt',async()=>{
 const f=await setup(),{sql,scope}=fixture;
 await f.repo.revealForEditing(scope,f.sourceId);
 const a=await createOpeningLearningAttemptRepository(sql).create(scope,{sessionId:f.sessionId,clientKey:randomUUID(),materialQuestion:{sourceId:f.sourceId,sourceVersion:1,...f.question}});
 const o=await f.submit(a,{outcome:'correct'});
 const input=(await readOpeningCourseEvidence(sql,scope,f.courseId)).evidenceContexts[o.id]!;
 expect(input.context.helpHistory!.exposures.some(h=>h.level==='revealed'&&h.delivered)).toBe(true);
 expect(evaluateEvidenceEligibility(input.observation,input.context).independentAttempt).not.toBe('yes');
});
