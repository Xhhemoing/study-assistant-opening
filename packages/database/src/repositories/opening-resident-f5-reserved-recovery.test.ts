import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {CourseRequirement,CourseRouteStart,CourseRouteNext,OpeningMaterialPurposePin} from '@aistudy/contracts';
import type {Sql,TransactionSql} from 'postgres';
import {assertCourseReservedRecovery} from './opening-course-route-reserved-start';
import {fieldValue,sqlSimulation,unexpected} from './opening-resident-f5-sql-simulation';
const ports=vi.hoisted(()=>({route:vi.fn(),requirements:vi.fn(),assert:vi.fn()}));
vi.mock('./opening-course-route-origin',()=>({assertOpeningCourseRouteCurrent:ports.route}));
vi.mock('./opening-course-route-read',()=>({readCourseRequirements:ports.requirements,assertCourseRouteCourse:vi.fn()}));
vi.mock('./opening-course-ready-sources',()=>({createOpeningCourseReadySourcesRepository:()=>({assertMaterialPurposePin:ports.assert})}));
const id=(n:number)=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const scope={workspaceId:id(1),ownerUserId:id(2)},courseId=id(3),requirementId=id(4),taskId='abcdefab-cdef-4abc-8def-abcdefabcdef',activityId=id(5),sourceId=id(6);
const context={goalId:id(7),goalRevision:3,requirementId,requirementRevision:4,stableSkillId:id(8),requirementKey:'arithmetic',action:'transfer_check' as const};
const requirement={id:requirementId,courseId,requirementKey:'arithmetic',verification:{kind:'exact'},sourceRefs:[{sourceId,sourceVersion:1}]} as CourseRequirement;
const pin:OpeningMaterialPurposePin={courseId,materialUse:'practice',sources:[{sourceId,sourceVersion:1,membershipId:id(9),purposeRevision:'r1',purpose:'practice'}]};
const receipt={taskId,taskVersion:2,purposePin:pin};
const start={goalId:context.goalId,expectedGoalRevision:3,requirementId,expectedRequirementRevision:4,taskId,expectedTaskVersion:2,minutes:20,clientKey:'recovery-test'} as CourseRouteStart;
const next={goalId:context.goalId,expectedGoalRevision:3,activityId,expectedPathVersion:1,observationId:null,minutes:20,clientKey:'recovery-test'} as CourseRouteNext;
function row(options:{receipt?:unknown;route?:unknown;task?:string}={}){
 return {id:activityId,goal_json:{courseRoute:options.route??context,...(options.receipt!==undefined?{reservedStart:options.receipt}:{ }),learningBudget:{minutes:20}},
  create_intent:options.task===undefined?{}:{taskId:options.task}};
}
type Retest={task_id:string;workspace_id:string;owner_user_id:string;course_id:string;protocol:string};
function fixture(options:{retest?:boolean;retestRow?:Partial<Retest>;issued?:boolean;taskVersion?:number|null}={}){
 const retest:Retest={task_id:taskId,workspace_id:scope.workspaceId,owner_user_id:scope.ownerUserId,course_id:courseId,protocol:'course-route-delayed-v1',...options.retestRow};
 const f=sqlSimulation(query=>{
  const text=query.text;
  if(text.startsWith('SELECT id FROM opening_retest_activities')){
   const matches=['task_id','workspace_id','owner_user_id','course_id'].every(field=>{
    const binding=fieldValue(query,field);return binding===undefined||binding===retest[field as keyof Retest];
   });
   const protocolMatches=!text.includes("learning_protocol->>'protocolId'='course-route-delayed-v1'")||retest.protocol==='course-route-delayed-v1';
   return options.retest===false||!matches||!protocolMatches?[]:[{id:id(10)}];
  }
  if(text.startsWith('SELECT version FROM opening_tasks'))return options.taskVersion===null?[]:[{version:options.taskVersion??2}];
  if(text.startsWith('SELECT id FROM opening_course_reserved_questions'))return options.issued===false?[]:[{id:id(11)}];
  return unexpected(query);
 });return {...f,sql:f.sql as Sql,tx:f.sql as TransactionSql};
}
beforeEach(()=>{vi.clearAllMocks();ports.route.mockResolvedValue(context);ports.requirements.mockResolvedValue([requirement]);ports.assert.mockResolvedValue(undefined);});
describe('F5/R: old reservation recovery preserves original authority and refuses missing receipt',()=>{
 it('valid persisted receipt and original start run replay checks with the same scope and transaction',async()=>{
  const f=fixture();await expect(assertCourseReservedRecovery(f.sql,f.tx,scope,courseId,row({receipt}),start,[requirement])).resolves.toBeUndefined();
  expect(ports.route).toHaveBeenCalledExactlyOnceWith(f.tx,scope,activityId);
  expect(ports.requirements).toHaveBeenCalledExactlyOnceWith(f.tx,scope,courseId);
  expect(ports.assert).toHaveBeenCalledExactlyOnceWith(scope,pin,f.tx);
  expect(f.queries).toHaveLength(2);
  expect(f.queries.every(query=>query.text.startsWith('SELECT'))).toBe(true);
 });
 it.each([
  ['explicit null receipt',null],['malformed stored receipt',{taskId,taskVersion:0,purposePin:pin}],
 ])('%s is not equivalent to an absent nonreserved activity',async(_name,stored)=>{
  const f=fixture();await expect(assertCourseReservedRecovery(f.sql,f.tx,scope,courseId,row({receipt:stored}),start,[requirement])).rejects.toMatchObject({code:'CONFLICT'});
  expect(ports.assert).not.toHaveBeenCalled();expect(f.queries).toHaveLength(0);
 });
 it('persisted receipt cannot be resumed through next-step request without original task fields',async()=>{
  const f=fixture();await expect(assertCourseReservedRecovery(f.sql,f.tx,scope,courseId,row({receipt}),next,[requirement])).rejects.toMatchObject({code:'CONFLICT'});
  expect(ports.route).not.toHaveBeenCalled();expect(ports.assert).not.toHaveBeenCalled();expect(f.queries).toHaveLength(0);
 });
 it.each([
  ['server delayed-task record',context,true],['retest bound in context even when task row missing',{...context,retestId:id(12)},false],
 ])('%s blocks a pre-receipt delayed task rather than recapturing a pin',async(_name,route,retest)=>{
  const f=fixture({retest});await expect(assertCourseReservedRecovery(f.sql,f.tx,scope,courseId,row({route,task:taskId}),start,[requirement])).rejects.toMatchObject({code:'CONFLICT'});
  expect(f.queries).toHaveLength(1);expect(ports.assert).not.toHaveBeenCalled();
 });
 it('pre-receipt delayed next-step cannot evade original-task recovery',async()=>{
  const f=fixture();await expect(assertCourseReservedRecovery(f.sql,f.tx,scope,courseId,row({task:taskId}),next,[requirement])).rejects.toMatchObject({code:'CONFLICT'});
  expect(ports.route).not.toHaveBeenCalled();expect(f.queries).toHaveLength(1);
 });
 it.each([
  ['no task',row(),[requirement],{}],
  ['unsupported skill',row({task:taskId}),[{...requirement,requirementKey:'rank'}],{}],
  ['nonexact verification',row({task:taskId}),[{...requirement,verification:{kind:'manual'}}],{}],
  ['task without delayed record',row({task:taskId}),[requirement],{retest:false}],
 ])('%s remains outside private delayed-task replay',async(_name,activity,requirements,options)=>{
  const f=fixture(options);await expect(assertCourseReservedRecovery(f.sql,f.tx,scope,courseId,activity,next,requirements as CourseRequirement[])).resolves.toBeUndefined();
  expect(ports.route).not.toHaveBeenCalled();expect(ports.assert).not.toHaveBeenCalled();
 });
 it.each([
  ['foreign task id',{task_id:id(12)}],['foreign workspace',{workspace_id:id(12)}],['foreign owner',{owner_user_id:id(12)}],
  ['foreign course',{course_id:id(12)}],['different protocol',{protocol:'other'}],
 ])('%s delayed marker cannot force reserved recovery',async(_name,retestRow)=>{
  const f=fixture({retestRow});await expect(assertCourseReservedRecovery(f.sql,f.tx,scope,courseId,row({task:taskId}),next,[requirement])).resolves.toBeUndefined();
  expect(ports.route).not.toHaveBeenCalled();expect(f.queries).toHaveLength(1);
 });
 it('material authority error propagates by identity and never reads task or issue',async()=>{
  const error=Object.assign(new Error('original purpose expired'),{code:'CONFLICT'});ports.assert.mockRejectedValueOnce(error);
  const f=fixture();await expect(assertCourseReservedRecovery(f.sql,f.tx,scope,courseId,row({receipt}),start,[requirement])).rejects.toBe(error);
  expect(f.queries).toHaveLength(0);
 });
 it.each([
  ['task deleted',{taskVersion:null}],['task revision changed',{taskVersion:3}],['issued reservation missing',{issued:false}],
 ])('%s remains a replay conflict without replacement issuance',async(_name,options)=>{
  const f=fixture(options);await expect(assertCourseReservedRecovery(f.sql,f.tx,scope,courseId,row({receipt}),start,[requirement])).rejects.toMatchObject({code:'CONFLICT'});
  expect(f.queries.every(query=>query.text.startsWith('SELECT'))).toBe(true);
 });
 it('invalid persisted route context rejects before recovery probes or mocked authority',async()=>{
  const f=fixture();await expect(assertCourseReservedRecovery(f.sql,f.tx,scope,courseId,row({route:{...context,goalRevision:0}}),start,[requirement])).rejects.toThrow();
  expect(f.queries).toHaveLength(0);expect(ports.route).not.toHaveBeenCalled();
 });
});
