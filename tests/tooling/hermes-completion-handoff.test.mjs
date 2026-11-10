import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

const boundaries=[
  ['local result=0','before'],['node "$@"','before'],['COMPLETION_NODE_PID=$!','held'],
  ['wait "$COMPLETION_NODE_PID"','held'],['result=$?','after'],["COMPLETION_NODE_PID=''",'after'],['return "$result"','after'],
];
for(const [boundary,stage] of boundaries) for(const mode of ['group','repeated-group','bash-only']) test(`real ${mode} TERM at completion_node ${boundary} orders owner before real finish`,t=>{
  const phase='restore-reload';
  const root=mkdtempSync(join(tmpdir(),'sm95-pgterm-'));t.after(()=>rmSync(root,{recursive:true}));
  const systemd=join(root,'systemd'),config=join(root,'config');for(const path of [systemd,config])mkdirSync(path,{mode:0o700});
  const unit=join(systemd,'aistudy-worker.service'),runtime=join(config,'worker-runtime.env'),hit=join(root,'hit'),release=join(root,'release'),events=join(root,'events'),done=join(root,'finish');
  writeFileSync(unit,'old-unit',{mode:0o600});writeFileSync(runtime,'old-runtime',{mode:0o600});writeFileSync(join(config,'.worker-provision.lock'),'',{mode:0o600});
  const helper=join(root,'helper.py');writeFileSync(helper,`from pathlib import Path\nPath(${JSON.stringify(unit)}).write_text('candidate-unit')\nPath(${JSON.stringify(runtime)}).write_text('candidate-runtime')\nraise SystemExit(${phase==='pending-commit'?0:7})\n`);
  const reload=join(root,'reload.py');writeFileSync(reload,`import pathlib,time,os\nevents=pathlib.Path(${JSON.stringify(events)})\nevents.write_text(events.read_text()+'reload-enter\\n' if events.exists() else 'reload-enter\\n')\n${stage==='held'?`pathlib.Path(${JSON.stringify(hit)}).write_text(str(os.getpid()))\nwhile not pathlib.Path(${JSON.stringify(release)}).exists():time.sleep(.002)\n`:''}events.write_text(events.read_text()+'reload-exit\\n')\n`);
  const node=join(root,'node.mjs');
  const injection=`\nimport pathlib\nreal_commit=terminal_commit\ndef pending_commit(code):\n signal.pthread_sigmask(signal.SIG_BLOCK,cancel_signals)\n pathlib.Path(${JSON.stringify(hit)}).write_text(str(os.getpid()))\n while not pathlib.Path(${JSON.stringify(release)}).exists(): time.sleep(.002)\n return real_commit(code)\nterminal_commit=pending_commit\n`;
  writeFileSync(node,`import {spawnSync} from 'node:child_process';\nimport {ownedNodeCLI,provisionCompletion} from ${JSON.stringify(new URL('../../infra/deploy/hermes-writer-control.mjs',import.meta.url).href)};\nawait ownedNodeCLI(()=>provisionCompletion(${JSON.stringify(helper)},['--systemd-dir',${JSON.stringify(systemd)},'--config-dir',${JSON.stringify(config)}],(file,args,options)=>{\nconst changed=[...args],index=changed.indexOf('-c')+1;\nchanged[index]=changed[index].replace('preimage=[]',${JSON.stringify("import functools\ntrusted['safe_open']=functools.partial(trusted['safe_open'],uid=os.geteuid())\ntrusted['read_trusted']=functools.partial(trusted['read_trusted'],uid=os.geteuid())\npreimage=[]")}).replace("['/usr/bin/systemctl','daemon-reload']",${JSON.stringify("['/usr/bin/python3',"+JSON.stringify(reload)+"]")});\n${phase==='pending-commit'?`changed[index]=changed[index].replace('final_status=terminal_commit',${JSON.stringify(injection+'\nfinal_status=terminal_commit')});`:''}\nreturn spawnSync(file,changed,{...options,stdio:'pipe'});\n}));\n`);
  const source=readFileSync(resolve('infra/deploy/hermes-release.sh'),'utf8');
  const functions=source.slice(source.indexOf("COMPLETION_NODE_PID=''"),source.indexOf('\ntrap \'finish $?\' EXIT'));
  const debug=`set -T\nDEBUG_BOUNDARY=${JSON.stringify(boundary).replaceAll('$','\\$')}\ntrap 'if [[ "$BASH_SUBSHELL" == 0 && "\${FUNCNAME[0]:-}" == completion_node && "$BASH_COMMAND" == "$DEBUG_BOUNDARY" && ! -e ${join(root,'debug-hit')} ]]; then ${stage==='held'?`while [[ ! -e ${hit} ]]; do /bin/sleep .002; done;`:''} printf hit > ${join(root,'debug-hit')}; printf "handoff\\n" >> ${events}; while [[ ! -e ${release} ]]; do /bin/sleep .002; done; fi' DEBUG`;
  const realFinish=source.slice(source.indexOf('finish() {'),source.indexOf('# Cancellation must not let Bash finish'));
  const finish=`SUCCESS_REQUESTED=0
ACTION=complete-postmigration
FORWARD_ONLY=1
RECOVERY_REQUIRED=0
FORWARD_GUARD=${JSON.stringify(join(root,'guard'))}
STATE=${JSON.stringify(root)}
TRANSITION=${JSON.stringify(root)}
ARCHIVE=''
CONTROL_ARCHIVE=''
CONTROL_ROOT=''
managed() { printf '%s\\n' "$1" >> ${JSON.stringify(events)}; if [[ "$1" == stop ]]; then printf '143' > ${JSON.stringify(done)}; fi; }
timeout() { printf 'quiescence\\n' >> ${JSON.stringify(events)}; return 1; }
${realFinish}`;
  const shell=join(root,'run.sh');writeFileSync(shell,`set -e\n${functions}\n${finish}\n${debug}\ntrap 'finish $?' EXIT\ntrap 'completion_cancel 143' TERM\ntrap 'completion_cancel 130' INT\ntrap 'completion_cancel 129' HUP\ncompletion_node ${JSON.stringify(node)}\nprintf 'UNEXPECTED NEXT STEP' >> ${JSON.stringify(events)}\n`);
  const driver=`import subprocess,os,signal,pathlib,time\nchild=subprocess.Popen(['/bin/bash',${JSON.stringify(shell)}],start_new_session=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)\nneighbor=subprocess.Popen(['/usr/bin/sleep','20'],start_new_session=True)\ntry:\n deadline=time.monotonic()+4\n while not pathlib.Path(${JSON.stringify(join(root,'debug-hit'))}).exists():\n  assert child.poll() is None,child.communicate()\n  assert time.monotonic()<deadline,'barrier not reached'\n  time.sleep(.002)\n while 'handoff' not in pathlib.Path(${JSON.stringify(events)}).read_text():\n  assert time.monotonic()<deadline,'handoff trace not hit'\n  time.sleep(.002)\n ${mode==='bash-only'?'os.kill(child.pid,signal.SIGTERM)':'os.killpg(child.pid,signal.SIGTERM)'}\n time.sleep(.04)\n ${mode==='repeated-group'?"try:os.killpg(child.pid,signal.SIGTERM)\n except ProcessLookupError:pass":'# Single cancellation'}\n time.sleep(.04)\n ${stage==='held'?`assert not pathlib.Path(${JSON.stringify(done)}).exists(),'finish raced held owner at PID publication'\n assert child.poll() is None,'shell exited before owned reload'\n assert pathlib.Path(${JSON.stringify(events)}).read_text()=='reload-enter\\nhandoff\\n',pathlib.Path(${JSON.stringify(events)}).read_text()`:'# No live owner exists at this boundary; immediate finish is permitted.'}\n pathlib.Path(${JSON.stringify(release)}).touch()\n stdout,stderr=child.communicate(timeout=4)\n assert child.returncode!=0,(stdout,stderr)\n assert pathlib.Path(${JSON.stringify(unit)}).read_text()=='old-unit',(stdout,stderr)\n assert pathlib.Path(${JSON.stringify(runtime)}).read_text()=='old-runtime'\n assert pathlib.Path(${JSON.stringify(events)}).read_text()==${JSON.stringify(stage==='held'?'reload-enter\nhandoff\nreload-exit\nrefence\nstop\nquiescence\n':stage==='before'?'handoff\nrefence\nstop\nquiescence\n':'reload-enter\nreload-exit\nhandoff\nrefence\nstop\nquiescence\n')},pathlib.Path(${JSON.stringify(events)}).read_text()
 print('owned-before-finish: '+pathlib.Path(${JSON.stringify(events)}).read_text())\n assert neighbor.poll() is None\nfinally:\n pathlib.Path(${JSON.stringify(release)}).touch()\n if child.poll() is None:os.killpg(child.pid,signal.SIGKILL);child.wait()\n neighbor.kill();neighbor.wait()\n`;
  const result=spawnSync('/usr/bin/python3',['-I','-S','-B','-c',driver],{encoding:'utf8',timeout:10_000});console.log(result.stdout);assert.equal(result.status,0,result.stderr);
});
