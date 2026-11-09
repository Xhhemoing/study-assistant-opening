// Test-only object UID injection; production has no environment/CLI bypass.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
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
  let result;
  if (process.argv[2] === 'preflight') {
    // Same production read-only preflight, with an object-only fixture UID.
    const source = readFileSync(0, 'utf8').replace('const { preflightConfiguration } =', 'const { preflightConfiguration: productionPreflight } =')
      .replace('preflightConfiguration(args, command =>', 'const preflightConfiguration = (args, run) => productionPreflight(args, run, { trustedUid: process.geteuid() });\npreflightConfiguration(args, command =>');
    result = spawnSync(process.execPath, ['--input-type=module', '-', ...process.argv.slice(5)], { input: source, stdio: ['pipe', 'inherit', 'inherit'], env: process.env });
  } else {
    const command = process.argv[2].replace('extract(sys.stdin.buffer, sys.argv[2])', 'extract(sys.stdin.buffer, sys.argv[2], uid=os.geteuid())');
    result = spawnSync('bash', ['-c', command], { stdio: 'inherit', env: process.env });
  }
  process.exitCode = result.status ?? 1;
}
