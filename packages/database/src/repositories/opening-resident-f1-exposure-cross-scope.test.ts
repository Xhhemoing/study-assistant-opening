import {describe,expect,it} from 'vitest';
import {readCourseQuestionExposure} from './opening-course-question-exposure';
import {sqlSimulation,fieldValue,unexpected,type Query} from './opening-resident-f1-sql-simulation';
const scopes=[{workspaceId:'11111111-1111-4111-8111-111111111111',ownerUserId:'22222222-2222-4222-8222-222222222222'},
 {workspaceId:'33333333-3333-4333-8333-333333333333',ownerUserId:'44444444-4444-4444-8444-444444444444'},
 {workspaceId:'77777777-7777-4777-8777-777777777777',ownerUserId:'22222222-2222-4222-8222-222222222222'}] as const;
const courseA='55555555-5555-4555-8555-555555555555',courseB='66666666-6666-4666-8666-666666666666';
const descriptor=(expression:string)=>({grammar:'reserved-arithmetic-3',complete:true,expressions:[expression],families:['arithmetic:*']});
const input={reservedQuestionId:courseA,identityRefId:courseB,courseId:courseA,requirementId:courseA,requirementRevision:1,
 sourceVersions:{},text:'137*19',interaction:{kind:'numeric' as const},familyId:'arithmetic:*'};
function fixture(){
 const ledger:Array<{workspace_id:string;owner_user_id:string;course_id:string;exact_content:ReturnType<typeof descriptor>}>=[{workspace_id:scopes[0].workspaceId,owner_user_id:scopes[0].ownerUserId,course_id:courseA,exact_content:descriptor('137*19')},
  {workspace_id:scopes[1].workspaceId,owner_user_id:scopes[1].ownerUserId,course_id:courseB,exact_content:descriptor('139*23')},
  {workspace_id:scopes[2].workspaceId,owner_user_id:scopes[2].ownerUserId,course_id:courseB,exact_content:descriptor('141*29')}];
 function matches(q:Query,row:Record<string,unknown>,fields:string[]){return fields.every(field=>{
  const bound=fieldValue(q,field);return bound===undefined||row[field.replace(/^.*\./,'')]===bound;
 });}
 const f=sqlSimulation(q=>{
  const t=q.text;
  if(t.startsWith('SELECT id FROM workspaces'))return scopes.some(s=>{
   const workspace=fieldValue(q,'id'),owner=fieldValue(q,'owner_user_id');
   return (workspace===undefined||workspace===s.workspaceId)&&(owner===undefined||owner===s.ownerUserId);
  })?[{id:'workspace'}]:[];
  if(t.startsWith('SELECT invalidated FROM opening_course_question_exposure_coverage'))return [{invalidated:false}];
  if(t.startsWith('INSERT INTO opening_workspace_history_revisions'))return [];
  if(t.startsWith('SELECT revision FROM opening_workspace_history_revisions'))return [{revision:7}];
  if(t.startsWith('LOCK TABLE'))return [];
  if(t.startsWith('SELECT NOT EXISTS'))return [{complete:true}];
  if(t.startsWith("SELECT 'revision:'"))return [];
  if(t.startsWith('SELECT ( EXISTS'))return [{unknown:false}];
  if(t.startsWith('SELECT id FROM opening_course_question_exposures'))return [];
  if(t.startsWith('UPDATE opening_course_question_exposure_coverage'))return [];
  if(t.startsWith('SELECT c.complete'))return [{complete:true,invalidated:'false',history_revision:7,revision:7}];
  if(t.startsWith('SELECT exact_content'))return ledger.filter(row=>matches(q,row,['workspace_id','owner_user_id','course_id'])).map(row=>({exact_content:row.exact_content}));
  return unexpected(q);
 });return {...f,ledger};
}
describe('F-resident-1: workspace exposure isolation and intentional cross-course history',()=>{
 it.each([
  ['owner A candidate A',scopes[0],'137*19',true],['owner A candidate B',scopes[0],'139*23',false],
  ['owner B candidate A',scopes[1],'137*19',false],['owner B candidate B',scopes[1],'139*23',true],
 ])('%s reads only its own ledger descriptors',async(_name,scope,text,exposed)=>{
  const f=fixture();const r=await readCourseQuestionExposure(f.sql,scope,{...input,text});
  expect(r).toEqual({coverage:'complete',exactExposed:exposed,familyExposed:true,reason:null});
  const query=f.queries.find(q=>q.text.startsWith('SELECT exact_content'))!;
  expect(fieldValue(query,'workspace_id')).toBe(scope.workspaceId);expect(fieldValue(query,'owner_user_id')).toBe(scope.ownerUserId);
 });
 it.each([
  ['mismatched owner',{...scopes[0],ownerUserId:scopes[1].ownerUserId}],
  ['mismatched workspace',{...scopes[0],workspaceId:scopes[1].workspaceId}],
 ])('%s fails ownership before any ledger read',async(_name,scope)=>{
  const f=fixture();await expect(readCourseQuestionExposure(f.sql,scope,input)).rejects.toMatchObject({code:'NOT_FOUND'});
  expect(f.queries).toHaveLength(1);
 });
 it('same workspace exposure from another course remains exposure: no false course isolation',async()=>{
  const f=fixture();const first=await readCourseQuestionExposure(f.sql,scopes[0],{...input,courseId:courseA});
  const second=await readCourseQuestionExposure(f.sql,scopes[0],{...input,courseId:courseB,requirementId:courseB});
  expect(first.exactExposed).toBe(true);expect(second).toEqual(first);
  expect(f.ledger.find(row=>row.exact_content.expressions.includes('137*19'))?.course_id).toBe(courseA);
 });
 it('same owner across workspaces does not borrow the other workspace exposure',async()=>{
  const f=fixture();
  expect(await readCourseQuestionExposure(f.sql,scopes[0],{...input,text:'141*29'})).toMatchObject({coverage:'complete',exactExposed:false});
  expect(await readCourseQuestionExposure(f.sql,scopes[2],{...input,text:'141*29'})).toMatchObject({coverage:'complete',exactExposed:true});
 });
 it.each([
  ['workspace mismatch with same owner',{...scopes[2],ownerUserId:scopes[1].ownerUserId}],
  ['owner mismatch with existing workspace',{...scopes[0],ownerUserId:scopes[1].ownerUserId}],
 ])('%s cannot pass the workspace-owner authority lookup',async(_name,scope)=>{
  const f=fixture();await expect(readCourseQuestionExposure(f.sql,scope,input)).rejects.toMatchObject({code:'NOT_FOUND'});
  expect(f.queries).toHaveLength(1);
 });
 it('defensive synthetic foreign-owner descriptor cannot contaminate same-workspace read',async()=>{
  const f=fixture();
  // Deliberately adversarial storage row: the database ownership constraint may
  // make this state impossible; this checks the reader predicate, not a valid DB insert.
  f.ledger.push({workspace_id:scopes[0].workspaceId,owner_user_id:scopes[1].ownerUserId,
   course_id:courseB,exact_content:descriptor('149*31')});
  const result=await readCourseQuestionExposure(f.sql,scopes[0],{...input,text:'149*31'});
  expect(result).toMatchObject({coverage:'complete',exactExposed:false});
 });
 it('unknown foreign descriptor does not poison other owner coverage under scoped reader',async()=>{
  const f=fixture();f.ledger[1]!.exact_content={...descriptor('139*23'),grammar:'legacy'};
  expect(await readCourseQuestionExposure(f.sql,scopes[0],input)).toMatchObject({coverage:'complete',exactExposed:true});
  expect(await readCourseQuestionExposure(f.sql,scopes[1],input)).toMatchObject({coverage:'unknown',exactExposed:false});
 });
});
