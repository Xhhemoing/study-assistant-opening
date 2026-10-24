#!/usr/bin/env node
/** Verify the upstream vendor manifest without requiring a sibling SenseWeave checkout. */
import {readFile, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve, relative, sep} from 'node:path';
const root=fileURLToPath(new URL('../packages/senseweave/vendor/',import.meta.url));
const manifest=JSON.parse(await readFile(resolve(root,'VENDOR.json'),'utf8'));
async function walk(dir){const paths=[];for(const item of await readdir(dir,{withFileTypes:true})){const p=resolve(dir,item.name);if(item.isSymbolicLink())throw Error('Vendor symlink is not allowed');if(item.isDirectory())paths.push(...await walk(p));else paths.push(p);}return paths;}
const present=new Map((await walk(root)).map(p=>[relative(root,p).split(sep).join('/'),p]));present.delete('VENDOR.json');
const errors=[];
for(const [name,expected] of Object.entries(manifest.files)) {
  const path=present.get(name);
  if(!path)errors.push(`missing ${name}`);
  else if(createHash('sha256').update(await readFile(path)).digest('hex')!==expected)errors.push(`edited ${name}`);
  present.delete(name);
}
for(const name of present.keys())errors.push(`unexpected ${name}`);
if(manifest.dirty||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.commit))errors.push('vendor must identify a clean upstream commit');
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}
else console.log(`SenseWeave vendor OK: ${manifest.commit}; ${Object.keys(manifest.files).length} files`);
