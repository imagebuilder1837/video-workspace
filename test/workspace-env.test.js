import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entry = fileURLToPath(new URL('../bin/workspace-env', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'video workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'projects', 'a project');
  const bin = join(root, 'node_modules', '.bin');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, 'bin'));
  const run = join(root, 'bin', 'workspace-env');
  copyFileSync(entry, run);
  chmodSync(run, 0o755);
  return { root, cwd, bin, run };
}

test('preserves project cwd, literal arguments and streams when selecting an installed tool', (t) => {
  const f = fixture(t);
  const installed = join(f.bin, 'hyperframes');
  writeFileSync(installed, '#!/bin/sh\nprintf \'%s\\n\' "$PWD" "$@"\ncat\nprintf \'diagnostic\\n\' >&2\n');
  chmodSync(installed, 0o755);
  const result = spawnSync(f.run, ['hyperframes', 'a b', '', '$(echo injected);*', '--flag=value'], {
    cwd: f.cwd, encoding: 'utf8', input: 'input data\n',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${f.cwd}\na b\n\n$(echo injected);*\n--flag=value\ninput data\n`);
  assert.equal(result.stderr, 'diagnostic\n');
});

test('supplies the same scoped environment to direct scripts and their children without changing HOME', (t) => {
  const f = fixture(t);
  const keys = ['HYPERFRAMES_MEDIA_HOME', 'HYPERFRAMES_BROWSER_PATH', 'CHROME',
    'HYPERFRAMES_NO_TELEMETRY', 'DO_NOT_TRACK', 'HYPERFRAMES_NO_UPDATE_CHECK', 'HYPERFRAMES_SKIP_SKILLS', 'HOME'];
  const env = { ...process.env, HOME: join(f.root, 'home') };
  for (const key of keys.slice(0, -1)) env[key] = 'inherited value';
  const probe = `const keys = ${JSON.stringify(keys)}; console.log(JSON.stringify(Object.fromEntries(keys.map(k => [k, process.env[k]]))));`;
  const child = `const {spawnSync} = require('node:child_process'); const r = spawnSync(process.execPath, ['-e', ${JSON.stringify(probe)}], {stdio: 'inherit'}); process.exit(r.status);`;
  for (const code of [probe, child]) {
    const result = spawnSync(f.run, [process.execPath, '-e', code], { cwd: f.cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      HYPERFRAMES_MEDIA_HOME: f.root, HYPERFRAMES_BROWSER_PATH: '/usr/bin/chromium', CHROME: '/usr/bin/chromium',
      HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1', HYPERFRAMES_SKIP_SKILLS: '1', HOME: env.HOME,
    });
  }
  const unwrapped = spawnSync(process.execPath, ['-e', probe], { env, encoding: 'utf8' });
  assert.equal(JSON.parse(unwrapped.stdout).HYPERFRAMES_MEDIA_HOME, 'inherited value');
});

test('preserves command failure and signal termination', (t) => {
  const f = fixture(t);
  assert.equal(spawnSync(f.run, [process.execPath, '-e', 'process.exit(23)']).status, 23);
  const killed = spawnSync(f.run, [process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')"]);
  assert.equal(killed.signal, 'SIGTERM');
});

test('reports missing commands without invoking an installer, and requires a command', (t) => {
  const f = fixture(t);
  const installed = join(f.root, 'unexpected-install');
  for (const command of ['npx', 'npm']) {
    const path = join(f.bin, command);
    writeFileSync(path, '#!/bin/sh\n: > "$INSTALL_MARKER"\nexit 99\n');
    chmodSync(path, 0o755);
  }
  const missing = spawnSync(f.run, ['missing-video-workspace-command'], {
    env: { ...process.env, INSTALL_MARKER: installed }, encoding: 'utf8',
  });
  assert.equal(missing.status, 127);
  assert.equal(existsSync(installed), false);
  const empty = spawnSync(f.run, [], { encoding: 'utf8' });
  assert.equal(empty.status, 64);
  assert.match(empty.stderr, /Usage:/);
});
