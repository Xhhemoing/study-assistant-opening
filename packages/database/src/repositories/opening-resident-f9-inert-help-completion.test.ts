import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Sql} from 'postgres';
import {createOpeningTutorJobsRepository} from './opening-tutor-jobs';
import {insertOpeningDeliveredHelp} from './opening-learning-help';
import {sqlSimulation,unexpected,type Query} from './opening-resident-f9-sql-simulation';
const ports=vi.hoisted(()=>({invalidate:vi.fn()}));
vi.mock('./opening-learning-eligibility',()=>({invalidateOpeningLearningEligibility:ports.invalidate}));
const id=(n:number)=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const scope={workspaceId:id(1),ownerUserId:id(2)},jobId=id(3),turnId=id(4),sessionId=id(5),courseId=id(6),attemptId=id(7),itemId=id(8),problemId=id(9),activityId=id(10),receiptId=id(11);
const snapshot={userTurnId:id(12),assistantTurnId:turnId,tutorMode:'hint' as const,studyIntent:null};
const help={id:receiptId,sessionId,attemptId,problemId,activityId,itemVersionId:itemId,turnId,kind:'hint' as const,level:'hinted' as const,delivered:true as const,hintStage:2,initiatedBy:'user' as const,helpInputSnapshot:snapshot};
function inserted(q:Query){
 const match=/INSERT INTO opening_help_exposures\(([^)]+)\) VALUES \((.*)\) RETURNING \*/.exec(q.text);
 if(!match)throw new Error('insert fixture cannot parse selected statement');
 const columns=match[1]!.split(','),expressions=match[2]!.split(',');let i=0;
 return Object.fromEntries(columns.map((c,n)=>[c.trim(),expressions[n]?.trim()==='?'?q.values[i++]:expressions[n]?.trim()==="'assistant'"?'assistant':'2026-01-02T00:00:00.000Z']));
}
function fixture(opts:{claimLost?:boolean;assistantMissing?:boolean;frozen?:unknown;attemptMissing?:boolean;attemptItem?:string;turnMissing?:boolean;existing?:Record<string,unknown>;insertFailure?:Error}={}){
 const writes:Record<string,unknown>[]=[];const events:string[]=[];
 const tx=sqlSimulation(q=>{
  const s=q.text;
  if(s.startsWith('SELECT id FROM workspaces'))return [{id:scope.workspaceId}];
  if(s.startsWith('INSERT INTO opening_workspace_history_revisions'))return [];
  if(s.startsWith('SELECT revision FROM opening_workspace_history_revisions'))return [{revision:1}];
  if(s.startsWith('SELECT privacy_epoch FROM workspaces'))return [{privacy_epoch:4}];
  if(s.startsWith("UPDATE opening_tutor_jobs SET status = 'succeeded'")){events.push('claim');return opts.claimLost?[]:[{id:jobId}]}
  if(s.startsWith('UPDATE opening_turns SET text')){events.push('assistant');return opts.assistantMissing?[]:[{id:turnId}]}
  if(s.startsWith('SELECT l.* FROM opening_learning_sessions'))return [{id:sessionId,course_id:courseId,source_ids:[],activity_id:activityId}];
  if(s.startsWith('SELECT c.id FROM courses'))return [{id:courseId}];
  if(s.startsWith('INSERT INTO opening_learning_history_revisions'))return s.includes('RETURNING revision')?[{revision:2}]:[];
  if(s.startsWith('SELECT revision FROM opening_learning_history_revisions'))return [{revision:1}];
  if(s.startsWith('SELECT t.id FROM opening_turns'))return opts.turnMissing?[]:[{id:turnId}];
  if(s.startsWith('SELECT * FROM opening_learning_attempts'))return opts.attemptMissing?[]:[{problem_id:problemId,item_version_id:opts.attemptItem??itemId}];
  if(s.startsWith('SELECT * FROM opening_help_exposures'))return opts.existing?[opts.existing]:[];
  if(s.startsWith('SELECT u.help_input_snapshot')){events.push('snapshot');return [{help_input_snapshot:opts.frozen===undefined?snapshot:opts.frozen}]}
  if(s.startsWith('UPDATE opening_workspace_history_revisions'))return [{revision:3}];
  if(s.startsWith('INSERT INTO opening_help_exposures')){events.push('insert');if(opts.insertFailure)throw opts.insertFailure;const row=inserted(q);writes.push(row);return [{...row,created_at:'2026-01-02T00:00:00.000Z'}]}
  if(s.startsWith('SELECT DISTINCT COALESCE')){events.push('roots');return [{root_id:id(13)}]}
  if(s.startsWith('INSERT INTO opening_jobs')){events.push('metadata');return [{id:id(14)}]}
  if(s.startsWith('INSERT INTO opening_outbox')){events.push('outbox');return []}
  return unexpected(q);
 });
 const outer=Object.assign(()=>{throw new Error('query outside callback')},{begin:async(fn:(value:typeof tx.sql)=>unknown)=>fn(tx.sql)}) as unknown as Sql;
 const repository=createOpeningTutorJobsRepository(outer);
 return {tx,writes,events,complete:(patch:Partial<Parameters<typeof repository.completeTurn>[0]>={})=>repository.completeTurn({scope,jobId,assistantTurnId:turnId,text:'saved hint',citations:[],candidates:[],helpExposure:help,expectedPrivacyEpoch:4,claimToken:id(15),enqueueMetadata:true,...patch})};
}
beforeEach(()=>{vi.clearAllMocks();ports.invalidate.mockResolvedValue(undefined)});
describe('F9: completed assistant stores inert help, not a release claim',()=>{
 it('real completeTurn and insertion persist generated-only fields without semantic revision or invalidation',async()=>{
  const f=fixture();await f.complete();expect(f.events).toEqual(['claim','assistant','snapshot','insert','metadata','outbox']);
  expect(f.writes).toHaveLength(1);expect(f.writes[0]).toMatchObject({id:receiptId,delivered:false,delivered_at:null,released_at:null,history_revision:0,workspace_history_revision:null,release_key:`assistant:${turnId}`,exposure_origin:'assistant',support_domain:'unknown',context_anchor:{purpose:'learning_help',courseId,activityId,attemptId,itemVersionId:itemId},hint_stage:2,initiated_by:'user',help_input_snapshot:snapshot});
  expect(f.tx.queries.some(q=>q.text.startsWith('UPDATE opening_workspace_history_revisions'))).toBe(false);
  expect(f.tx.queries.some(q=>q.text.startsWith('INSERT INTO opening_learning_history_revisions')&&q.text.includes('RETURNING revision'))).toBe(false);
  expect(ports.invalidate).not.toHaveBeenCalled();
 });
 it('direct delivery positive comparator advances revision and invalidates',async()=>{
  const f=fixture();await expect(insertOpeningDeliveredHelp(f.tx.sql,scope,help)).resolves.toMatchObject({delivered:true,historyRevision:2});
  expect(f.writes[0]).toMatchObject({delivered:true,history_revision:2,workspace_history_revision:3});expect(f.writes[0]?.released_at).not.toBeNull();expect(ports.invalidate).toHaveBeenCalledExactlyOnceWith(f.tx.sql,scope,{rootIds:[id(13)]});
 });
 it('lost completion claim never reaches assistant or help insert',async()=>{const f=fixture({claimLost:true});await f.complete();expect(f.events).toEqual(['claim']);expect(f.writes).toHaveLength(0)});
 it('unpersisted assistant cannot create generated help or metadata',async()=>{const f=fixture({assistantMissing:true});await expect(f.complete()).rejects.toThrow('assistant turn was not persisted');expect(f.events).toEqual(['claim','assistant']);expect(f.writes).toHaveLength(0)});
 it.each([['changed frozen mode',{...snapshot,tutorMode:'explain'}],['missing snapshot',null]])('%s blocks insertion and downstream metadata',async(_name,frozen)=>{
  const f=fixture({frozen});await expect(f.complete()).rejects.toMatchObject({code:'VALIDATION'});expect(f.events).toEqual(['claim','assistant','snapshot']);expect(f.writes).toHaveLength(0);expect(ports.invalidate).not.toHaveBeenCalled();
 });
 it.each([['missing attempt',{attemptMissing:true}],['wrong canonical item',{attemptItem:id(20)}],['unretrievable assistant',{turnMissing:true}]])('%s rejects before receipt insert',async(_name,opts)=>{
  const f=fixture(opts);await expect(f.complete()).rejects.toMatchObject({code:'VALIDATION'});expect(f.writes).toHaveLength(0);expect(f.events).not.toContain('metadata');
 });
 it('matching generated-only replay skips insertion, frozen-input reprobe and invalidation',async()=>{
  const existing={id:receiptId,session_id:sessionId,turn_id:turnId,level:'hinted',kind:'hint',hint_stage:2,initiated_by:'user',help_input_snapshot:snapshot,attempt_id:attemptId,problem_id:problemId,created_at:'2026-01-02T00:00:00.000Z',history_revision:0,delivered_at:null};
  const f=fixture({existing});await f.complete();expect(f.events).toEqual(['claim','assistant','metadata','outbox']);expect(f.writes).toHaveLength(0);expect(ports.invalidate).not.toHaveBeenCalled();
 });
 it('different generated receipt payload rejects without replacing the frozen row',async()=>{
  const existing={id:receiptId,session_id:sessionId,turn_id:turnId,level:'revealed',kind:'hint',attempt_id:attemptId,problem_id:problemId,created_at:'2026-01-02T00:00:00.000Z',history_revision:0};
  const f=fixture({existing});await expect(f.complete()).rejects.toMatchObject({code:'CONFLICT'});expect(f.events).toEqual(['claim','assistant']);expect(f.writes).toHaveLength(0);
 });
 it('insert failure propagates identity after synthetic assistant update without claiming rollback',async()=>{
  const error=new Error('help insert failed');const f=fixture({insertFailure:error});await expect(f.complete()).rejects.toBe(error);expect(f.events).toEqual(['claim','assistant','snapshot','insert']);expect(ports.invalidate).not.toHaveBeenCalled();
 });
});
