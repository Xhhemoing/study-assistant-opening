import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Sql} from 'postgres';
import {admitOpeningReservedCandidate,saveOpeningReservedCandidates,type OpeningReservedCandidate} from './opening-course-reserved-selection';
import {sqlSimulation,unexpected,type Query} from './opening-resident-f13-sql-simulation';
const ports=vi.hoisted(()=>({route:vi.fn()}));
vi.mock('./opening-course-route-origin',()=>({assertOpeningCourseRouteCurrent:ports.route}));
const id=(n:number)=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const scope={workspaceId:id(1),ownerUserId:id(2)},courseId=id(3),requirementId=id(4),sourceId=id(5),activityId=id(6),chunkId=id(7);
const pin={courseId,requirementId,requirementRevision:2,sourceVersions:{[sourceId]:1}};
const candidate:OpeningReservedCandidate={text:'137*19',interaction:{kind:'numeric'},answer:'2603'};
const requirement={id:requirementId,course_id:courseId,workspace_id:scope.workspaceId,owner_user_id:scope.ownerUserId,stable_skill_id:id(8),knowledge_node_id:null,requirement_key:'arithmetic',title:'Arithmetic',position:0,mandatory:true,goal_ids:[],prerequisite_ids:[],source_refs:[{sourceId,sourceVersion:1,chunkId}],verification:{kind:'exact',status:'missing',exerciseKeys:[],rubric:null,missingReasons:[]},revision:2,lifecycle:'active',origin:'confirmed',approved_at:'2026-01-01T00:00:00.000Z'};
function fixture(opts:{current?:Record<string,unknown>;sourceVersion?:number;chunks?:boolean;existing?:string[]}={}){
 const writes:Query[]=[];const expressions=[...(opts.existing??[])];
 const tx=sqlSimulation(q=>{
  const s=q.text;
  if(s.startsWith('SELECT id FROM workspaces'))return [{id:scope.workspaceId}];
  if(s.startsWith('INSERT INTO opening_workspace_history_revisions'))return [];
  if(s.startsWith('SELECT revision FROM opening_workspace_history_revisions'))return [{revision:1}];
  if(s.startsWith('SELECT course_id FROM opening_teaching_activities'))return [{course_id:courseId}];
  if(s.startsWith('SELECT * FROM course_requirements'))return [{...requirement,...opts.current}];
  if(s.startsWith('SELECT s.id,s.version'))return [{id:sourceId,version:opts.sourceVersion??1}];
  if(s.startsWith('SELECT id FROM opening_source_chunks'))return opts.chunks===false?[]:[{id:chunkId}];
  if(s.startsWith('SELECT identity_json FROM opening_course_reserved_questions'))return expressions.map(expression=>({identity_json:{expression}}));
  if(s.startsWith('INSERT INTO opening_course_reserved_questions')){writes.push(q);expressions.push((q.values[8] as {expression:string}).expression);return []}
  return unexpected(q);
 });
 const begin=vi.fn(async(fn:(value:typeof tx.sql)=>unknown)=>fn(tx.sql));const outer=Object.assign(()=>{throw new Error('outside transaction')},{begin}) as unknown as Sql;
 const assertPinnedContext=vi.fn(async(_tx:typeof tx.sql)=>{});
 return {tx,writes,begin,assertPinnedContext,admit:(value:OpeningReservedCandidate=candidate,selectedPin=pin)=>admitOpeningReservedCandidate(outer,scope,activityId,selectedPin,value,{assertPinnedContext}),batch:(raw:unknown)=>saveOpeningReservedCandidates(outer,scope,activityId,raw,{assertPinnedContext})};
}
beforeEach(()=>{vi.resetAllMocks();ports.route.mockResolvedValue({requirementId})});
describe('F13: real private candidate admission consumes original generation authority',()=>{
 it('valid candidate checks original capability in tx and persists server-owned identity/key without public writes',async()=>{
  const f=fixture();const result=await f.admit();expect(result).toEqual({privateRefId:expect.any(String)});expect(f.begin).toHaveBeenCalledOnce();expect(f.assertPinnedContext).toHaveBeenCalledExactlyOnceWith(f.tx.sql);
  expect(f.writes).toHaveLength(1);const values=f.writes[0]!.values;expect(values[0]).toBe(result!.privateRefId);expect(values.slice(1,7)).toEqual([scope.workspaceId,scope.ownerUserId,courseId,requirementId,2,{[sourceId]:1}]);
  expect(values[8]).toMatchObject({reservedQuestionId:result!.privateRefId,expression:'137*19',requirementId,requirementRevision:2,sourceRefs:[{sourceId,version:1,chunkId}],answerRole:'answer_key'});
  expect(values[14]).toMatchObject({answer:'2603',verification:{kind:'deterministic_evaluator',evaluatorId:'arithmetic'}});
  expect(f.tx.queries.some(q=>q.text.startsWith('INSERT INTO library_')||q.text.startsWith('INSERT INTO opening_course_question_exposures'))).toBe(false);
 });
 it('rejected original pin propagates identity before activity or candidate reads',async()=>{
  const f=fixture();const failure=new Error('purpose revoked');f.assertPinnedContext.mockRejectedValueOnce(failure);await expect(f.admit()).rejects.toBe(failure);expect(ports.route).not.toHaveBeenCalled();expect(f.writes).toHaveLength(0);
 });
 it.each([
  ['course',{...pin,courseId:id(20)}],['requirement',{...pin,requirementId:id(20)}],['revision',{...pin,requirementRevision:3}],['source version',{...pin,sourceVersions:{[sourceId]:2}}],
 ])('pinned %s drift rejects before deduplication or insertion',async(_name,selectedPin)=>{
  const f=fixture();await expect(f.admit(candidate,selectedPin)).rejects.toMatchObject({code:'CONFLICT'});expect(f.writes).toHaveLength(0);expect(f.tx.queries.some(q=>q.text.startsWith('SELECT identity_json'))).toBe(false);
 });
 it.each([['stale material',{sourceVersion:2}],['missing referenced chunk',{chunks:false}]])('%s rejects without candidate insertion',async(_name,options)=>{const f=fixture(options);await expect(f.admit()).rejects.toMatchObject({code:'CONFLICT'});expect(f.writes).toHaveLength(0)});
 it('rendering alias of existing expression returns null instead of duplicate private inventory',async()=>{
  const f=fixture({existing:['137*19']});await expect(f.admit({...candidate,text:'计算：137 × 19？'})).resolves.toBeNull();expect(f.writes).toHaveLength(0);
 });
 it('batch deduplicates aliases after first synthetic insert but admits a different expression',async()=>{
  const f=fixture();await expect(f.batch([candidate,{...candidate,text:'137 × 19'},{text:'139*23',interaction:{kind:'numeric'},answer:'3197'}])).resolves.toBe(2);expect(f.writes).toHaveLength(2);
 });
 it.each([
  ['incorrect private answer',{...candidate,answer:'0'}],['non-arithmetic text',{...candidate,text:'x+y'}],['unsupported unit',{...candidate,interaction:{kind:'numeric' as const,unit:'m'}}],
 ])('%s is not admitted even with a valid original capability',async(_name,value)=>{const f=fixture();await expect(f.admit(value)).resolves.toBeNull();expect(f.writes).toHaveLength(0)});
 it('untrusted extra identity claim rejects before starting transaction',async()=>{
  const f=fixture();await expect(f.batch([{...candidate,eligible:true}])).rejects.toThrow();expect(f.begin).not.toHaveBeenCalled();expect(f.assertPinnedContext).not.toHaveBeenCalled();
 });
 it('unsupported requirement does not silently certify correct arithmetic as another skill',async()=>{
  const f=fixture({current:{requirement_key:'rank'}});await expect(f.admit()).resolves.toBeNull();expect(f.writes).toHaveLength(0);
 });
});
