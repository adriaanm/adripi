import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'arm64');
assert.match(process.version, /^v24\./);
const base = '/tmp/adripi-verification';
// A rerun needs a fresh VM: never truncate a previous run's evidence.
mkdirSync(base);
const source = join(base, 'source');
const output = join(base, 'output');
const home = join(base, 'home');
for (const dir of [source, output, home, join(base, 'agent')]) mkdirSync(dir, { recursive: true });
const env = {
  PATH: `${dirname(process.execPath)}:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin`,
  HOME: home, XDG_CONFIG_HOME: join(home, '.config'), TMPDIR: '/tmp', LANG: 'C.UTF-8', CI: '1', TERM: 'dumb',
  PI_CODING_AGENT_DIR: join(base, 'agent'), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
  npm_config_cache: join(base, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false',
};
const steps = [];
const sha = data => createHash('sha256').update(data).digest('hex');
const archive = readFileSync('/input/source.tar');
const evidence = { node: process.version, executable: process.execPath, platform: process.platform, architecture: process.arch,
  snapshot: JSON.parse(readFileSync('/input/snapshot.json', 'utf8')), archiveSha256: sha(archive), steps };
function save() { writeFileSync(join(output, 'results.json'), JSON.stringify(evidence, null, 2)); }
async function run(name, command, args, cwd = source) {
  const log = join(output, `${name}.log`);
  const fd = openSync(log, 'wx', 0o600);
  const start = Date.now();
  console.log(`START ${name}: ${JSON.stringify([command, ...args])}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300000);
  let code = null, signal = null, error;
  try {
    await new Promise(resolve => {
      const child = spawn(command, args, { cwd, env, stdio: ['ignore', fd, fd], signal: controller.signal });
      child.on('error', e => { error = String(e); });
      child.on('close', (status, stopped) => { code = status; signal = stopped; resolve(); });
    });
  } finally { clearTimeout(timer); closeSync(fd); }
  const passed = code === 0 && signal === null && error === undefined;
  const result = { name, command, args, code, signal, error, passed, elapsedMs: Date.now() - start, log };
  steps.push(result); save();
  console.log(`END ${name}: code=${code} signal=${signal} elapsed=${result.elapsedMs}ms`);
  if (!passed) console.log(readFileSync(log, 'utf8').slice(-16000));
  return passed;
}
try {
  save();
  assert.equal(sha(archive), evidence.snapshot.archiveSha256);
  assert.equal(spawnSync('node', ['-p', 'process.execPath'], { env, encoding: 'utf8' }).stdout.trim(), realpathSync(process.execPath));
  assert.equal(spawnSync('node', ['--version'], { env, encoding: 'utf8' }).stdout.trim(), process.version);
  if (!await run('extract', 'tar', ['-xf', '/input/source.tar', '-C', source], base)) throw new Error('extract failed');
  const locked = ['forks/pi-guardian/package.json', 'forks/pi-guardian/pnpm-lock.yaml', 'forks/pi-sbx/package.json', 'forks/pi-sbx/pnpm-lock.yaml', 'forks/pi-sbx/package-lock.json', 'forks/pi-subagents/package.json', 'forks/pi-subagents/package-lock.json'];
  evidence.lockedInputs = Object.fromEntries(locked.map(file => [file, sha(readFileSync(join(source, file)))])); save();
  if (!await run('package-manager', 'npm', ['install', '--prefix', join(base, 'tooling'), '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund', 'pnpm@12.15.0'])) throw new Error('tooling failed');
  const pnpm = join(base, 'tooling/node_modules/.bin/pnpm');
  if (!await run('guardian-install', pnpm, ['install', '--frozen-lockfile', '--ignore-scripts', '--reporter', 'append-only'], join(source, 'forks/pi-guardian'))) throw new Error('guardian dependency setup failed');
  if (!await run('pi-sbx-install', pnpm, ['install', '--frozen-lockfile', '--ignore-scripts', '--reporter', 'append-only'], join(source, 'forks/pi-sbx'))) throw new Error('pi-sbx dependency setup failed');
  if (!await run('pi-subagents-install', 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], join(source, 'forks/pi-subagents'))) throw new Error('pi-subagents dependency setup failed');
  for (const file of locked) assert.equal(sha(readFileSync(join(source, file))), evidence.lockedInputs[file], `locked input changed: ${file}`);
  evidence.sdks = Object.fromEntries(['pi-guardian', 'pi-sbx', 'pi-subagents'].map(fork => [fork,
    JSON.parse(readFileSync(join(source, 'forks', fork, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8')).version])); save();
  const cwd = join(source, 'forks/pi-guardian');
  await run('headless', process.execPath, ['--test', 'test/headless.test.ts'], cwd);
  const files = readdirSync(join(cwd, 'test')).filter(file => file.endsWith('.test.ts')).sort().map(file => `test/${file}`);
  await run('guardian-full', process.execPath, ['--test', ...files], cwd);
  await run('guardian-types', 'npm', ['run', 'check'], cwd);
  await run('sbx-types', 'npm', ['exec', '--', 'tsc', '--noEmit'], join(source, 'forks/pi-sbx'));
  for (const file of locked) assert.equal(sha(readFileSync(join(source, file))), evidence.lockedInputs[file], `locked input changed after tests: ${file}`);
  evidence.success = steps.every(step => step.passed); save();
  process.exitCode = evidence.success ? 0 : 1;
} catch (error) {
  evidence.success = false; evidence.error = String(error); save(); console.error(error); process.exitCode = 1;
}
console.log(`RESULTS ${join(output, 'results.json')}`);
