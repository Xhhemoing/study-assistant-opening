// Test-only object UID injection; production has no environment/CLI bypass.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
export function verifySources(directory) {
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', `
import importlib.util,os,sys
from pathlib import Path
path=Path(sys.argv[1])/'hermes-trusted-loader.py'
spec=importlib.util.spec_from_file_location('bootstrap',path);b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
b.TRUSTED_UID=os.geteuid();sys.argv=[str(path),'verify'];b.main()
`, directory], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Fixture entry preflight refused: ${result.stderr}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Only the synthetic SSH process rewrites the reviewed extractor's object
  // call. Real tar metadata checks and extraction still run unchanged as UID1000.
  const command = process.argv[2].replace('extract(sys.stdin.buffer, sys.argv[2])', 'extract(sys.stdin.buffer, sys.argv[2], uid=os.geteuid())');
  const result = spawnSync('bash', ['-c', command], { stdio: 'inherit', env: process.env });
  process.exitCode = result.status ?? 1;
}
