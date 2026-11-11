"""No syscalls/manager/target; actual collect/validate/main with pure fake I/O."""
import base64,copy,importlib.util,io,json,stat,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('producer',Path(__file__).resolve().parents[2]/'infra/deploy/pm-capture-readonly.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
def row(body=b'{}',mode=0o600):return {'identity':[1,2,stat.S_IFREG|mode,0,0,1,len(body),1,1],'bytesBase64':base64.b64encode(body).decode()}
def clock(start):return {'startedNs':start,'endedNs':start+1,'clock':'CLOCK_MONOTONIC','boot':'dddddddd-dddd-dddd-dddd-dddddddddddd','hostId':'a'*32,'timeNamespace':'time:[1]','collectorCgroup':'0::/system.slice/synthetic.service\n'}
def manager(exit=0):
 props={k:'' for k in p.TARGET_PROPS};props.update(Id=p.UNIT,LoadState='loaded',InvocationID='b'*32)
 for k in ('MainPID','ControlPID','ExecMainPID','ExecMainStartTimestampMonotonic','ExecMainExitTimestampMonotonic','ActiveEnterTimestampMonotonic','InactiveExitTimestampMonotonic','ExecMainCode','ExecMainStatus','NRestarts'):props[k]='0'
 return {'argv':['/usr/bin/systemctl','show','--all','--property='+','.join(p.TARGET_PROPS),p.UNIT],'startedNs':12,'endedNs':13,'actualExit':exit,'stdoutBase64':base64.b64encode(('\n'.join(k+'='+v for k,v in props.items())+'\n').encode()).decode(),'stderrBase64':''}
def collect(stage='A',missing=None,exit=0,mode=0o600,claim_absent=False,manager_value=None,sample_phase=None):
 def read(path,category):
  if path.endswith('postmigration-completion-claimed') or path==p.ORIGIN:
   if stage!='C' or claim_absent:raise FileNotFoundError(2,'synthetic')
  if path==missing:raise FileNotFoundError(2,'synthetic')
  r=row(mode=0o644 if category=='code' else mode)
  if category=='metadata':r.pop('bytesBase64')
  return r
 with patch.object(p,'clock_raw',side_effect=[clock(10),clock(20)]),patch.object(p,'manager_raw',return_value=manager(exit) if manager_value is None else manager_value),patch.object(p,'fixed_read',side_effect=read):return p.collect(stage,None if stage=='pre' else '/tmp/aistudy-entry.ABCDEFGH','/opt/state',sample_phase)
class Pure(unittest.TestCase):
 def test_stages_complete_and_expected_absence(self):
  for stage in ('pre','A','B','C'):
   out=collect(stage);self.assertEqual(out['status'],'COMPLETE');self.assertEqual(p.validate(out),out)
 def test_mandatory_missing_manager_nonzero_private_mode_unknown(self):
  for out in (collect(missing=p.SAMPLE_ROOT+'/sample-1.json'),collect(exit=5),collect(mode=0o644)):
   self.assertEqual(out['status'],'UNKNOWN')
   with self.assertRaises(ValueError):p.validate(out)
 def test_helper_main_failure_nonzero_framed_diagnostics(self):
  out=collect(exit=5)
  fake=type('Stdout',(),{'buffer':io.BytesIO()})()
  with patch.object(p,'collect',return_value=out),patch.object(p.sys,'stdout',fake):code=p.main(['target','--stage','A','--entry','/tmp/aistudy-entry.ABCDEFGH','--state','/opt/state'])
  self.assertEqual(code,2);self.assertIn(p.FRAME_BEGIN,fake.buffer.getvalue());self.assertIn(b'UNKNOWN',fake.buffer.getvalue())
 def test_frame_has_one_explicit_boundary_preserving_original_diagnostic(self):
  out=collect();wire=p.frame(out);prior=b'original diagnostic without newline'
  self.assertTrue(wire.startswith(b'\nAISTUDY_CAPTURE_V2 '))
  self.assertTrue(wire.endswith(b'\nAISTUDY_CAPTURE_V2_END\n'))
  combined=prior+wire;self.assertEqual(combined[:len(prior)],prior)
  header,body=wire[1:].split(b'\n',1);length=int(header[len(p.FRAME_BEGIN):])
  payload=body[:length];self.assertEqual(body[length:],p.FRAME_END)
  self.assertEqual(p.strict_json(payload),out)
 def test_claim_pair_and_c_requirements_fail_closed(self):
  for stage in ('A','B','C'):
   for missing in (p.LOCK,p.SAMPLE_ROOT+'/scope.json',p.SAMPLE_ROOT+'/sample-2-started.json'):
    out=collect(stage,missing=missing);self.assertEqual(out['status'],'UNKNOWN')
  out=collect('C',missing=p.ORIGIN);self.assertEqual(out['status'],'UNKNOWN')
  submitted=collect('C',claim_absent=True);self.assertEqual(submitted['status'],'COMPLETE')
  self.assertEqual(submitted['files'][p.ORIGIN],{'errno':2})
  self.assertEqual(submitted['files']['/opt/state/postmigration-completion-claimed'],{'errno':2})
  for missing in (p.ARCHIVE_ROOT+'/manifest.json',p.ARCHIVE_ROOT+'/archive-identity.json'):
   self.assertEqual(collect('B',missing=missing)['status'],'UNKNOWN')
 def test_c_submission_snapshot_does_not_wait_for_or_infer_service_claim(self):
  # The independent service remains scheduled after nonblocking submission;
  # producer sees both files absent and never starts, polls, or retries it.
  service={'running':True,'claimCreated':False,'calls':0}
  def observe(path,category):
   if path in (p.ORIGIN,'/opt/state/postmigration-completion-claimed'):
    raise FileNotFoundError(2,'not yet claimed')
   result=row(mode=0o644 if category=='code' else 0o600)
   if category=='metadata':result.pop('bytesBase64')
   return result
  fake=type('Stdout',(),{'buffer':io.BytesIO()})()
  with patch.object(p,'clock_raw',side_effect=[clock(10),clock(20)]),patch.object(p,'manager_raw',return_value=manager()),patch.object(p,'fixed_read',side_effect=observe),patch.object(p.sys,'stdout',fake):
   code=p.main(['target','--stage','C','--entry','/tmp/aistudy-entry.ABCDEFGH','--state','/opt/state'])
  self.assertEqual(code,0);self.assertEqual(service,{'running':True,'claimCreated':False,'calls':0})
  frame=fake.buffer.getvalue();header,rest=frame[1:].split(b'\n',1);size=int(header[len(p.FRAME_BEGIN):]);out=p.strict_json(rest[:size]);self.assertEqual(out['status'],'COMPLETE')
  self.assertEqual(out['files'][p.ORIGIN],{'errno':2});self.assertEqual(out['files']['/opt/state/postmigration-completion-claimed'],{'errno':2})
  self.assertNotIn('restored',out);self.assertEqual(rest[size:],p.FRAME_END)
 def test_c_partial_or_permission_failure_is_unknown(self):
  for missing in (p.ORIGIN,'/opt/state/postmigration-completion-claimed'):
   self.assertEqual(collect('C',missing=missing)['status'],'UNKNOWN')
  def read(path,category):
   if path==p.ORIGIN:raise PermissionError(13,'denied')
   result=row(mode=0o644 if category=='code' else 0o600)
   if category=='metadata':result.pop('bytesBase64')
   return result
  with patch.object(p,'clock_raw',side_effect=[clock(10),clock(20)]),patch.object(p,'manager_raw',return_value=manager()),patch.object(p,'fixed_read',side_effect=read):
   self.assertEqual(p.collect('C','/tmp/aistudy-entry.ABCDEFGH','/opt/state')['status'],'UNKNOWN')
 def test_archived_notfound_only_B_C_exact_and_complete_evidence(self):
  raw=manager();props=dict(line.split('=',1) for line in p.b64(raw['stdoutBase64']).decode().splitlines())
  props.update(Id=p.UNIT,LoadState='not-found',ActiveState='inactive',SubState='dead',Result='success',NeedDaemonReload='no',Job='',InvocationID='',FragmentPath='',DropInPaths='',Slice='',ControlGroup='')
  def encode(values):return {**raw,'stdoutBase64':base64.b64encode(('\n'.join(k+'='+v for k,v in values.items())+'\n').encode()).decode()}
  for stage in ('pre','A','B','C'):
   with patch.object(p,'manager_raw',return_value=encode(props)):
    result=collect(stage,claim_absent=True,manager_value=encode(props))
   self.assertEqual(result['status'],'COMPLETE' if stage in ('B','C') else 'UNKNOWN')
  for key,value in [('MainPID','1'),('InvocationID','a'*32),('FragmentPath','/run/systemd/system/'+p.UNIT),('ControlGroup','/system.slice/x'),('Job','1'),('NRestarts','1'),('ActiveState','active'),('Result','exit-code')]:
   modified={**props,key:value}
   with patch.object(p,'manager_raw',return_value=encode(modified)):
    self.assertEqual(collect('B',claim_absent=True,manager_value=encode(modified))['status'],'UNKNOWN')
    self.assertEqual(collect('C',claim_absent=True,manager_value=encode(modified))['status'],'UNKNOWN')
  with patch.object(p,'manager_raw',return_value=encode(props)):
   self.assertEqual(collect('C',manager_value=encode(props))['status'],'UNKNOWN') # present claim cannot pair with unloaded manager
   for stage in ('B','C'):
    for missing in (p.ARCHIVE_ROOT+'/manifest.json',p.ARCHIVE_ROOT+'/archive-identity.json',p.SAMPLE_ROOT+'/sample-1.json'):
     self.assertEqual(collect(stage,missing=missing,claim_absent=True,manager_value=encode(props))['status'],'UNKNOWN')
 def test_postarchive_explicit_selector_pre_A_C_and_no_old_schema_relaxation(self):
  raw=manager();props=dict(line.split('=',1) for line in p.b64(raw['stdoutBase64']).decode().splitlines())
  props.update(LoadState='not-found',ActiveState='inactive',SubState='dead',Result='success',NeedDaemonReload='no',InvocationID='',FragmentPath='',DropInPaths='',Slice='',ControlGroup='')
  raw={**raw,'stdoutBase64':base64.b64encode(('\n'.join(k+'='+v for k,v in props.items())+'\n').encode()).decode()}
  for stage in ('pre','A','C'):
   out=collect(stage,claim_absent=True,manager_value=raw,sample_phase='postarchive')
   self.assertEqual(out['status'],'COMPLETE');self.assertEqual(out['samplePhase'],'postarchive');p.validate(out)
   self.assertIn(p.ARCHIVE_ROOT+'/manifest.json',out['files'])
   self.assertFalse(any(k.startswith(p.SAMPLE_ROOT+'/') for k in out['files']))
   self.assertEqual(any(k.startswith(p.POSTARCHIVE_SAMPLE_ROOT+'/') for k in out['files']),stage!='pre')
   if stage=='pre':self.assertEqual(out['entryFiles'],{})
   for missing in (p.ARCHIVE_ROOT+'/manifest.json',p.ARCHIVE_ROOT+'/archive-identity.json'):
    self.assertEqual(collect(stage,missing=missing,claim_absent=True,manager_value=raw,sample_phase='postarchive')['status'],'UNKNOWN')
  for stage in ('pre','A'):
   self.assertEqual(collect(stage,claim_absent=True,manager_value=raw)['status'],'UNKNOWN')
   self.assertEqual(collect(stage,sample_phase='postarchive')['status'],'UNKNOWN') # loaded not a postarchive sample
  self.assertEqual(collect('C',sample_phase='postarchive')['status'],'COMPLETE') # loaded observed pair remains structural
  self.assertEqual(collect('C',manager_value=raw,sample_phase='postarchive')['status'],'UNKNOWN')
  out=collect('A',claim_absent=True,manager_value=raw,sample_phase='postarchive');out.pop('samplePhase')
  with self.assertRaises(ValueError):p.validate(out)
 def test_json_duplicate_nonfinite(self):
  for raw in (b'{"x":1,"x":2}',b'{"x":NaN}'):
   with self.assertRaises(ValueError):p.strict_json(raw)
if __name__=='__main__':unittest.main()
