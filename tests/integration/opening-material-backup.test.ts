import {randomUUID} from 'node:crypto';
import {afterAll,expect,it} from 'vitest';
import {createOpeningMaterialManifestRepository,createOpeningSourceChunksRepository,readOpeningBackupRecords,readOpeningRestoreNamespaceCounts,executeOpeningRestoreApply} from '@aistudy/database';
import {OPENING_RESTORE_APPLY_ORDER,type OpeningBackup} from '@aistudy/domain';
import {createBackupFixture,type BackupFixture} from './opening-backup-records-fixture';
const fixtures:BackupFixture[]=[];
async function empty(f:BackupFixture){await f.sql.begin(async tx=>{for(const table of [...OPENING_RESTORE_APPLY_ORDER].reverse()){
 if(table==='opening_source_chunks')await tx`DELETE FROM opening_source_chunks WHERE source_id IN (SELECT id FROM opening_sources WHERE workspace_id=${f.scope.workspaceId})`;
 else await tx`DELETE FROM ${tx(table)} WHERE workspace_id=${f.scope.workspaceId}`;
}});}
afterAll(async()=>{for(const f of fixtures){try{await empty(f);}finally{await f.dispose();}}});
it('real export/restore retains restricted page roles, question identity and disputed links without creating paid work',async()=>{
 const f=await createBackupFixture();fixtures.push(f);const {sql,scope}=f;
 const source=await f.rows.source();
 await sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text) VALUES(${source},1,1,'question'),(${source},1,2,'PRIVATE ANSWER')`;
 const key={family:'T1',number:'1',subquestion:''};
 await createOpeningMaterialManifestRepository(sql).write(scope,source,{sourceVersion:1,expectedRevision:0,manifest:{role:'mixed',sections:[{startPage:1,endPage:1,role:'exercise'},{startPage:2,endPage:2,role:'answer_key'}],questions:[{...key,page:1,stem:'question'}],answers:[{page:2,questionSourceId:source,questionSourceVersion:1,question:key,text:'answer',status:'disputed',reason:'待核验'}]}});
 const records=await readOpeningBackupRecords(sql,scope);
 const backup=JSON.parse(JSON.stringify({format:'opening-backup',version:1,workspaceId:scope.workspaceId,privacyEpoch:records.privacyEpoch,deletionJournal:records.deletionJournal,memoryDeletions:records.memoryDeletions,tables:records.tables,objects:[]})) as OpeningBackup;
 const expected=backup.tables.opening_source_versions[0]!.material_manifest;
 await empty(f);expect(Object.values(await readOpeningRestoreNamespaceCounts(sql,scope.workspaceId)).every(n=>n===0)).toBe(true);
 const current=await readOpeningBackupRecords(sql,scope);
 const result=await executeOpeningRestoreApply(sql,{confirmLocalRestore:true,backup,currentDeletionJournal:current.deletionJournal,currentMemoryDeletions:current.memoryDeletions,currentLearningState:{workspacePreferences:current.tables.workspace_preferences[0]??null,courses:current.tables.courses}});
 expect(result,JSON.stringify(result)).toMatchObject({ok:true,code:'APPLY_OK'});
 const [row]=await sql`SELECT material_manifest,material_manifest_revision FROM opening_source_versions WHERE source_id=${source} AND version=1`;
 expect(row).toMatchObject({material_manifest:expected,material_manifest_revision:1});
 expect((await createOpeningSourceChunksRepository(sql).listForSources(scope,[source])).map(c=>c.page)).toEqual([1]);
 expect(await sql`SELECT id FROM opening_jobs WHERE workspace_id=${scope.workspaceId}`).toHaveLength(0);
 expect(await sql`SELECT id FROM opening_budget_reservations WHERE workspace_id=${scope.workspaceId}`).toHaveLength(0);
});
it('reviewer references never prevent deleting an account while retained source-version history survives',async()=>{
 const f=await createBackupFixture();fixtures.push(f);const {sql,scope}=f;
 const source=await f.rows.source();await sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text) VALUES(${source},1,1,'text')`;
 const reviewer=randomUUID();await sql`INSERT INTO users(id,email,display_name,password_hash) VALUES(${reviewer},${reviewer+'@example.test'},'temporary reviewer','test')`;
 await createOpeningMaterialManifestRepository(sql).write(scope,source,{sourceVersion:1,expectedRevision:0,manifest:{role:'lecture'}});
 await sql`UPDATE opening_source_versions SET material_reviewed_by=${reviewer} WHERE source_id=${source}`;
 await sql`DELETE FROM users WHERE id=${reviewer}`;
 const [row]=await sql`SELECT material_reviewed_by,material_manifest FROM opening_source_versions WHERE source_id=${source}`;
 expect(row).toMatchObject({material_reviewed_by:null,material_manifest:{role:'lecture'}});
});
