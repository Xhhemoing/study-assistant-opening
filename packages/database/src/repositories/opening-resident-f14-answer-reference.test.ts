import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Sql} from 'postgres';
import {readOpeningTeachingAnswerKey,createOpeningTeachingHintRepository} from './opening-teaching-hints';
import {sqlSimulation,unexpected} from './opening-resident-f14-sql-simulation';
const exposure=vi.hoisted(()=>({generate:vi.fn(),release:vi.fn()}));
vi.mock('./opening-study-exposure',async original=>({...await original<typeof import('./opening-study-exposure')>(),generateOpeningStudyExposure:exposure.generate,releaseOpeningStudyExposure:exposure.release}));
const id=(n:number)=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const scope={workspaceId:id(1),ownerUserId:id(2)},attemptId=id(3),activityId=id(4),blockId=id(5),answerId=id(6),sourceId=id(7),chunkId=id(8),otherSource=id(9),otherChunk=id(10),at='2026-01-01T00:00:00.000Z';
const hint={direction:'Check the premise.',concept:'Use the definition.',firstStep:'Write the first step.'};
type Ref={sourceId:string;version:number|null;chunkId?:string};
function fixture(options:{citations?:unknown;refs?:Ref[];chunks?:Record<string,unknown>[];captured?:Record<string,number>;currentVersion?:number;chunkError?:Error}={}){
 const refs=options.refs??[{sourceId,version:1,chunkId}];
 const tx=sqlSimulation(q=>{
  const s=q.text;
  if(s.startsWith('SELECT id FROM workspaces'))return [{id:scope.workspaceId}];
  if(s.startsWith('INSERT INTO opening_workspace_history_revisions'))return [];
  if(s.startsWith('SELECT revision FROM opening_workspace_history_revisions'))return [{revision:1}];
  if(s.startsWith('SELECT * FROM opening_learning_attempts'))return [{id:attemptId,activity_id:activityId,course_id:id(11),session_id:id(12),item_version_id:id(13),submitted_at:at,source_versions:options.captured??{[sourceId]:1,[otherSource]:1},create_intent:{teachingBlock:{blockId,contentVersion:1}}}];
  if(s.startsWith('SELECT a.* FROM opening_teaching_activities'))return [{content_version:1,source_ids:[sourceId,otherSource]}];
  if(s.startsWith('SELECT s.id,s.version,s.bytes,s.sha256'))return [{id:sourceId,version:options.currentVersion??1},{id:otherSource,version:1}];
  if(s.startsWith('INSERT INTO opening_source_versions'))return [];
  if(s.startsWith('SELECT * FROM opening_teaching_activity_specs'))return [{version:1,document_id:id(14),revision_number:1,source_refs:refs,block_order:[{blockId,blockType:'prompt',role:'prompt',position:0},{blockId:answerId,blockType:'answer_key',role:'answer_key',position:1}]}];
  if(s.startsWith('SELECT blocks FROM library_revisions'))return [{blocks:[{id:answerId,content:{answer:'Verified solution.',hints:hint,citedChunkIds:options.citations===undefined?[chunkId]:options.citations}}]}];
  if(s.startsWith('SELECT c.id,c.source_id,c.source_version')){if(options.chunkError)throw options.chunkError;return options.chunks??[{id:chunkId,source_id:sourceId,source_version:1}]}
  return unexpected(q);
 });
 const sql=Object.assign(tx.sql,{begin:async(fn:(value:typeof tx.sql)=>unknown)=>fn(tx.sql)}) as unknown as Sql;
 return {...tx,legacy:()=>readOpeningTeachingAnswerKey(tx.sql,scope,activityId,blockId,attemptId),hint:(level:1|4)=>createOpeningTeachingHintRepository(sql).read(scope,{attemptId,level})};
}
beforeEach(()=>{vi.resetAllMocks();exposure.generate.mockResolvedValue({id:id(15)});exposure.release.mockResolvedValue({id:id(15),releaseKey:'reference',contextAnchor:{purpose:'history_solution'},origin:'history_solution',supportDomain:'unknown',generatedAt:at,releasedAt:at,acknowledgedAt:null,historyRevision:1})});
describe('F14: answer reference is from the pinned hidden answer citation, not any lesson source',()=>{
 it('legacy answer and full-hint caller both return the actually cited current captured source',async()=>{
  const f=fixture();await expect(f.legacy()).resolves.toEqual({answer:'Verified solution.',referenceSourceId:sourceId});await expect(f.hint(4)).resolves.toMatchObject({text:'Verified solution.',referenceSourceId:sourceId});
 });
 it.each([
  ['wrong chunk',{id:otherChunk,source_id:sourceId,source_version:1}],['wrong source',{id:chunkId,source_id:otherSource,source_version:1}],['wrong version',{id:chunkId,source_id:sourceId,source_version:2}],
 ])('%s returned by chunk lookup cannot become reference provenance',async(_name,row)=>{
  const f=fixture({chunks:[row]});await expect(f.legacy()).resolves.toEqual({answer:'Verified solution.',referenceSourceId:null});
 });
 it.each([['uncited answer',[]],['foreign citation',[otherChunk]],['non-string citation',[42]]])('%s does not promote general teaching refs',async(_name,citations)=>{
  const f=fixture({citations});await expect(f.legacy()).resolves.toMatchObject({referenceSourceId:null});expect(f.queries.some(q=>q.text.startsWith('SELECT c.id,c.source_id'))).toBe(false);
 });
 it('unknown source-ref version cannot supply a reference despite current material availability',async()=>{
  const f=fixture({refs:[{sourceId,version:null,chunkId}],captured:{[sourceId]:0,[otherSource]:1},currentVersion:0,chunks:[{id:chunkId,source_id:sourceId,source_version:0}]});await expect(f.legacy()).resolves.toMatchObject({referenceSourceId:null});expect(f.queries.some(q=>q.text.startsWith('SELECT c.id,c.source_id'))).toBe(false);
 });
 it('later valid citation wins over an earlier unrelated source ref',async()=>{
  const f=fixture({refs:[{sourceId:otherSource,version:1,chunkId:otherChunk},{sourceId,version:1,chunkId}],citations:[chunkId],chunks:[{id:chunkId,source_id:sourceId,source_version:1}]});
  await expect(f.legacy()).resolves.toMatchObject({referenceSourceId:sourceId});
 });
 it('captured attempt source-version drift rejects before reference return',async()=>{
  const f=fixture({captured:{[sourceId]:2,[otherSource]:1}});await expect(f.legacy()).rejects.toMatchObject({code:'CONFLICT'});expect(exposure.generate).not.toHaveBeenCalled();
 });
 it('chunk lookup failure propagates unchanged before any answer-release port',async()=>{
  const error=new Error('citation read failed');const f=fixture({chunkError:error});await expect(f.legacy()).rejects.toBe(error);expect(exposure.generate).not.toHaveBeenCalled();
 });
});
