import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {provisionCompletion} from '../../infra/deploy/hermes-writer-control.mjs';

test('drain and observe faults retain until real empty proof then commit failure and restore',t=>{
  const root=mkdtempSync(join(tmpdir(),'sm95-empty-drain-cleanup-'));t.after(()=>rmSync(root,{recursive:true}));
  const systemd=join(root,'systemd'),config=join(root,'config');for(const p of [systemd,config])mkdirSync(p,{mode:0o700});
  const unit=join(systemd,'aistudy-worker.service'),runtime=join(config,'worker-runtime.env');
  writeFileSync(unit,'old-unit',{mode:0o600});writeFileSync(runtime,'old-runtime',{mode:0o600});writeFileSync(join(config,'.worker-provision.lock'),'',{mode:0o600});
  const proof=join(root,'proof');
  const helper=join(root,'helper.py');writeFileSync(helper,`from pathlib import Path\nPath(${JSON.stringify(unit)}).write_text('candidate-unit')\nPath(${JSON.stringify(runtime)}).write_text('candidate-runtime')\nraise SystemExit(7)\n`);
  assert.throws(()=>provisionCompletion(helper,['--systemd-dir',systemd,'--config-dir',config],(file,args,options)=>{
    const changed=[...args],index=changed.indexOf('-c')+1;
    const injection=`\nreal_drain=drain\nreal_children=children\nobserve_failed=False\ndef raised_empty():\n value=real_drain()\n caller=sys._getframe(1)\n if caller.f_code.co_name=='require_empty_scope' or (caller.f_code.co_name=='leaf' and not caller.f_locals.get('cleanup_only',False)):\n  raise OSError('confirmed empty drain failure')\n return value\ndef failed_observation():\n global observe_failed\n if sys._getframe(1).f_code.co_name=='require_empty_scope' and not observe_failed:\n  observe_failed=True\n  raise OSError('one failed empty-scope observation')\n values=real_children()\n if sys._getframe(1).f_code.co_name=='retain_unknown' and not values:\n  with open(${JSON.stringify(proof)},'a') as out:out.write('retention-empty\\n')\n return values\nreal_commit=terminal_commit\nconfig_owner_pid=os.getpid()\ndef marked_commit(code):\n if os.getpid()==config_owner_pid:\n  with open(${JSON.stringify(proof)},'a') as out:out.write('commit\\n')\n return real_commit(code)\nterminal_commit=marked_commit\ndrain=raised_empty\nchildren=failed_observation\n`;
    changed[index]=changed[index].replace('def require_empty_scope():',injection+'\ndef require_empty_scope():')
      .replace('preimage=[]',`import functools\ntrusted['safe_open']=functools.partial(trusted['safe_open'],uid=os.geteuid())\ntrusted['read_trusted']=functools.partial(trusted['read_trusted'],uid=os.geteuid())\npreimage=[]`)
      .replace("['/usr/bin/systemctl','daemon-reload']",`['/usr/bin/python3','-c',${JSON.stringify(`open(${JSON.stringify(proof)},'a').write('reload'+chr(10))`)}]`);
    const r=spawnSync(file,changed,{...options,stdio:'pipe'});
    assert.equal(r.status,1);assert.equal(r.signal,null);
    assert.match(r.stderr.toString(),/UNKNOWN: owned cleanup unconfirmed/);
    assert(!r.stderr.toString().includes('RESTORE_UNCONFIRMED'),r.stderr.toString());
    return r;
  }),/immutable provision helper failed/);
  assert.equal(readFileSync(unit,'utf8'),'old-unit');assert.equal(readFileSync(runtime,'utf8'),'old-runtime');
  const steps=readFileSync(proof,'utf8').trim().split('\n');
  assert.equal(steps[0],'retention-empty');assert(steps.includes('commit'));assert.equal(steps.at(-1),'reload');
});

