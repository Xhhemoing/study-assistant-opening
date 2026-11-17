import {setImmediate as nextTurn} from 'node:timers/promises';
import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import type {Sql} from 'postgres';
import {createOpeningTutorJobsRepository} from './opening-tutor-jobs';
import {sqlSimulation,unexpected} from './opening-resident-f8-sql-simulation';
const ports=vi.hoisted(()=>({resolve:vi.fn(),span:vi.fn(),invalidate:vi.fn(),goal:vi.fn(),requirements:vi.fn(),materials:vi.fn(),chunks:vi.fn(),observations:vi.fn(),course:vi.fn()}));
vi.mock('./opening-study-context',()=>({resolveOpeningStudyContext:ports.resolve,openingCanonicalLanguageQuestion:vi.fn()}));
vi.mock('./opening-span-tutor-origin',()=>({assertOpeningSpanTutorOriginCurrent:ports.span}));
vi.mock('./opening-learning-eligibility',()=>({invalidateOpeningLearningEligibility:ports.invalidate}));
vi.mock('./opening-learning-goals',()=>({readLearningGoal:ports.goal}));
vi.mock('./opening-course-route-read',()=>({assertCourseRouteCourse:ports.course,readCourseRequirements:ports.requirements,readCourseRouteMaterials:ports.materials,readCourseRouteSourceChunks:ports.chunks,readCourseRouteObservations:ports.observations}));
const id=(n:number)=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const scope={workspaceId:id(1),ownerUserId:id(2)},jobId=id(3),receiptId=id(4),activityId=id(5),courseId=id(6),retestId=id(7),sourceId=id(8),taskId=id(9);
const now='2026-01-02T10:00:00.000Z',earlier='2026-01-01T10:00:00.000Z';
const context={goalId:id(10),goalRevision:2,requirementId:id(11),requirementRevision:3,stableSkillId:id(12),requirementKey:'arithmetic',action:'transfer_check' as const,retestId};
const protocol={protocolId:'course-route-delayed-v1',goalId:context.goalId,goalRevision:2,requirementId:context.requirementId,requirementRevision:3,stableSkillId:context.stableSkillId,baselineObservationId:id(13),baselineRootId:id(14),originActivityId:id(15),minutes:20};
const requirement={id:context.requirementId,courseId,approvedAt:earlier,revision:3,requirementKey:'arithmetic',stableSkillId:context.stableSkillId,sourceRefs:[{sourceId,sourceVersion:1}]};
const anchor={purpose:'learning_help' as const,courseId,activityId,attemptId:null,itemVersionId:null};
const streamContext={privacyEpoch:4,contextSourceRefs:[],exposureReceiptId:receiptId,claimToken:id(16),executionId:id(17)};
function fixture(options:{released?:boolean;retestStatus?:string;deadline?:string|null;jobStatus?:string;privacy?:number;claim?:string;execution?:string;available?:boolean;exposureOwned?:boolean;noReceipt?:boolean;failWrite?:boolean}={}){
 const events:string[]=[];
 const job={id:jobId,workspace_id:scope.workspaceId,conversation_id:id(18),user_turn_id:id(19),assistant_turn_id:id(20),status:options.jobStatus??'running',mode:'hint',error:null,created_at:earlier,updated_at:now,claim_token:options.claim??streamContext.claimToken,timing_execution_id:options.execution??streamContext.executionId,attempt_id:null,context_anchor:anchor};
 const exposure={id:receiptId,workspace_id:scope.workspaceId,owner_user_id:scope.ownerUserId,release_key:'assistant:chain',context_anchor:anchor,exposure_origin:'assistant',support_domain:'math',hint_stage:null,initiated_by:null,help_input_snapshot:null,generated_at:earlier,released_at:options.released?earlier:null,acknowledged_at:null,history_revision:0,course_id:courseId,session_id:null,attempt_id:null,problem_id:null,release_intent:{}};
 const tx=sqlSimulation(q=>{
  const s=q.text;
  if(s.startsWith('SELECT id FROM workspaces')){events.push('history-owner');return [{id:scope.workspaceId}]}
  if(s.startsWith('INSERT INTO opening_workspace_history_revisions'))return [];
  if(s.startsWith('SELECT revision FROM opening_workspace_history_revisions')){events.push('history-lock');return [{revision:1}]}
  if(s.startsWith('SELECT privacy_epoch FROM workspaces'))return [{privacy_epoch:options.privacy??4}];
  if(s.startsWith('SELECT j.*,t.attempt_id,t.context_anchor')){events.push('job');return [job]}
  if(s.startsWith('SELECT 1 WHERE'))return options.available===false?[]:[{available:1}];
  if(s.startsWith('SELECT id FROM opening_help_exposures')){events.push('receipt-owner');return options.exposureOwned===false?[]:[{id:receiptId}]}
  if(s.startsWith('SELECT * FROM opening_help_exposures')){events.push('receipt');return [exposure]}
  if(s.startsWith('SELECT course_id,goal_json,create_intent')){events.push('route');return [{course_id:courseId,goal_json:{courseRoute:context},create_intent:{taskId}}]}
  if(s.startsWith('SELECT r.*,t.status AS task_status')){events.push('retest');return [{course_id:courseId,learning_protocol:protocol,status:options.retestStatus??'accepted',task_status:'pending',deadline_at:options.deadline??null,not_before_at:earlier,recommended_at:earlier,scheduled_start_at:null}]}
  if(s.startsWith('SELECT status FROM opening_tasks')){events.push('task');return [{status:'pending'}]}
  if(s.startsWith('INSERT INTO opening_learning_history_revisions')){events.push('course-revision');return [{revision:2}]}
  if(s.startsWith('UPDATE opening_workspace_history_revisions')){events.push('workspace-revision');return [{revision:3}]}
  if(s.startsWith('UPDATE opening_help_exposures')){events.push('release-write');if(options.failWrite)throw new Error('release write failed');return [{...exposure,released_at:now,history_revision:2}]}
  if(s.startsWith('SELECT DISTINCT COALESCE')){events.push('roots');return [{root_id:id(21)}]}
  return unexpected(q);
 });
 // A callback adapter only; no commit/rollback, SQL execution or isolation semantics.
 const outer=Object.assign(()=>{throw new Error('query escaped callback transaction')},{begin:async(fn:(value:typeof tx.sql)=>unknown)=>{events.push('begin');const result=await fn(tx.sql);events.push('return');return result}}) as unknown as Sql;
 ports.resolve.mockImplementation(async()=>{events.push('resolve');return anchor});ports.span.mockImplementation(async()=>{events.push('span')});ports.invalidate.mockImplementation(async()=>{events.push('invalidate')});
 return {tx,events,read:()=>createOpeningTutorJobsRepository(outer).readStream(scope,jobId,{...streamContext,...(options.noReceipt?{exposureReceiptId:null}:{})})};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date(now));vi.clearAllMocks();ports.course.mockResolvedValue(undefined);ports.requirements.mockResolvedValue([requirement]);ports.goal.mockResolvedValue({revision:2,courseIds:[courseId],lifecycle:'active'});ports.materials.mockResolvedValue([{sourceId,sourceVersion:1,available:true}]);ports.chunks.mockResolvedValue([{id:id(22),sourceId,sourceVersion:1,page:1}]);ports.observations.mockResolvedValue({raw:[{id:protocol.baselineObservationId,rootObservationId:protocol.baselineRootId}]})});
afterEach(()=>vi.useRealTimers());
describe('F8: saved stream to real release to route and retest gate (synthetic SQL)',()=>{
 it('valid stream reaches release only after route and retest, then invalidates before returning',async()=>{
  const f=fixture();await expect(f.read()).resolves.toMatchObject({id:jobId,status:'running'});
  expect(f.events).toEqual(['begin','history-owner','history-lock','job','receipt-owner','receipt','resolve','span','route','retest','task','course-revision','workspace-revision','release-write','roots','invalidate','return']);
  expect(ports.resolve).toHaveBeenCalledExactlyOnceWith(f.tx.sql,scope,anchor,{sessionId:null,sourceAccess:'ai',associationOnly:false});
  expect(ports.invalidate).toHaveBeenCalledExactlyOnceWith(f.tx.sql,scope,{rootIds:[id(21)]});
 });
 it.each([['completed',{retestStatus:'completed'}],['expired',{deadline:earlier}]])('%s retest rejects stream without release/history advancement',async(_name,options)=>{
  const f=fixture(options);await expect(f.read()).rejects.toMatchObject({code:'CONFLICT'});
  expect(f.events).toContain('retest');expect(f.events).not.toContain('task');expect(f.events).not.toContain('release-write');expect(f.events).not.toContain('course-revision');expect(f.events).not.toContain('return');expect(ports.invalidate).not.toHaveBeenCalled();
 });
 it('stale route fails before retest or release',async()=>{
  ports.goal.mockResolvedValue({revision:5,courseIds:[courseId],lifecycle:'active'});const f=fixture();await expect(f.read()).rejects.toMatchObject({code:'CONFLICT'});
  expect(f.events).toContain('route');expect(f.events).not.toContain('retest');expect(f.events).not.toContain('release-write');
 });
 it('already released receipt remains an idempotent replay despite a completed retest',async()=>{
  const f=fixture({released:true,retestStatus:'completed'});await expect(f.read()).resolves.toMatchObject({id:jobId});
  expect(f.events).toContain('receipt');expect(f.events).not.toContain('resolve');expect(f.events).not.toContain('route');expect(f.events).not.toContain('release-write');
 });
 it.each([
  ['privacy epoch',{privacy:5}],['claim token',{claim:id(25)}],['execution',{execution:id(25)}],['material availability',{available:false}],['assistant receipt ownership',{exposureOwned:false}],
 ])('%s failure stops before real release',async(_name,options)=>{
  const f=fixture(options);await expect(f.read()).rejects.toThrow();expect(f.events).not.toContain('receipt');expect(f.events).not.toContain('release-write');expect(ports.resolve).not.toHaveBeenCalled();
 });
 it('terminal job returns without release',async()=>{const f=fixture({jobStatus:'succeeded'});await expect(f.read()).resolves.toMatchObject({status:'succeeded'});expect(f.events).not.toContain('receipt-owner');expect(ports.resolve).not.toHaveBeenCalled()});
 it('existing optional no-receipt branch skips release',async()=>{const f=fixture({noReceipt:true});await expect(f.read()).resolves.toMatchObject({id:jobId});expect(f.events).not.toContain('receipt');expect(ports.resolve).not.toHaveBeenCalled()});
 it('pending real retest baseline read blocks release and stream return until resolved',async()=>{
  let resume!:(value:{raw:{id:string;rootObservationId:string}[]})=>void;let entered!:()=>void;
  const gate=new Promise<{raw:{id:string;rootObservationId:string}[]}>(resolve=>{resume=resolve});
  const reached=new Promise<void>(resolve=>{entered=resolve});
  ports.observations.mockImplementationOnce(()=>{entered();return gate});const f=fixture();const pending=f.read();
  const phase=await Promise.race([reached.then(()=>'gate'),pending.then(()=>'returned',()=>'rejected')]);
  try {
   expect(phase).toBe('gate');
   // Keep the gate closed across a real event-loop turn so detached continuations can advance.
   await nextTurn();
   expect(f.events).toContain('retest');expect(f.events).not.toContain('release-write');expect(f.events).not.toContain('return');
  } finally {resume({raw:[{id:protocol.baselineObservationId,rootObservationId:protocol.baselineRootId}]})}
  await expect(pending).resolves.toMatchObject({id:jobId});expect(f.events.at(-1)).toBe('return');
 });
 it.each(['resolve','span','invalidate'] as const)('%s error propagates unchanged through stream caller',async port=>{
  const f=fixture();const error=new Error(`${port} unavailable`);ports[port].mockRejectedValueOnce(error);
  await expect(f.read()).rejects.toBe(error);expect(f.events).not.toContain('return');
  if(port!=='invalidate')expect(f.events).not.toContain('release-write');
  // Invalidation failure happens after a synthetic write. No rollback is modeled.
  else expect(f.events).toContain('release-write');
 });
 it('release write error reaches stream caller without invalidation or returned job',async()=>{
  const f=fixture({failWrite:true});await expect(f.read()).rejects.toThrow('release write failed');expect(f.events).toContain('release-write');expect(f.events).not.toContain('invalidate');expect(f.events).not.toContain('return');
 });
});
