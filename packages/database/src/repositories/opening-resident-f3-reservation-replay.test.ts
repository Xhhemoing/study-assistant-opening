import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {CourseRequirement,CourseRouteStart,OpeningMaterialPurposePin} from '@aistudy/contracts';
import type {Sql,TransactionSql} from 'postgres';
import {assertCourseReservedReplay} from './opening-course-route-reserved-start';
import {fieldValue,sqlSimulation,unexpected} from './opening-resident-f3-sql-simulation';
const ports=vi.hoisted(()=>({route:vi.fn(),requirements:vi.fn(),assert:vi.fn()}));
vi.mock('./opening-course-route-origin',()=>({assertOpeningCourseRouteCurrent:ports.route}));
vi.mock('./opening-course-route-read',()=>({readCourseRequirements:ports.requirements,assertCourseRouteCourse:vi.fn()}));
vi.mock('./opening-course-ready-sources',()=>({createOpeningCourseReadySourcesRepository:()=>({assertMaterialPurposePin:ports.assert})}));
const id=(n:number)=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const scope={workspaceId:id(1),ownerUserId:id(2)},courseId=id(3),sourceId=id(4),requirementId=id(5),taskId='abcdefab-cdef-4abc-8def-abcdefabcdef',activityId=id(7);
const pin:OpeningMaterialPurposePin={courseId,materialUse:'practice',sources:[{sourceId,sourceVersion:1,membershipId:id(8),purposeRevision:'1',purpose:'practice'}]};
const requirement={id:requirementId,courseId,sourceRefs:[{sourceId,sourceVersion:1}]} as CourseRequirement;
const row={id:activityId,goal_json:{reservedStart:{taskId,taskVersion:2,purposePin:pin},learningBudget:{minutes:20}}};
const request={goalId:id(9),expectedGoalRevision:3,requirementId,expectedRequirementRevision:4,taskId,expectedTaskVersion:2,minutes:20,clientKey:'test-replay'} as CourseRouteStart;
const context={requirementId,requirementRevision:4,goalRevision:3};
type StoredTask={id:string;workspace_id:string;owner_user_id:string;version:number};
type StoredIssue={id:string;workspace_id:string;owner_user_id:string;reserved_activity_id:string;state:'issued'|'reserved'};
function fixture(options:{taskVersion?:number|null;issued?:boolean;task?:Partial<StoredTask>;issue?:Partial<StoredIssue>}={}){
 const task:StoredTask={id:taskId,workspace_id:scope.workspaceId,owner_user_id:scope.ownerUserId,version:options.taskVersion??2,...options.task};
 const issue:StoredIssue={id:id(10),workspace_id:scope.workspaceId,owner_user_id:scope.ownerUserId,reserved_activity_id:activityId,state:'issued',...options.issue};
 const matches=(query:import('./opening-resident-f3-sql-simulation').Query,stored:object,fields:string[])=>fields.every(field=>{
  const bound=fieldValue(query,field);return bound===undefined||bound===(stored as Record<string,unknown>)[field];
 });
 const f=sqlSimulation(query=>{
  if(query.text.startsWith('SELECT version FROM opening_tasks')){
   if(options.taskVersion===null||!matches(query,task,['id','workspace_id','owner_user_id']))return [];
   return [{version:task.version}];
  }
  if(query.text.startsWith('SELECT id FROM opening_course_reserved_questions')){
   if(options.issued===false||!matches(query,issue,['workspace_id','owner_user_id','reserved_activity_id']))return [];
   if(query.text.includes("state='issued'")&&issue.state!=='issued')return [];
   return [{id:issue.id}];
  }
  return unexpected(query);
 });return {...f,sql:f.sql as Sql,tx:f.sql as TransactionSql};
}
beforeEach(()=>{vi.clearAllMocks();ports.route.mockResolvedValue(context);ports.requirements.mockResolvedValue([requirement]);ports.assert.mockResolvedValue(undefined);});
describe('F-resident-3: original reservation replay checks',()=>{
 it('valid replay reuses original task/purpose pin and issued item without writing',async()=>{
  const f=fixture();await expect(assertCourseReservedReplay(f.sql,f.tx,scope,courseId,row,request)).resolves.toBeUndefined();
  expect(ports.assert).toHaveBeenCalledWith(scope,pin,f.tx);
  expect(f.queries).toHaveLength(2);expect(f.queries.every(q=>q.text.startsWith('SELECT'))).toBe(true);
 });
 it.each([
  ['task identity',{taskId:id(11)}],['task version',{expectedTaskVersion:3}],['requirement identity',{requirementId:id(11)}],
  ['requirement revision',{expectedRequirementRevision:5}],['goal revision',{expectedGoalRevision:4}],['duration',{minutes:21}],
 ])('changed %s rejects before task or issue lookup',async(_name,patch)=>{
  const f=fixture();await expect(assertCourseReservedReplay(f.sql,f.tx,scope,courseId,row,{...request,...patch})).rejects.toMatchObject({code:'CONFLICT'});
  expect(f.queries).toHaveLength(0);expect(ports.assert).toHaveBeenCalledOnce();
 });
 it('uppercase spelling of the same task UUID is replay-compatible',async()=>{
  const uppercase={...request,taskId:taskId.toUpperCase()};const f=fixture();
  expect(uppercase.taskId).not.toBe(taskId);
  await expect(assertCourseReservedReplay(f.sql,f.tx,scope,courseId,row,uppercase)).resolves.toBeUndefined();
 });
 it.each([
  ['missing task',{taskVersion:null}],['stale task version',{taskVersion:3}],
 ])('%s rejects before issued-item lookup',async(_name,options)=>{
  const f=fixture(options);await expect(assertCourseReservedReplay(f.sql,f.tx,scope,courseId,row,request)).rejects.toMatchObject({code:'CONFLICT'});
  expect(f.queries).toHaveLength(1);
 });
 it('missing issued reservation never silently switches to another question',async()=>{
  const f=fixture({issued:false});await expect(assertCourseReservedReplay(f.sql,f.tx,scope,courseId,row,request)).rejects.toMatchObject({code:'CONFLICT'});
  expect(f.queries).toHaveLength(2);expect(f.queries.every(q=>!q.text.startsWith('UPDATE')&&!q.text.startsWith('INSERT'))).toBe(true);
 });
 it.each([
  ['missing route context',null,[requirement]],['missing current requirement',context,[]],
 ])('%s refuses before pin or task lookup',async(_name,route,requirements)=>{
  ports.route.mockResolvedValue(route);ports.requirements.mockResolvedValue(requirements);const f=fixture();
  await expect(assertCourseReservedReplay(f.sql,f.tx,scope,courseId,row,request)).rejects.toMatchObject({code:'CONFLICT'});
  expect(ports.assert).not.toHaveBeenCalled();expect(f.queries).toHaveLength(0);
 });
 it('purpose authority failure propagates before task lookup',async()=>{
  const error=Object.assign(new Error('stale original pin'),{code:'CONFLICT'});ports.assert.mockRejectedValueOnce(error);const f=fixture();
  await expect(assertCourseReservedReplay(f.sql,f.tx,scope,courseId,row,request)).rejects.toBe(error);
  expect(f.queries).toHaveLength(0);
 });
 it.each([
  ['wrong workspace',{...scope,workspaceId:id(11)}],['wrong owner',{...scope,ownerUserId:id(11)}],
 ])('%s cannot reuse task despite mocked route authority',async(_name,requestedScope)=>{
  const f=fixture();await expect(assertCourseReservedReplay(f.sql,f.tx,requestedScope,courseId,row,request)).rejects.toMatchObject({code:'CONFLICT'});
  expect(f.queries).toHaveLength(1);
 });
 it.each([
  ['foreign workspace task',{workspace_id:id(11)}],['foreign owner task',{owner_user_id:id(11)}],
  ['different task id',{id:id(11)}],
 ])('%s is visible only if its exact task predicate is removed',async(_name,task)=>{
  const f=fixture({task});await expect(assertCourseReservedReplay(f.sql,f.tx,scope,courseId,row,request)).rejects.toMatchObject({code:'CONFLICT'});
  expect(f.queries).toHaveLength(1);
 });
 it.each([
  ['foreign workspace issued row',{workspace_id:id(11)}],['foreign owner issued row',{owner_user_id:id(11)}],
  ['different activity issued row',{reserved_activity_id:id(11)}],['matching but unissued row',{state:'reserved' as const}],
 ])('%s cannot satisfy the issued-item replay check',async(_name,issue)=>{
  const f=fixture({issue});await expect(assertCourseReservedReplay(f.sql,f.tx,scope,courseId,row,request)).rejects.toMatchObject({code:'CONFLICT'});
  expect(f.queries).toHaveLength(2);
 });
 it('independent concurrent read simulations reuse the same issued task without an extra writer',async()=>{
  const f=fixture();const outcomes=await Promise.all(Array.from({length:5},()=>assertCourseReservedReplay(f.sql,f.tx,scope,courseId,row,request)));
  expect(outcomes).toEqual([undefined,undefined,undefined,undefined,undefined]);
  expect(f.queries).toHaveLength(10);expect(f.queries.every(q=>q.text.startsWith('SELECT'))).toBe(true);
 });
});
