#!/usr/bin/env node
// Freeze this stdout + source hashes for PM review; never connects to production.
// stdin program runs without installing candidate controls or creating files.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { completionLedgerProgram } from '../../infra/deploy/hermes-writer-control.mjs';
const root = fileURLToPath(new URL('../../infra/deploy/', import.meta.url));
const names = ['hermes-trusted-loader.py', 'hermes-writer-exec.py', 'hermes-peer-broker.py', 'hermes-writer-state.py'];
const entryNames = [...names, 'hermes-release.sh', 'hermes-supervisor.mjs', 'hermes-config-durability.mjs', 'hermes-db.mjs', 'hermes-health.mjs', 'hermes-writer-control.mjs'];
const sizes = Object.fromEntries(entryNames.map(name => [name, readFileSync(root + name).length]));
const sources = Object.fromEntries(names.map(name => [name, readFileSync(root + name, 'utf8')]));
const probe = `const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');
const { pathToFileURL } = require('node:url');
const config = parseEnv(readFileSync(process.argv[1], 'utf8'));
if (!config.DATABASE_URL) throw new Error('Configured database required');
const result = spawnSync('timeout', ['--signal=KILL', '45s', process.execPath, '--import', pathToFileURL(process.argv[2] + '/node_modules/tsx/dist/esm/index.mjs').href, '--input-type=module', '--eval', process.argv[3]], {
 cwd: process.argv[2], env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TSX_DISABLE_CACHE: '1', DATABASE_URL: config.DATABASE_URL }, stdio: ['ignore','pipe','pipe'], timeout: 50000 });
if (result.error || result.status !== 0) throw new Error('Completion DB readonly observation refused');
process.stdout.write(result.stdout);`;
// release is a required explicit argument, not an operator assertion of success.
const ledgerTemplate = completionLedgerProgram('/__COMPLETION_RELEASE__');
const program = `import fcntl,types,sys,os,subprocess,json,xml.etree.ElementTree as ET
sources=${JSON.stringify(sources)}
bootstrap=types.ModuleType('bootstrap')
exec(sources['hermes-trusted-loader.py'],bootstrap.__dict__)
class MemorySourceLoader(bootstrap.SourceLoader):
    def verify(self):
        if set(sources)!=set(bootstrap.SOURCES) or any(not isinstance(v,str) for v in sources.values()):
            raise ValueError('Incomplete memory source inventory')
        captured={k:(v.encode(),None) for k,v in sources.items()}
        if self.sources is not None and self.sources!=captured:
            raise ValueError('Memory source changed')
        self.sources=captured
loader=MemorySourceLoader('/reviewed-memory')
m=loader.load('hermes-writer-state.py')
m.completion_control_inventory=lambda: ${JSON.stringify(sizes)}
if len(sys.argv)!=8: raise ValueError('Expected state current systemd release config retained-gzip worker-config-dir')
fd=bootstrap.safe_open(sys.argv[1]+'/deploy.lock',private=True)
try:
    fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    failures=[]
    payload_modules_verified=False
    def observe(name, call):
        try:
            value=call()
            print(json.dumps({'readonlyProbe':name,'ok':True,'result':value}),flush=True)
            return value
        except Exception as error:
            failures.append(error)
            print(json.dumps({'readonlyProbe':name,'ok':False,'errorType':type(error).__name__,'reason':str(error)}),flush=True)
            return None
    observe('paths',lambda: {'state':sys.argv[1],'current':sys.argv[2],'systemd':sys.argv[3],
        'release':sys.argv[4],'config':sys.argv[5],'retainedGzip':sys.argv[6],'workerConfig':sys.argv[7]})
    def config_link():
        path=m.Path(sys.argv[4])/'.env.production'
        before=os.lstat(path)
        target=os.readlink(path)
        if target!=sys.argv[5] or m.identity(before)!=m.identity(os.lstat(path)):
            raise ValueError('Config link identity/target changed')
        return {'path':str(path),'target':target,'identity':m.identity(before)}
    observe('config-link-metadata',config_link)
    generated=observe('generated-exact-metadata-hashes-NOT-admission',lambda:m.completion_generated_observation(sys.argv[4]))
    # Keep every independent readonly result, rather than stopping at the first
    # PG/client/payload/capacity problem. Never continue to a mutating operation.
    observe('incident-guard',lambda:m.completion_incident_check(*sys.argv[1:]))
    def backup_path():
        return m.read_trusted(m.Path(sys.argv[1])/'releases'/m.COMPLETION_INCIDENT/'database-backup',private=True)[0].decode().strip()
    backup=observe('backup-path',backup_path)
    observe('backup-pg16-toc',lambda:m.completion_backup_toc(backup))
    def payload():
        global payload_modules_verified
        try:
            value=m.completion_payload(sys.argv[4],sys.argv[5],sys.argv[6])
            payload_modules_verified=True
            return value
        except m.CompletionPayloadExtras as error:
            # Reporting only: full signed module bytes were compared. Exact
            # observed parser extras still REJECT admission, not an exclusion.
            payload_modules_verified=error.only_observed_generated and generated is not None and len(generated.get('files',[]))==4
            raise
    observe('payload',payload)
    observe('both-historical-units',lambda:m.check_historical_manager(m.Path(sys.argv[1]),sys.argv[3]))
    observe('capacity',lambda:m.completion_capacity(sys.argv[1],sys.argv[4],sys.argv[3],sys.argv[7],sys.argv[6],os.path.dirname(backup)))
    def capabilities(unit):
        obj='/org/freedesktop/systemd1/unit/'+unit.replace('-','_2d').replace('.','_2e')
        xml=subprocess.run(['/usr/bin/busctl','--system','--xml-interface','introspect',
            'org.freedesktop.systemd1',obj,'org.freedesktop.systemd1.Service'],
            check=True,capture_output=True,text=True,timeout=5)
        properties={p.attrib['name']:p.attrib.get('type') for p in ET.fromstring(xml.stdout).iter('property')}
        required={'Restart':'s','KillMode':'s','RuntimeMaxUSec':'t','TimeoutStopUSec':'t',
            'Result':'s','ExecMainPID':'u','ExecMainCode':'i','ExecMainStatus':'i','ExecStopPost':'a(sasbttttuii)'}
        if any(properties.get(k)!=v for k,v in required.items()):
            raise ValueError('Completion service capability not proven')
        xml=subprocess.run(['/usr/bin/busctl','--system','--xml-interface','introspect',
            'org.freedesktop.systemd1',obj,'org.freedesktop.systemd1.Unit'],
            check=True,capture_output=True,text=True,timeout=5)
        properties={p.attrib['name']:p.attrib.get('type') for p in ET.fromstring(xml.stdout).iter('property')}
        if properties.get('InvocationID')!='ay': raise ValueError('InvocationID capability unavailable')
        result=subprocess.run(['/usr/bin/systemctl','show','--all',
            '--property=Restart,KillMode,RuntimeMaxUSec,TimeoutStopUSec,InvocationID,Result,ExecMainCode,ExecMainStatus,ExecStopPost',unit],
            check=True,capture_output=True,text=True,timeout=5)
        return {'unit':unit,'requiredCompletionServiceCapabilities':required,'InvocationID':'ay','properties':result.stdout}
    for unit in ('aistudy-web.service','aistudy-worker.service'):
        observe('capabilities-'+unit,lambda unit=unit:capabilities(unit))
    code=${JSON.stringify(probe)}
    # Embed actual reviewed ledger logic; no newcontrols dependency on the host.
    ledger=${JSON.stringify(ledgerTemplate)}
    # Replace entire JSON string literals, never interpolate an argument as code.
    ledger=ledger.replace(${JSON.stringify(JSON.stringify('file:///__COMPLETION_RELEASE__/packages/database/src/migrate.ts'))},json.dumps('file://'+sys.argv[4]+'/packages/database/src/migrate.ts'))
    ledger=ledger.replace(${JSON.stringify(JSON.stringify('/__COMPLETION_RELEASE__/packages/database/src/migrations'))},json.dumps(sys.argv[4]+'/packages/database/src/migrations'))
    def database():
        # Independent observations continue after incident failures; never let
        # that reporting behavior bypass the configuration trust boundary.
        m.read_trusted(sys.argv[5],private=True)
        if not payload_modules_verified:
            raise ValueError('DB probe blocked: signed module bytes not verified; report is not a pass')
        result=subprocess.run(['node','-e',code,sys.argv[5],sys.argv[4],'(async()=>{'+ledger+'})()'],
            check=True,capture_output=True,text=True,timeout=55)
        return result.stdout
    observe('database-exact110-quiet',database)
    if failures: raise failures[0]
finally:
    os.close(fd)
`;
if (process.argv[2] === '--hashes') {
  for (const name of entryNames) {
    console.log(createHash('sha256').update(readFileSync(root + name)).digest('hex'), name);
  }
  console.log(createHash('sha256').update(program).digest('hex'), 'completion-precheck.stdin.py');
} else process.stdout.write(program);
