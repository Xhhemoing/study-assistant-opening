import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createOpeningMaterialManifestRepository,createOpeningTeachingActivitiesRepository,createOpeningTeachingContentRepository,createOpeningLearningRepository,createOpeningLearningAttemptRepository,deliverMaterialAnswers} from '@aistudy/database';
import {createOpeningFixture,type OpeningFixture} from './opening-fixture';
import {learningAttemptFixture} from './opening-learning-attempt-fixture';
let f:OpeningFixture;
beforeAll(async()=>{f=await createOpeningFixture();});beforeEach(async()=>{await f.reset();});afterAll(async()=>{await f.close();});
it('blocks saved teaching derived from newly restricted pages without rewriting the saved body or learner facts',async()=>{
 const base=await learningAttemptFixture(f),{sql,scope}=f;
 await sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text) VALUES(${base.sourceId},1,2,'secret solution')`;
 const activity=await createOpeningTeachingActivitiesRepository(sql).create(scope,{clientKey:randomUUID(),intentKind:'topic',intentSummary:'unit',courseId:base.courseId,sourceIds:[base.sourceId],createIntent:{}});
 const content=createOpeningTeachingContentRepository(sql),blockId=randomUUID();
 const unit=await content.createUnit(scope,{title:'unit',blocks:[{id:blockId,type:'text',content:{text:'saved secret solution'}}]});
 await content.publishActivitySpec(scope,{activityId:activity.id,teachingUnitId:unit.id,expectedVersion:0,expectedRevisionNumber:1,revisionNumber:1,
  blockOrder:[{blockId,position:0,role:'teach',blockType:'text'}],sourceRefs:[{sourceId:base.sourceId,version:1,page:2}]});
 expect(JSON.stringify(await content.getClientInit(scope,activity.id))).toContain('saved secret solution');
 await createOpeningMaterialManifestRepository(sql).write(scope,base.sourceId,{sourceVersion:1,expectedRevision:0,manifest:{role:'mixed',sections:[{startPage:1,endPage:1,role:'exercise'},{startPage:2,endPage:2,role:'answer_key'}],questions:[],answers:[]}});
 await expect(content.getClientInit(scope,activity.id)).rejects.toMatchObject({code:'CONFLICT'});
 await expect(content.readRevision(scope,unit.documentId,1)).rejects.toMatchObject({code:'CONFLICT'});
 const [row]=await sql`SELECT blocks FROM library_revisions WHERE document_id=${unit.documentId} AND revision_number=1`;
 expect(JSON.stringify(row!.blocks)).toContain('saved secret solution');
});
it('answer delivery has one durable solution receipt and never releases before a submitted attempt',async()=>{
 const base=await learningAttemptFixture(f),{sql,scope}=f;
 await sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text) VALUES(${base.sourceId},1,2,'secret')`;
 const key={family:'T1',number:'1',subquestion:''};
 await createOpeningMaterialManifestRepository(sql).write(scope,base.sourceId,{sourceVersion:1,expectedRevision:0,manifest:{role:'mixed',sections:[{startPage:1,endPage:1,role:'exercise'},{startPage:2,endPage:2,role:'answer_key'}],questions:[{...key,page:1,stem:'1/2 + 1/2?'}],answers:[{page:2,questionSourceId:base.sourceId,questionSourceVersion:1,question:key,text:'1',status:'unverified',reason:''}]}});
 const a=await createOpeningLearningAttemptRepository(sql).create(scope,{sessionId:base.sessionId,clientKey:randomUUID(),materialQuestion:{sourceId:base.sourceId,sourceVersion:1,...key}});
 await expect(deliverMaterialAnswers(sql,scope,a.id)).rejects.toMatchObject({code:'CONFLICT'});
 await base.submit(a,{outcome:'unverified'});
 expect(await deliverMaterialAnswers(sql,scope,a.id)).toEqual([expect.objectContaining({text:'1'})]);
 await deliverMaterialAnswers(sql,scope,a.id);
 expect(await sql`SELECT kind,level,delivered FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId} AND release_key=${`material-answer:${a.id}`}`).toEqual([{kind:'solution',level:'revealed',delivered:true}]);
 const otherSession=await createOpeningLearningRepository(sql).createSession(scope,{courseId:base.courseId,skillLabel:'other',sourceIds:[base.sourceId]});
 expect(otherSession.id).not.toBe(base.sessionId);
});
