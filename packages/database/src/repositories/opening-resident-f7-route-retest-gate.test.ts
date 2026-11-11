import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Scope} from '@aistudy/contracts';
import {assertOpeningCourseRouteCurrent} from './opening-course-route-origin';
import {fieldValue,sqlSimulation,unexpected} from './opening-resident-f7-sql-simulation';
const ports=vi.hoisted(()=>({course:vi.fn(),requirements:vi.fn(),materials:vi.fn(),chunks:vi.fn(),observations:vi.fn(),goal:vi.fn(),retest:vi.fn()}));
vi.mock('./opening-course-route-read',()=>({assertCourseRouteCourse:ports.course,readCourseRequirements:ports.requirements,readCourseRouteMaterials:ports.materials,readCourseRouteSourceChunks:ports.chunks,readCourseRouteObservations:ports.observations}));
vi.mock('./opening-learning-goals',()=>({readLearningGoal:ports.goal}));
vi.mock('./opening-course-route-retest-state',()=>({assertOpeningCourseRouteRetestCurrent:ports.retest}));
const id=(n:number)=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const scope:Scope={workspaceId:id(1),ownerUserId:id(2)},activityId=id(3),courseId=id(4),taskId=id(5),retestId=id(6),sourceId=id(7);
const context={goalId:id(8),goalRevision:2,requirementId:id(9),requirementRevision:3,stableSkillId:id(10),requirementKey:'arithmetic',action:'transfer_check' as const,retestId};
const requirement={id:context.requirementId,courseId,approvedAt:'2026-01-01T00:00:00.000Z',revision:3,requirementKey:'arithmetic',stableSkillId:context.stableSkillId,sourceRefs:[{sourceId,sourceVersion:1}]};
type Activity={id:string;workspace_id:string;owner_user_id:string;course_id:string;goal_json:unknown;create_intent:unknown};
type Task={id:string;workspace_id:string;owner_user_id:string;status:string};
function fixture(opts:{activity?:Partial<Activity>;task?:Partial<Task>|null;missingActivity?:boolean}={}){
 const activity:Activity={id:activityId,workspace_id:scope.workspaceId,owner_user_id:scope.ownerUserId,course_id:courseId,goal_json:{courseRoute:context},create_intent:{taskId},...opts.activity};
 const task:Task|null=opts.task===null?null:{id:taskId,workspace_id:scope.workspaceId,owner_user_id:scope.ownerUserId,status:'pending',...opts.task};
 const f=sqlSimulation(q=>{
  if(q.text.startsWith('SELECT course_id,goal_json,create_intent FROM opening_teaching_activities')){
   return !opts.missingActivity&&['id','workspace_id','owner_user_id'].every(key=>{const v=fieldValue(q,key);return v===undefined||v===activity[key as keyof Activity]})?[activity]:[];
  }
  if(q.text.startsWith('SELECT status FROM opening_tasks'))return task&&['id','workspace_id','owner_user_id'].every(key=>{const v=fieldValue(q,key);return v===undefined||v===task[key as keyof Task]})?[task]:[];
  return unexpected(q);
 });return {...f,activity};
}
beforeEach(()=>{vi.clearAllMocks();ports.course.mockResolvedValue(undefined);ports.requirements.mockResolvedValue([requirement]);ports.goal.mockResolvedValue({revision:2,courseIds:[courseId],lifecycle:'active'});ports.materials.mockResolvedValue([{sourceId,sourceVersion:1,available:true}]);ports.chunks.mockResolvedValue([{id:id(11),sourceId,sourceVersion:1,page:1}]);ports.observations.mockResolvedValue({raw:[]});ports.retest.mockResolvedValue(undefined)});
describe('F7: route origin delegates delayed retest currentness after route checks',()=>{
 it('valid delayed route forwards original transaction and scope before task lookup',async()=>{
  const f=fixture();let countAtRetest=-1;ports.retest.mockImplementationOnce(async()=>{countAtRetest=f.queries.length});
  await expect(assertOpeningCourseRouteCurrent(f.sql,scope,activityId)).resolves.toEqual(context);
  expect(ports.course).toHaveBeenCalledExactlyOnceWith(f.sql,scope,courseId);
  expect(ports.retest).toHaveBeenCalledExactlyOnceWith(f.sql,scope,retestId,courseId,context.requirementId);
  expect(countAtRetest).toBe(1);expect(f.queries).toHaveLength(2);
 });
 it('retest rejection propagates by identity without task lookup',async()=>{
  const failure=new Error('expired retest');ports.retest.mockRejectedValueOnce(failure);const f=fixture();
  await expect(assertOpeningCourseRouteCurrent(f.sql,scope,activityId)).rejects.toBe(failure);expect(f.queries).toHaveLength(1);
 });
 it('non-retest course route skips the retest gate and still checks the task',async()=>{
  const {retestId:_unused,...ordinary}=context;const f=fixture({activity:{goal_json:{courseRoute:ordinary}}});
  await expect(assertOpeningCourseRouteCurrent(f.sql,scope,activityId)).resolves.toEqual(ordinary);
  expect(ports.retest).not.toHaveBeenCalled();expect(f.queries).toHaveLength(2);
 });
 it('activity without a route stays outside route and retest enforcement',async()=>{
  const f=fixture({activity:{goal_json:{}}});await expect(assertOpeningCourseRouteCurrent(f.sql,scope,activityId)).resolves.toBeNull();
  expect(ports.course).not.toHaveBeenCalled();expect(ports.retest).not.toHaveBeenCalled();expect(f.queries).toHaveLength(1);
 });
 it.each([
  ['wrong activity',{id:id(20)}],['wrong workspace',{workspace_id:id(20)}],['wrong owner',{owner_user_id:id(20)}],
 ])('%s is absent in synthetic activity lookup',async(_name,activity)=>{
  const f=fixture({activity});await expect(assertOpeningCourseRouteCurrent(f.sql,scope,activityId)).resolves.toBeNull();expect(ports.retest).not.toHaveBeenCalled();
 });
 it.each([
  ['requirement revision',()=>ports.requirements.mockResolvedValue([{...requirement,revision:4}])],
  ['requirement approval',()=>ports.requirements.mockResolvedValue([{...requirement,approvedAt:null}])],
  ['goal revision',()=>ports.goal.mockResolvedValue({revision:3,courseIds:[courseId],lifecycle:'active'})],
  ['unavailable material',()=>ports.materials.mockResolvedValue([{sourceId,sourceVersion:1,available:false}])],
 ])('%s blocks retest before task query',async(_name,change)=>{
  change();const f=fixture();await expect(assertOpeningCourseRouteCurrent(f.sql,scope,activityId)).rejects.toMatchObject({code:'CONFLICT'});
  expect(ports.retest).not.toHaveBeenCalled();expect(f.queries).toHaveLength(1);
 });
 it('stale origin observation blocks retest before task query',async()=>{
  const route={...context,originActivityId:id(12),originObservationId:id(13)};
  ports.observations.mockResolvedValue({raw:[{id:id(14),activityId:id(12),occurredAt:'2026-01-02T00:00:00.000Z'}]});const f=fixture({activity:{goal_json:{courseRoute:route}}});
  await expect(assertOpeningCourseRouteCurrent(f.sql,scope,activityId)).rejects.toMatchObject({code:'CONFLICT'});expect(ports.retest).not.toHaveBeenCalled();expect(f.queries).toHaveLength(1);
 });
 it('current origin observation permits retest and task checks',async()=>{
  const route={...context,originActivityId:id(12),originObservationId:id(13)};
  ports.observations.mockResolvedValue({raw:[{id:id(13),activityId:id(12),occurredAt:'2026-01-02T00:00:00.000Z'}]});const f=fixture({activity:{goal_json:{courseRoute:route}}});
  await expect(assertOpeningCourseRouteCurrent(f.sql,scope,activityId)).resolves.toEqual(route);expect(ports.retest).toHaveBeenCalledOnce();expect(f.queries).toHaveLength(2);
 });
 it.each([
  ['missing task',null],['completed task',{status:'completed'}],['foreign task',{id:id(20)}],['foreign workspace',{workspace_id:id(20)}],['foreign owner',{owner_user_id:id(20)}],
 ])('%s rejects only after successful retest gate',async(_name,task)=>{
  const f=fixture({task});await expect(assertOpeningCourseRouteCurrent(f.sql,scope,activityId)).rejects.toMatchObject({code:'CONFLICT'});
  expect(ports.retest).toHaveBeenCalledOnce();expect(f.queries).toHaveLength(2);
 });
 it('a delayed route without a task calls retest but does not invent task lookup',async()=>{
  const f=fixture({activity:{create_intent:{}}});await expect(assertOpeningCourseRouteCurrent(f.sql,scope,activityId)).resolves.toEqual(context);
  expect(ports.retest).toHaveBeenCalledOnce();expect(f.queries).toHaveLength(1);
 });
 it('course lookup failure propagates before retest and task',async()=>{
  const failure=new Error('course read failed');ports.course.mockRejectedValueOnce(failure);const f=fixture();
  await expect(assertOpeningCourseRouteCurrent(f.sql,scope,activityId)).rejects.toBe(failure);expect(ports.retest).not.toHaveBeenCalled();expect(f.queries).toHaveLength(1);
 });
});
