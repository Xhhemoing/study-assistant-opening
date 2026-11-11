import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Sql} from 'postgres';
import {createOpeningConversationRepository} from './opening-conversations';
import {mapOpeningStudyExposure} from './opening-study-exposure';
import {sqlSimulation,unexpected} from './opening-resident-f11-sql-simulation';
const ports=vi.hoisted(()=>({release:vi.fn()}));
vi.mock('./opening-study-exposure',async original=>{
 const actual=await original<typeof import('./opening-study-exposure')>();return {...actual,releaseOpeningStudyExposure:ports.release};
});
const id=(n:number)=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const scope={workspaceId:id(1),ownerUserId:id(2)},conversationId=id(3),receiptId=id(4),turnId=id(5),at='2026-01-02T00:00:00.000Z';
const receipt={id:receiptId,release_key:'assistant:delivery',context_anchor:{purpose:'learning_help',courseId:null,activityId:null,attemptId:null,itemVersionId:null},exposure_origin:'assistant',support_domain:'unknown',generated_at:at,released_at:null,acknowledged_at:null,history_revision:0};
function turn(patch:Record<string,unknown>={}){return {id:turnId,conversation_id:conversationId,role:'assistant',status:'complete',text:'saved answer',mode:'hint',created_at:at,citations:[],exposure_receipt:receipt,...patch}}
function fixture(rows:Record<string,unknown>[],options:{owned?:boolean;summary?:boolean;preview?:string|null}={}){
 const pool=sqlSimulation(q=>{
  if(q.text.startsWith('SELECT id, title, course_id, updated_at'))return options.owned===false?[]:[{id:conversationId,title:'saved',course_id:null,updated_at:at}];
  if(q.text.startsWith('SELECT c.id,'))return [{id:conversationId,title:'saved',course_id:null,updated_at:at,preview_turn_id:turnId,last_turn_preview:options.preview===undefined?'saved preview':options.preview}];
  if(q.text.startsWith('SELECT t.id, t.conversation_id')||q.text.startsWith('SELECT t.id,t.role')||q.text.startsWith('SELECT t.role,t.status'))return rows;
  return unexpected(q);
 });
 const tx=sqlSimulation(q=>{
  if(q.text.startsWith('SELECT id FROM workspaces'))return [{id:scope.workspaceId}];
  if(q.text.startsWith('INSERT INTO opening_workspace_history_revisions'))return [];
  if(q.text.startsWith('SELECT revision FROM opening_workspace_history_revisions'))return [{revision:1}];
  return unexpected(q);
 });
 const begin=vi.fn(async(fn:(value:typeof tx.sql)=>unknown)=>fn(tx.sql));const sql=Object.assign(pool.sql,{begin}) as unknown as Sql;
 return {repository:createOpeningConversationRepository(sql),pool,tx,begin};
}
beforeEach(()=>{vi.resetAllMocks();ports.release.mockImplementation(async(_tx,_scope,key)=>({...mapOpeningStudyExposure({...receipt,id:key}),releasedAt:at,historyRevision:7}))});
describe('F11: public saved-conversation reads own release selection, continuity stays inert',()=>{
 it('listTurns releases selected complete assistant receipt and returns fresh release result',async()=>{
  const f=fixture([turn()]);const result=await f.repository.listTurns(scope,conversationId);
  expect(ports.release).toHaveBeenCalledExactlyOnceWith(f.tx.sql,scope,receiptId);expect(f.begin).toHaveBeenCalledOnce();
  expect(result[0]).toMatchObject({id:turnId,text:'saved answer',exposureReceipt:{id:receiptId,releasedAt:at,historyRevision:7}});
  expect(f.tx.queries.at(-1)?.text).toContain('FOR UPDATE');
 });
 it.each([
  ['user',{role:'user'}],['pending assistant',{status:'pending'}],['failed assistant',{status:'failed'}],['missing receipt',{exposure_receipt:null}],['already released',{exposure_receipt:{...receipt,released_at:at}}],
 ])('%s does not trigger a release callback or transaction',async(_name,patch)=>{
  const f=fixture([turn(patch)]);await f.repository.listTurns(scope,conversationId);expect(ports.release).not.toHaveBeenCalled();expect(f.begin).not.toHaveBeenCalled();
 });
 it('a mixed result releases only pending completed assistant receipt identities',async()=>{
  const other=id(6);const f=fixture([turn(),turn({id:id(7),status:'pending',exposure_receipt:{...receipt,id:other}}),turn({id:id(8),exposure_receipt:{...receipt,id:id(9),released_at:at}})]);
  const result=await f.repository.listTurns(scope,conversationId);expect(ports.release).toHaveBeenCalledExactlyOnceWith(f.tx.sql,scope,receiptId);expect(result).toHaveLength(3);
 });
 it('release error propagates unchanged instead of returning unreleased answer',async()=>{
  const error=new Error('release denied');ports.release.mockRejectedValueOnce(error);const f=fixture([turn()]);await expect(f.repository.listTurns(scope,conversationId)).rejects.toBe(error);
 });
 it('ownership failure stops before turn reads or release',async()=>{
  const f=fixture([turn()],{owned:false});await expect(f.repository.listTurns(scope,conversationId)).rejects.toMatchObject({code:'NOT_FOUND'});expect(f.pool.queries).toHaveLength(1);expect(ports.release).not.toHaveBeenCalled();
 });
 it('internal continuity read never releases even if responder supplies receipt-bearing completed row',async()=>{
  const f=fixture([turn()]);await expect(f.repository.loadContinuityTurns(scope,conversationId)).resolves.toEqual([{id:turnId,role:'assistant',text:'saved answer',citations:[]}]);
  expect(ports.release).not.toHaveBeenCalled();expect(f.begin).not.toHaveBeenCalled();
 });
 it('summary preview releases the returned preview turn id before mapping summaries',async()=>{
  const f=fixture([turn()],{summary:true});const result=await f.repository.listSummaries(scope);expect(result[0]).toMatchObject({id:conversationId,lastTurnPreview:'saved preview'});
  expect(ports.release).toHaveBeenCalledExactlyOnceWith(f.tx.sql,scope,receiptId);
  const selection=f.pool.queries.find(q=>q.text.startsWith('SELECT t.role,t.status'))!;expect(selection.values).toContainEqual([turnId]);
 });
 it('empty preview does not release a hidden turn',async()=>{
  const f=fixture([turn()],{preview:null});await f.repository.listSummaries(scope);expect(f.pool.queries).toHaveLength(1);expect(ports.release).not.toHaveBeenCalled();
 });
 it('summary release rejection reaches caller',async()=>{
  const error=new Error('preview release denied');ports.release.mockRejectedValueOnce(error);const f=fixture([turn()]);await expect(f.repository.listSummaries(scope)).rejects.toBe(error);
 });
 it('explicit empty returned-id list performs no query or release',async()=>{
  const f=fixture([turn()]);await f.repository.releaseReturnedTurnIds(scope,conversationId,[]);expect(f.pool.queries).toHaveLength(0);expect(ports.release).not.toHaveBeenCalled();
 });
});
