import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Scope} from '@aistudy/contracts';
import {assertOpeningCourseRouteRetestCurrent} from './opening-course-route-retest-state';
import {fieldValue,sqlSimulation,unexpected} from './opening-resident-f6-sql-simulation';

const ports=vi.hoisted(()=>({goal:vi.fn(),requirements:vi.fn(),observations:vi.fn()}));
vi.mock('./opening-learning-goals',()=>({readLearningGoal:ports.goal}));
vi.mock('./opening-course-route-read',()=>({readCourseRequirements:ports.requirements,readCourseRouteObservations:ports.observations}));
const id=(n:number)=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const scope:Scope={workspaceId:id(1),ownerUserId:id(2)},retestId=id(3),courseId=id(4),requirementId=id(5);
const now=new Date('2026-01-02T10:00:00.000Z');
const protocol={protocolId:'course-route-delayed-v1',goalId:id(6),goalRevision:4,requirementId,requirementRevision:3,stableSkillId:id(7),baselineObservationId:id(8),baselineRootId:id(9),originActivityId:id(10),minutes:20};
type Row={id:string;workspace_id:string;owner_user_id:string;course_id:string;learning_protocol:unknown;status:string;task_status:string|null;deadline_at:Date|null;not_before_at:Date|null;recommended_at:Date|null;scheduled_start_at:Date|null};
const validRow:Row={id:retestId,workspace_id:scope.workspaceId,owner_user_id:scope.ownerUserId,course_id:courseId,learning_protocol:protocol,status:'accepted',task_status:'pending',deadline_at:null,not_before_at:null,recommended_at:null,scheduled_start_at:null};
const requirement={id:requirementId,revision:3,stableSkillId:protocol.stableSkillId};
const baseline={id:protocol.baselineObservationId,rootObservationId:protocol.baselineRootId};
function fixture(override:Partial<Row>={},missing=false){
 const row={...validRow,...override};
 const f=sqlSimulation(q=>{
  if(!q.text.startsWith('SELECT r.*,t.status AS task_status'))return unexpected(q);
  const matches=['r.id','r.workspace_id','r.owner_user_id'].every(key=>{const v=fieldValue(q,key);return v===undefined||v===row[key.slice(2) as keyof Row]});
  return missing||!matches?[]:[row];
 });return {...f,row};
}
async function current(f:ReturnType<typeof fixture>){return assertOpeningCourseRouteRetestCurrent(f.sql,scope,retestId,courseId,requirementId,now)}
function noLater(){expect(ports.goal).not.toHaveBeenCalled();expect(ports.requirements).not.toHaveBeenCalled();expect(ports.observations).not.toHaveBeenCalled()}
beforeEach(()=>{vi.clearAllMocks();ports.goal.mockResolvedValue({revision:4,lifecycle:'active'});ports.requirements.mockResolvedValue([requirement]);ports.observations.mockResolvedValue({raw:[baseline]})});
describe('F6: delayed retest currentness gate before new question/help/model send',()=>{
 it.each(['accepted','in_progress'])('returns exact current %s row and uses scoped same transaction reads',async status=>{
  const f=fixture({status});await expect(current(f)).resolves.toBe(f.row);
  expect(f.queries).toHaveLength(1);expect(ports.goal).toHaveBeenCalledExactlyOnceWith(f.sql,scope,protocol.goalId);
  expect(ports.requirements).toHaveBeenCalledExactlyOnceWith(f.sql,scope,courseId);
  expect(ports.observations).toHaveBeenCalledExactlyOnceWith(f.sql,scope,courseId);
 });
 it.each([
  ['no row',{},true],['wrong course',{course_id:id(20)},false],['wrong requirement',{learning_protocol:{...protocol,requirementId:id(20)}},false],
  ['invalid protocol id',{learning_protocol:{...protocol,protocolId:'other'}},false],['extra protocol field',{learning_protocol:{...protocol,unexpected:true}},false],
  ['null protocol',{learning_protocol:null},false],['proposed',{status:'proposed'},false],['completed',{status:'completed'},false],
  ['cancelled',{status:'cancelled'},false],['invalidated',{status:'invalidated'},false],['superseded',{status:'superseded'},false],
  ['missing task',{task_status:null},false],['completed task',{task_status:'completed'},false],
 ])('%s stops before dependent reads',async(_name,overrides,missing)=>{
  const f=fixture(overrides,missing);await expect(current(f)).rejects.toMatchObject({code:'CONFLICT'});noLater();
 });
 it.each([['different retest',{id:id(20)}],['different workspace',{workspace_id:id(20)}],['different owner',{owner_user_id:id(20)}]])('%s scoped lookup yields no row in synthetic transport',async(_name,overrides)=>{
  const f=fixture(overrides);await expect(current(f)).rejects.toMatchObject({code:'CONFLICT'});noLater();
 });
 it('expired deadline stops before timing and dependent reads',async()=>{
  const f=fixture({deadline_at:new Date(now.getTime()-1)});await expect(current(f)).rejects.toMatchObject({code:'CONFLICT'});noLater();
 });
 it('deadline equality is admitted',async()=>{const f=fixture({deadline_at:new Date(now)});await expect(current(f)).resolves.toBe(f.row)});
 it.each([
  ['not-before later', {not_before_at:new Date(now.getTime()+1000)},'not_before'],
  ['scheduled later', {scheduled_start_at:new Date(now.getTime()+1000)},'scheduled_or_recommended'],
  ['recommended fallback later', {recommended_at:new Date(now.getTime()+1000)},'scheduled_or_recommended'],
 ])('%s rejects before fetching current goal',async(_name,overrides,reason)=>{
  const f=fixture(overrides);await expect(current(f)).rejects.toMatchObject({code:'VALIDATION',reason});noLater();
 });
 it('scheduled start takes precedence over a later recommendation',async()=>{
  const f=fixture({scheduled_start_at:new Date(now),recommended_at:new Date(now.getTime()+1000)});await expect(current(f)).resolves.toBe(f.row);
 });
 it('not-before still dominates an earlier scheduled start',async()=>{
  const f=fixture({scheduled_start_at:new Date(now),not_before_at:new Date(now.getTime()+1000)});await expect(current(f)).rejects.toMatchObject({code:'VALIDATION',reason:'not_before'});noLater();
 });
 it.each(['active','maintenance','reduced'])('goal lifecycle %s is accepted',async lifecycle=>{ports.goal.mockResolvedValue({revision:4,lifecycle});const f=fixture();await expect(current(f)).resolves.toBe(f.row)});
 it.each([
  ['missing goal',null,[requirement]],['changed goal revision',{revision:5,lifecycle:'active'},[requirement]],
  ['inactive goal',{revision:4,lifecycle:'paused'},[requirement]],['missing requirement',{revision:4,lifecycle:'active'},[]],
  ['changed requirement revision',{revision:4,lifecycle:'active'},[{...requirement,revision:4}]],
  ['changed stable skill',{revision:4,lifecycle:'active'},[{...requirement,stableSkillId:id(20)}]],
 ])('%s stops before baseline read',async(_name,goal,requirements)=>{
  ports.goal.mockResolvedValue(goal);ports.requirements.mockResolvedValue(requirements);const f=fixture();
  await expect(current(f)).rejects.toMatchObject({code:'CONFLICT'});expect(ports.observations).not.toHaveBeenCalled();
 });
 it.each([
  ['missing baseline',[]],['wrong id',[{...baseline,id:id(20)}]],['wrong root',[{...baseline,rootObservationId:id(20)}]],
 ])('%s blocks new work',async(_name,raw)=>{ports.observations.mockResolvedValue({raw});const f=fixture();await expect(current(f)).rejects.toMatchObject({code:'CONFLICT'})});
 it('original baseline is its own root when root id is null',async()=>{
  const rootProtocol={...protocol,baselineRootId:protocol.baselineObservationId};ports.observations.mockResolvedValue({raw:[{id:protocol.baselineObservationId,rootObservationId:null}]});
  const f=fixture({learning_protocol:rootProtocol});await expect(current(f)).resolves.toBe(f.row);
 });
 it.each(['goal','requirements','observations'] as const)('%s reader failure is propagated unchanged',async port=>{
  const error=new Error(`${port} failed`);ports[port].mockRejectedValueOnce(error);const f=fixture();await expect(current(f)).rejects.toBe(error);
  if(port==='goal')expect(ports.requirements).not.toHaveBeenCalled();
  if(port!=='observations')expect(ports.observations).not.toHaveBeenCalled();
 });
});
