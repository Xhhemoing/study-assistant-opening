import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,expect,it } from "vitest";
import { createOpeningMaterialManifestRepository,createOpeningSourceChunksRepository,createOpeningSourceEmbeddingsRepository,createOpeningLearningAttemptRepository,
  readOpeningSourceContent,readMaterialAnswers,createOpeningAiGradingRepository,readOpeningCourseEvidence,readOpeningBackupRecords } from "@aistudy/database";
import { createOpeningFixture,type OpeningFixture } from "./opening-fixture";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
let fixture:OpeningFixture;
beforeAll(async()=>{fixture=await createOpeningFixture();});
beforeEach(async()=>{await fixture.reset();});
afterAll(async()=>{await fixture.close();});
async function setup(stem='1/2 + 1/2?') {
 const f=await learningAttemptFixture(fixture),{sql,scope}=fixture;
 await sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text) VALUES(${f.sourceId},1,2,'SECRET ANSWER 1')`;
 const key={family:'T1',number:'1',subquestion:''};
 const manifest={role:'mixed',sections:[{startPage:1,endPage:1,role:'exercise'},{startPage:2,endPage:2,role:'answer_key'}],
  questions:[{...key,page:1,stem}],answers:[{page:2,questionSourceId:f.sourceId,questionSourceVersion:1,question:key,text:'1',status:'unverified',reason:''}]};
 const repo=createOpeningMaterialManifestRepository(sql);
 await repo.write(scope,f.sourceId,{sourceVersion:1,expectedRevision:0,manifest});
 const start=()=>createOpeningLearningAttemptRepository(sql).create(scope,{sessionId:f.sessionId,clientKey:randomUUID(),materialQuestion:{sourceId:f.sourceId,sourceVersion:1,...key}});
 return {...f,repo,manifest,key,start};
}
it('persists version-pinned roles and excludes answers from chunks, lexical authorization and page reader',async()=>{
 const f=await setup(),{sql,scope}=fixture;
 const row=await f.repo.read(scope,f.sourceId);expect(row).toMatchObject({revision:1,reviewedBy:scope.ownerUserId});
 const chunks=await createOpeningSourceChunksRepository(sql).listForSources(scope,[f.sourceId]);expect(chunks.map(c=>c.page)).toEqual([1]);
 const [raw]=await sql`SELECT * FROM opening_source_chunks WHERE source_id=${f.sourceId} AND page=2`;
 const auth=await createOpeningSourceEmbeddingsRepository(sql).authorizeChunks(scope,[{id:raw!.id,sourceId:f.sourceId,sourceVersion:1,page:2,startMs:null,endMs:null,text:'SECRET ANSWER 1',imageObjectKey:null}]);
 expect(auth.chunks).toEqual([]);
 await expect(readOpeningSourceContent(sql,scope,f.sourceId,{version:1,page:2})).rejects.toMatchObject({code:'CONFLICT'});
 await expect(f.repo.write(fixture.otherScope,f.sourceId,{sourceVersion:1,expectedRevision:1,manifest:f.manifest})).rejects.toMatchObject({code:'CONFLICT'});
 await expect(f.repo.write(scope,f.sourceId,{sourceVersion:1,expectedRevision:0,manifest:f.manifest})).rejects.toMatchObject({code:'CONFLICT'});
});
it('reuses canonical original-question identity across sessions and releases only linked answers after saved submission',async()=>{
 const f=await setup(),{scope}=fixture;
 const a=await f.start();
 await expect(readMaterialAnswers(fixture.sql,scope,a.id)).rejects.toMatchObject({code:'CONFLICT'});
 await f.submit(a,{outcome:'unverified'});
 const b=await f.start();expect(b.problemId).toBe(a.problemId);expect(b.itemVersionId).toBe(a.itemVersionId);
 const answers=await readMaterialAnswers(fixture.sql,scope,a.id);expect(answers).toHaveLength(1);expect(answers[0]).toMatchObject({text:'1',status:'unverified',reviewedBy:scope.ownerUserId});
 await expect(readMaterialAnswers(fixture.sql,fixture.otherScope,a.id)).rejects.toMatchObject({code:'CONFLICT'});
 expect((await readOpeningBackupRecords(fixture.sql,scope)).tables.opening_source_versions).toEqual(expect.arrayContaining([expect.objectContaining({material_manifest:expect.objectContaining({questions:f.manifest.questions,answers:expect.arrayContaining([expect.objectContaining(f.manifest.answers[0]!)])})})]));
});
it('rejects repeated body identity, answer-page questions and forged answer linkage without partial writes',async()=>{
 const f=await setup(),{scope,sql}=fixture;
 for(const manifest of [{...f.manifest,questions:[...f.manifest.questions,...f.manifest.questions]},
  {...f.manifest,questions:[{...f.manifest.questions[0]!,page:2}]},
  {...f.manifest,answers:[{...f.manifest.answers[0]!,questionSourceId:randomUUID()}]}]) {
   await expect(f.repo.write(scope,f.sourceId,{sourceVersion:1,expectedRevision:1,manifest})).rejects.toThrow();
 }
 expect((await f.repo.read(scope,f.sourceId)).revision).toBe(1);
 const [r]=await sql`SELECT count(*)::int AS n FROM opening_source_versions WHERE source_id=${f.sourceId}`;expect(r!.n).toBe(1);
});
it('marks a disputed answer unscored without rewriting the saved observation or adding weakness',async()=>{
 const f=await setup('解释单位圆'),{scope,sql}=fixture;
 const a=await f.start(),o=await f.submit(a,{outcome:'unverified'});
 const grades=createOpeningAiGradingRepository(sql);

 const graded=await grades.apply(scope,{observationId:o.id},{outcome:'incorrect',confidence:.99,questionMatch:true,feedback:'检查结果',criteria:[{label:'结果',verdict:'incorrect',feedback:'需修正'}]},'fixture');
 expect(graded.outcome).toBe('incorrect');
 const manifest={...f.manifest,answers:[{...f.manifest.answers[0]!,status:'disputed',reason:'待核验共轭符号'}]};
 await f.repo.write(scope,f.sourceId,{sourceVersion:1,expectedRevision:1,manifest});
 await expect(grades.context(scope,{observationId:graded.id})).rejects.toMatchObject({code:'CONFLICT'});
 const evidence=await readOpeningCourseEvidence(sql,scope,f.courseId);
 const input=evidence.evidenceContexts[graded.id]!;
 expect(evaluateEvidenceEligibility(input.observation,input.context)).toMatchObject({verifiedCorrect:'unknown',usableForCurrentVersion:'no',reasonCodes:expect.arrayContaining(['material_answer_disputed'])});
 const [projection]=await sql`SELECT * FROM opening_learning_eligibility WHERE root_observation_id=${o.id}`;
 if(projection) expect(projection.usable_for_current_version).not.toBe('yes');
 const [saved]=await sql`SELECT answer,outcome FROM opening_learning_observations WHERE id=${graded.id}`;
 expect(saved).toMatchObject({answer:'1',outcome:'incorrect'});
});
