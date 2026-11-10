import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {provisionCompletion} from '../../infra/deploy/hermes-writer-control.mjs';

for(const fault of ['flush-after-write','dump-after-write','trailing-bytes','bad-record','cancel-final-drain']) test(`controller terminal result refuses ${fault} after real child success`,t=>{
  const root=mkdtempSync(join(tmpdir(),'sm95-terminal-result-'));t.after(()=>rmSync(root,{recursive:true}));
  const helper=join(root,'helper.py'),hit=join(root,'hit'),result=join(root,'result');
  const injection={
    'flush-after-write':`original=tempfile.TemporaryFile\nclass Fault:\n def __init__(self,*a,**kw): self.file=original(*a,**kw)\n def __enter__(self): return self\n def __exit__(self,*a): return self.file.__exit__(*a)\n def __getattr__(self,name): return getattr(self.file,name)\n def flush(self):\n  self.file.flush()\n  pathlib.Path(${JSON.stringify(hit)}).write_text('actual flush completed')\n  raise OSError('flush after complete bytes')\ntempfile.TemporaryFile=Fault`,
    'dump-after-write':`original=pickle.dump\ndef fault(*a,**kw):\n original(*a,**kw)\n a[1].flush()\n pathlib.Path(${JSON.stringify(hit)}).write_text('actual pickle dump completed')\n raise OSError('dump after complete bytes')\npickle.dump=fault`,
    'trailing-bytes':`original=pickle.dump\ndef fault(value,file):\n original(value,file)\n file.write(b'UNEXPECTED-TRAILING')\n pathlib.Path(${JSON.stringify(hit)}).write_text('extra bytes actually written')\npickle.dump=fault`,
    'bad-record':`original=pickle.dump\ndef fault(value,file):\n original(('not-a-boolean',value),file)\n pathlib.Path(${JSON.stringify(hit)}).write_text('invalid record actually written')\npickle.dump=fault`,
    'cancel-final-drain':`ns=subprocess.run.__globals__\noriginal=ns['drain']\ndef fault():\n pathlib.Path(${JSON.stringify(hit)}).write_text('signal at final drain')\n os.kill(os.getpid(),signal.SIGTERM)\n return original()\nns['drain']=fault`,
  }[fault];
  writeFileSync(helper,`import subprocess,tempfile,pickle,pathlib,os,signal\n${injection}\ntry:\n value=subprocess.run(['/usr/bin/true'],check=True,capture_output=True)\n pathlib.Path(${JSON.stringify(result)}).write_text('SUCCESS'+str(value.returncode))\nexcept BaseException as error:\n pathlib.Path(${JSON.stringify(result)}).write_text('REFUSED:'+type(error).__name__)\n`);
  provisionCompletion(helper,[]);
  assert(readFileSync(hit,'utf8').length>0,'fault hook did not execute');
  assert.match(readFileSync(result,'utf8'),/^REFUSED:/);
});
