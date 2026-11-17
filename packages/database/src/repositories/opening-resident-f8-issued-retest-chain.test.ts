import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import {issueOpeningReservedQuestion} from './opening-course-reserved-selection';
import {sqlSimulation,unexpected} from './opening-resident-f8-sql-simulation';
const ports=vi.hoisted(()=>({course:vi.fn(),goal:vi.fn(),requirements:vi.fn(),materials:vi.fn(),chunks:vi.fn(),observations:vi.fn(),session:vi.fn(),attempt:vi.fn(),record:vi.fn()}));
vi.mock('./opening-course-route-read',()=>({assertCourseRouteCourse:ports.course,readCourseRequirements:ports.requirements,readCourseRouteMaterials:ports.materials,readCourseRouteSourceChunks:ports.chunks,readCourseRouteObservations:ports.observations}));
vi.mock('./opening-learning-goals',()=>({readLearningGoal:ports.goal}));
vi.mock('./opening-learning-session-create',()=>({createOpeningLearningSessionInTx:ports.session}));
vi.mock('./opening-learning-attempts',()=>({createOpeningLearningAttemptInTx:ports.attempt}));
vi.mock('./opening-course-question-exposure',()=>({recordCourseQuestionExposure:ports.record,readCourseQuestionExposure:vi.fn()}));
const id=(n:number)=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const scope={workspaceId:id(1),ownerUserId:id(2)},courseId=id(3),requirementId=id(4),activityId=id(5),questionId=id(6),sourceId=id(7),chunkId=id(8),identityRefId=id(9),keyRefId=id(10),retestId=id(11);
const at='2026-01-02T10:00:00.000Z',earlier='2026-01-01T10:00:00.000Z';
const refs=[{sourceId,sourceVersion:1,chunkId}];
const verification={kind:'exact',status:'missing',exerciseKeys:[],rubric:null,missingReasons:[]};
const requirement={id:requirementId,courseId,stableSkillId:id(12),revision:1,approvedAt:earlier,requirementKey:'arithmetic',sourceRefs:refs};
const context={goalId:id(13),goalRevision:2,requirementId,requirementRevision:1,stableSkillId:requirement.stableSkillId,requirementKey:'arithmetic',action:'transfer_check',retestId};
const protocol={protocolId:'course-route-delayed-v1',goalId:context.goalId,goalRevision:2,requirementId,requirementRevision:1,stableSkillId:requirement.stableSkillId,baselineObservationId:id(14),baselineRootId:id(15),originActivityId:id(16),minutes:20};
const identity={protocolVersion:'reserved-arithmetic-1',identityRefId,reservedQuestionId:questionId,requirementId,requirementRevision:1,sourceRefs:[{sourceId,version:1,chunkId}],expression:'137*19',familyId:'arithmetic:*',answerRole:'answer_key'};
const dbRequirement={id:requirementId,course_id:courseId,workspace_id:scope.workspaceId,owner_user_id:scope.ownerUserId,stable_skill_id:requirement.stableSkillId,knowledge_node_id:null,requirement_key:'arithmetic',title:'Arithmetic',position:0,mandatory:true,goal_ids:[],prerequisite_ids:[],source_refs:refs,verification,revision:1,lifecycle:'active',origin:'confirmed',approved_at:earlier};
function fixture(options:{status?:string;missing?:boolean;retestStatus?:string;baselineMissing?:boolean}={}){
 const events:string[]=[];
 const reserved={id:questionId,course_id:courseId,requirement_id:requirementId,requirement_revision:1,source_versions:{[sourceId]:1},identity_ref_id:identityRefId,identity_json:identity,family_id:identity.familyId,key_ref_id:keyRefId,question_json:{text:'137*19'},interaction_json:{kind:'numeric'},key_json:{keyRefId,identity,answer:'2603',verification:{kind:'deterministic_evaluator',evaluatorId:'arithmetic',evaluatorVersion:'reserved-arithmetic-1'}},state:options.status??'reserved',reserved_activity_id:activityId};
 const f=sqlSimulation(q=>{
  const s=q.text;
  if(s.startsWith('SELECT id FROM workspaces'))return [{id:scope.workspaceId}];
  if(s.startsWith('INSERT INTO opening_workspace_history_revisions'))return [];
  if(s.startsWith('SELECT revision FROM opening_workspace_history_revisions')){events.push('history-lock');return [{revision:1}]}
  if(s.startsWith('SELECT * FROM opening_course_reserved_questions')){events.push(s.includes('ORDER BY created_at,id')?'candidates':'reserved');return options.missing?[]:[reserved]}
  if(s.startsWith('SELECT course_id,goal_json,create_intent')){events.push('route');return [{course_id:courseId,goal_json:{courseRoute:context},create_intent:{}}]}
  if(s.startsWith('SELECT r.*,t.status AS task_status')){events.push('retest');return [{course_id:courseId,learning_protocol:protocol,status:options.retestStatus??'accepted',task_status:'pending',deadline_at:null,not_before_at:earlier,recommended_at:earlier,scheduled_start_at:null}]}
  if(s.startsWith('SELECT status,content_version')){events.push('publishable');return [{status:'active',content_version:0}]}
  if(s.startsWith('SELECT * FROM course_requirements'))return [dbRequirement];
  if(s.startsWith('SELECT s.id,s.version'))return [{id:sourceId,version:1}];
  if(s.startsWith('SELECT id FROM opening_source_chunks'))return [{id:chunkId}];
  if(s.startsWith('INSERT INTO library_')||s.startsWith('INSERT INTO opening_teaching_')){events.push('public-write');return []}
  if(s.startsWith('UPDATE opening_teaching_activities'))return [];
  if(s.startsWith("UPDATE opening_course_reserved_questions SET state='issued'")){events.push('issued');return []}
  if(s.startsWith('UPDATE opening_learning_attempts SET create_intent'))return [];
  return unexpected(q);
 });
 const exposure={readExposure:vi.fn(async()=>{events.push('exposure');return {coverage:'complete' as const,exactExposed:false,familyExposed:false,reason:null}})};
 ports.observations.mockResolvedValue({raw:options.baselineMissing?[]:[{id:protocol.baselineObservationId,rootObservationId:protocol.baselineRootId}]});
 ports.session.mockImplementation(async()=>{events.push('session');return {id:id(17)}});ports.attempt.mockImplementation(async()=>{events.push('attempt');return {id:id(18),itemVersionId:id(19)}});ports.record.mockImplementation(async()=>{events.push('presented')});
 return {...f,events,exposure,issue:()=>issueOpeningReservedQuestion(f.sql,scope,activityId,exposure)};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date(at));vi.clearAllMocks();ports.course.mockResolvedValue(undefined);ports.goal.mockResolvedValue({revision:2,lifecycle:'active',courseIds:[courseId]});ports.requirements.mockResolvedValue([requirement]);ports.materials.mockResolvedValue([{sourceId,sourceVersion:1,available:true}]);ports.chunks.mockResolvedValue([{id:chunkId,sourceId,sourceVersion:1,page:1}])});
afterEach(()=>vi.useRealTimers());
describe('F8: actual issue to real route and retest gate, with synthetic publication ports',()=>{
 it('valid reserved item checks retest before eligibility and publication',async()=>{
  const f=fixture();await expect(f.issue()).resolves.toBeUndefined();
  expect(f.events).toEqual(['history-lock','reserved','route','retest','publishable','candidates','exposure','public-write','public-write','public-write','public-write','public-write','session','attempt','issued','presented']);
  expect(ports.session).toHaveBeenCalledWith(f.sql,scope,expect.objectContaining({activityId,courseId}));
  expect(ports.attempt).toHaveBeenCalledWith(f.sql,scope,expect.objectContaining({sessionId:id(17)}));
 });
 it.each([['completed',{retestStatus:'completed'}],['withdrawn baseline',{baselineMissing:true}]])('%s rejects without eligibility reads or publication',async(_name,options)=>{
  const f=fixture(options);await expect(f.issue()).rejects.toMatchObject({code:'CONFLICT'});
  expect(f.events).toEqual(['history-lock','reserved','route','retest']);expect(f.exposure.readExposure).not.toHaveBeenCalled();expect(ports.attempt).not.toHaveBeenCalled();expect(ports.record).not.toHaveBeenCalled();
 });
 it('pending retest baseline read cannot reach public writes before it resolves',async()=>{
  const f=fixture();let resume!:(value:{raw:{id:string;rootObservationId:string}[]})=>void;let entered!:()=>void;
  const gate=new Promise<{raw:{id:string;rootObservationId:string}[]}>(resolve=>{resume=resolve});
  const reached=new Promise<void>(resolve=>{entered=resolve});ports.observations.mockImplementationOnce(()=>{entered();return gate});
  const pending=f.issue();const phase=await Promise.race([reached.then(()=>'gate'),pending.then(()=>'returned',()=>'rejected')]);
  try {expect(phase).toBe('gate');expect(f.events).toEqual(['history-lock','reserved','route','retest']);expect(ports.session).not.toHaveBeenCalled()}
  finally {resume({raw:[{id:protocol.baselineObservationId,rootObservationId:protocol.baselineRootId}]})}
  await expect(pending).resolves.toBeUndefined();expect(f.events.at(-1)).toBe('presented');
 });
 it('goal read failure through real route is propagated before new question writes',async()=>{
  const error=new Error('goal unavailable');ports.goal.mockRejectedValueOnce(error);const f=fixture();await expect(f.issue()).rejects.toBe(error);
  expect(f.events).toEqual(['history-lock','reserved','route']);expect(ports.session).not.toHaveBeenCalled();
 });
 it.each([['already issued',{status:'issued'}],['no reservation',{missing:true}]])('%s does not invoke new route/retest or issue side effects',async(_name,options)=>{
  const f=fixture(options);await expect(f.issue()).resolves.toBeUndefined();expect(f.events).toEqual(['history-lock','reserved']);expect(ports.goal).not.toHaveBeenCalled();expect(ports.attempt).not.toHaveBeenCalled();
 });
});
