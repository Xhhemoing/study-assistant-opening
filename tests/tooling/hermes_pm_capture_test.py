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
def collect(stage='A',missing=None,exit=0,mode=0o600):
 def read(path,category):
  if path.endswith('postmigration-completion-claimed') or path==p.ORIGIN:
   if stage!='C':raise FileNotFoundError(2,'synthetic')
  if path==missing:raise FileNotFoundError(2,'synthetic')
  r=row(mode=0o644 if category=='code' else mode)
  if category=='metadata':r.pop('bytesBase64')
  return r
 with patch.object(p,'clock_raw',side_effect=[clock(10),clock(20)]),patch.object(p,'manager_raw',return_value=manager(exit)),patch.object(p,'fixed_read',side_effect=read):return p.collect(stage,None if stage=='pre' else '/tmp/aistudy-entry.ABCDEFGH','/opt/state')
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
  for missing in (p.ARCHIVE_ROOT+'/manifest.json',p.ARCHIVE_ROOT+'/archive-identity.json'):
   self.assertEqual(collect('B',missing=missing)['status'],'UNKNOWN')
 def test_json_duplicate_nonfinite(self):
  for raw in (b'{"x":1,"x":2}',b'{"x":NaN}'):
   with self.assertRaises(ValueError):p.strict_json(raw)
if __name__=='__main__':unittest.main()
