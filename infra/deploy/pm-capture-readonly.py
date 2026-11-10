#!/usr/bin/python3
"""Completion-only read-only metadata producer. No lifecycle/DB/env/lock content.
Single-file standard-library closure for the existing remote shell tail.
Output is one framed observation, NOT authority. UNKNOWN always exits nonzero.
"""
import argparse
import base64
import json
import os
import re
import stat
import subprocess
import sys
import time

VERSION=2
KIND='existing-pm-target-raw'
FRAME_BEGIN=b'AISTUDY_CAPTURE_V2 '
FRAME_END=b'\nAISTUDY_CAPTURE_V2_END\n'
MAX_FRAME=16*1024*1024
MAX_FILE=1024*1024
SAMPLE_ROOT='/run/aistudy-completion-admission'
ARCHIVE_ROOT='/run/systemd/system/aistudy-completion-retained-205'
UNIT='aistudy-postmigration-completion.service'
LOCK='/etc/aistudy/.worker-provision.lock'
ORIGIN='/run/aistudy-completion/claim-origin.json'
CONTROL_NAMES=('hermes-release.sh','hermes-supervisor.mjs','hermes-config-durability.mjs','hermes-db.mjs','hermes-health.mjs','hermes-writer-control.mjs','hermes-trusted-loader.py','hermes-writer-state.py','hermes-writer-exec.py','hermes-peer-broker.py')
TARGET_PROPS=('Id','LoadState','ActiveState','SubState','MainPID','ControlPID','ExecMainPID','ExecMainStartTimestampMonotonic','ExecMainExitTimestampMonotonic','ActiveEnterTimestampMonotonic','InactiveExitTimestampMonotonic','ExecMainCode','ExecMainStatus','InvocationID','NRestarts','Job','Result','FragmentPath','DropInPaths','NeedDaemonReload','RuntimeMaxUSec','TimeoutStopUSec','Restart','KillMode','Slice','ControlGroup')
ENVELOPE_KEYS={'version','kind','stage','status','entry','state','clockBefore','clockAfter','manager','files','entryFiles','errors'}
CLOCK_KEYS={'startedNs','endedNs','clock','boot','hostId','timeNamespace','collectorCgroup'}
MANAGER_KEYS={'argv','startedNs','endedNs','actualExit','stdoutBase64','stderrBase64'}


def require(ok,reason):
    if not ok:raise ValueError(reason)


def integer(value):return type(value)is int and value>=0


def strict_json(raw):
    def pairs(items):
        result={}
        for key,value in items:
            require(key not in result,'duplicate JSON key')
            result[key]=value
        return result
    def nonfinite(value):raise ValueError('nonfinite JSON')
    return json.loads(raw,object_pairs_hook=pairs,parse_constant=nonfinite)


def b64(value):
    require(type(value)is str,'base64 type')
    return base64.b64decode(value,validate=True)


def paths(stage,state):
    require(stage in ('pre','A','B','C'),'stage')
    require(type(state)is str and re.fullmatch(r'/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_.-]+)*',state) and '/..' not in state,'state')
    result={LOCK:'metadata',state+'/postmigration-completion-claimed':'private',ORIGIN:'private'}
    if stage!='pre':
        result[SAMPLE_ROOT+'/scope.json']='private'
        result.update({SAMPLE_ROOT+'/sample-'+str(i)+suffix+'.json':'private' for i in range(3) for suffix in ('-started','')})
    if stage in ('B','C'):
        result.update({ARCHIVE_ROOT+'/'+name:'private' for name in ('manifest.json','archive-identity.json')})
    return result


def stable(s):return [getattr(s,k) for k in ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')]


def identity(row,category):
    require(type(row)is list and len(row)==9 and all(integer(v) for v in row),'stat identity')
    require(stat.S_ISREG(row[2]) and row[3]==0 and row[5]==1,'root regular single-link')
    require(stat.S_IMODE(row[2]) in ((0o644,0o755) if category=='code' else (0o600,)),'category mode')
    require(row[6]<=MAX_FILE,'file limit')


def fixed_read(path,category):
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        parts=path.split('/')[1:]
        for index,part in enumerate(parts):
            last=index==len(parts)-1
            flags=(os.O_PATH if last and category=='metadata' else os.O_RDONLY)|os.O_NOFOLLOW|os.O_NONBLOCK
            if not last:flags|=os.O_DIRECTORY
            child=os.open(part,flags,dir_fd=fd)
            os.close(fd);fd=child;s=os.fstat(fd)
            sticky=not last and stat.S_ISDIR(s.st_mode) and s.st_uid==0 and bool(s.st_mode&stat.S_ISVTX)
            require(s.st_uid==0 and (not s.st_mode&0o022 or sticky),'directory/file DAC')
            if not last and index==len(parts)-2 and category in ('private','code'):
                require(stat.S_ISDIR(s.st_mode) and stat.S_IMODE(s.st_mode)==0o700,'private parent directory')
        before=stable(s);identity(before,category)
        if category=='metadata':return {'identity':before}
        raw=b''
        while len(raw)<=MAX_FILE:
            block=os.read(fd,65536)
            if not block:break
            raw+=block
        require(len(raw)==s.st_size and stable(os.fstat(fd))==before,'changed file')
        return {'identity':before,'bytesBase64':base64.b64encode(raw).decode()}
    finally:os.close(fd)


def clock_raw():
    start=time.monotonic_ns()
    with open('/proc/sys/kernel/random/boot_id','r',encoding='ascii') as f:boot=f.read().strip()
    with open('/etc/machine-id','r',encoding='ascii') as f:host=f.read().strip()
    namespace=os.readlink('/proc/self/ns/time')
    with open('/proc/self/cgroup','r',encoding='ascii') as f:cgroup=f.read()
    return {'startedNs':start,'endedNs':time.monotonic_ns(),'clock':'CLOCK_MONOTONIC','boot':boot,'hostId':host,'timeNamespace':namespace,'collectorCgroup':cgroup}


def manager_raw():
    argv=['/usr/bin/systemctl','show','--all','--property='+','.join(TARGET_PROPS),UNIT]
    start=time.monotonic_ns()
    r=subprocess.run(argv,stdin=subprocess.DEVNULL,capture_output=True,timeout=15,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
    return {'argv':argv,'startedNs':start,'endedNs':time.monotonic_ns(),'actualExit':r.returncode,'stdoutBase64':base64.b64encode(r.stdout).decode(),'stderrBase64':base64.b64encode(r.stderr).decode()}


def clock_check(clock):
    require(type(clock)is dict and set(clock)==CLOCK_KEYS,'clock schema')
    require(integer(clock['startedNs']) and integer(clock['endedNs']) and clock['startedNs']<=clock['endedNs'],'clock bracket')
    require(clock['clock']=='CLOCK_MONOTONIC' and type(clock['boot'])is str and re.fullmatch('[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',clock['boot']),'clock/boot')
    require(type(clock['hostId'])is str and re.fullmatch('[0-9a-f]{32}',clock['hostId']),'host identity')
    require(type(clock['timeNamespace'])is str and re.fullmatch(r'time:\[[0-9]+\]',clock['timeNamespace']),'time namespace')
    require(type(clock['collectorCgroup'])is str and bool(clock['collectorCgroup']),'collector cgroup')


def manager_check(row,before,after):
    require(type(row)is dict and set(row)==MANAGER_KEYS,'manager schema')
    require(row['argv']==['/usr/bin/systemctl','show','--all','--property='+','.join(TARGET_PROPS),UNIT],'fixed manager argv')
    require(type(row['actualExit'])is int and row['actualExit']==0,'manager nonzero')
    require(integer(row['startedNs']) and integer(row['endedNs']) and before['endedNs']<=row['startedNs']<=row['endedNs']<=after['startedNs'],'manager bracket')
    props={}
    for line in b64(row['stdoutBase64']).decode().splitlines():
        key,sep,value=line.partition('=');require(sep and key not in props,'manager property syntax/duplicate');props[key]=value
    b64(row['stderrBase64'])
    require(set(props)==set(TARGET_PROPS) and props['Id']==UNIT and props['LoadState']=='loaded','manager inventory/unit')
    for name in ('MainPID','ControlPID','ExecMainPID','ExecMainStartTimestampMonotonic','ExecMainExitTimestampMonotonic','ActiveEnterTimestampMonotonic','InactiveExitTimestampMonotonic','ExecMainCode','ExecMainStatus','NRestarts'):
        require(re.fullmatch('[0-9]+',props[name])is not None,'manager integer text')
    require(not props['InvocationID'] or re.fullmatch('[0-9a-f]{32}',props['InvocationID']),'manager invocation')
    return props


def row_check(row,category):
    require(type(row)is dict,'file row')
    if set(row)=={'errno'}:
        require(type(row['errno'])is int and row['errno']>0,'errno');return False
    require(set(row)==({'identity'} if category=='metadata' else {'identity','bytesBase64'}),'file row schema')
    identity(row['identity'],category)
    if category!='metadata':
        body=b64(row['bytesBase64']);require(len(body)==row['identity'][6],'raw size')
        if category=='private':require(type(strict_json(body))is dict,'private JSON object')
    return True


def validate(envelope):
    require(type(envelope)is dict and set(envelope)==ENVELOPE_KEYS,'envelope schema')
    require(type(envelope['version'])is int and envelope['version']==VERSION and envelope['kind']==KIND,'version/kind')
    require(envelope['status']=='COMPLETE' and envelope['errors']==[],'capture UNKNOWN')
    stage=envelope['stage'];state=envelope['state'];inventory=paths(stage,state)
    entry=envelope['entry']
    require(entry is None if stage=='pre' else type(entry)is str and re.fullmatch(r'/tmp/aistudy-entry\.[A-Za-z0-9]{8}',entry) and entry!='/tmp/aistudy-entry.Pz65J76D','entry')
    before=envelope['clockBefore'];after=envelope['clockAfter'];clock_check(before);clock_check(after)
    require(before['endedNs']<=after['startedNs'] and all(before[k]==after[k] for k in ('clock','boot','hostId','timeNamespace','collectorCgroup')),'same target clock identity')
    manager_check(envelope['manager'],before,after)
    files=envelope['files'];require(type(files)is dict and set(files)==set(inventory),'stage file inventory')
    claim=state+'/postmigration-completion-claimed'
    absent=[]
    for path,category in inventory.items():
        if not row_check(files[path],category):
            require(stage!='C' and path in (claim,ORIGIN) and files[path]['errno']==2,'required file unavailable')
            absent.append(path)
    require(not absent or set(absent)=={claim,ORIGIN},'partial claim/origin')
    entries=envelope['entryFiles'];require(type(entries)is dict and set(entries)==(set() if stage=='pre' else set(CONTROL_NAMES)),'ten entry controls')
    for row in entries.values():require(row_check(row,'code'),'code missing')
    return envelope


def frame(envelope):
    body=json.dumps(envelope,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
    require(len(body)<=MAX_FRAME,'frame limit')
    # Leading LF is intentional, original stderr bytes are untouched.
    return b'\n'+FRAME_BEGIN+str(len(body)).encode()+b'\n'+body+FRAME_END


def collect(stage,entry,state):
    inventory=paths(stage,state)
    out={'version':VERSION,'kind':KIND,'stage':stage,'status':'UNKNOWN','entry':entry,'state':state,'clockBefore':None,'clockAfter':None,'manager':None,'files':{},'entryFiles':{},'errors':[]}
    try:
        out['clockBefore']=clock_raw()
        for path,category in inventory.items():
            try:out['files'][path]=fixed_read(path,category)
            except OSError as exc:out['files'][path]={'errno':exc.errno}
        if stage!='pre':
            require(type(entry)is str and re.fullmatch(r'/tmp/aistudy-entry\.[A-Za-z0-9]{8}',entry) and entry!='/tmp/aistudy-entry.Pz65J76D','entry')
            for name in CONTROL_NAMES:out['entryFiles'][name]=fixed_read(entry+'/'+name,'code')
        out['manager']=manager_raw();out['clockAfter']=clock_raw()
        out['status']='COMPLETE';validate(out)
    except Exception as exc:
        out['status']='UNKNOWN';out['errors'].append(type(exc).__name__+':'+str(exc))
    return out


def main(argv=None):
    p=argparse.ArgumentParser();p.add_argument('phase',choices=('target',));p.add_argument('--stage',required=True,choices=('pre','A','B','C'));p.add_argument('--entry');p.add_argument('--state',required=True)
    args=p.parse_args(argv)
    out=collect(args.stage,args.entry,args.state)
    sys.stdout.buffer.write(frame(out));sys.stdout.buffer.flush()
    return 0 if out['status']=='COMPLETE' else 2

if __name__=='__main__':raise SystemExit(main())
