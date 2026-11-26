import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NODE_FLAGS, SANDBOX_EXEC, hasSeatbelt, jailCommand, nodeFlags, seatbeltProfile } from '../src/seatbelt.ts';

/**
 * The outer layers (`src/seatbelt.ts`) alone: a probe with all of Node, as if it had got out of the vm context, run with
 * layer 2, layer 3, or neither.
 */

/** Tries what a script out of the vm context would: read, write, connect, start a program, read the environment. */
const PROBE = `
const fs = require('node:fs');
const out = {};
const t = (k, f) => { try { f(); out[k] = 'ALLOWED'; } catch (e) { out[k] = e.code || e.message; } };
t('readHome', () => fs.readdirSync(require('node:os').homedir()));
t('readEtc', () => fs.readFileSync('/etc/hosts'));
t('write', () => fs.writeFileSync('probe.txt', 'x'));
t('spawn', () => require('node:child_process').execFileSync('/bin/echo', ['hi']));
// macOS gives every process __CF_USER_TEXT_ENCODING; nothing of the parent's environment (no keys) reaches it
t('env', () => { if (Object.keys(process.env).some((k) => k !== '__CF_USER_TEXT_ENCODING')) throw new Error('has env'); });
const s = require('node:net').connect({ host: '127.0.0.1', port: 9 });
s.on('error', (e) => { out.net = e.code || e.message; console.log(JSON.stringify(out)); });
s.on('connect', () => { out.net = 'ALLOWED'; console.log(JSON.stringify(out)); s.destroy(); });
`;

function runProbe(cwd: string, seatbelt: boolean, flags: boolean, env: NodeJS.ProcessEnv = {}): Record<string, string> {
  const { command, args } = jailCommand(PROBE, cwd, seatbelt);
  // Without layer 2: the same command, the permission flags taken out
  const used = flags ? args : args.filter((a) => !NODE_FLAGS.includes(a));
  const res = spawnSync(command, used, { cwd, env, encoding: 'utf8', timeout: 20000 });
  try {
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '');
  } catch {
    throw new Error(`The probe answered nothing: ${res.stderr}`);
  }
}

describe('the jail, layer by layer', () => {
  let cwd: string;
  beforeAll(() => {
    cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'js-jail-probe-')));
  });
  afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));

  it('layer 2, the Node permission model alone, denies files, programs and the network', () => {
    expect(runProbe(cwd, false, true)).toEqual({ readHome: 'ERR_ACCESS_DENIED', readEtc: 'ERR_ACCESS_DENIED', write: 'ERR_ACCESS_DENIED', spawn: 'ERR_ACCESS_DENIED', env: 'ALLOWED', net: 'ERR_ACCESS_DENIED' });
  });

  it.runIf(hasSeatbelt())('layer 3, the macOS sandbox alone (no Node permissions), denies them too', () => {
    expect(runProbe(cwd, true, false)).toEqual({ readHome: 'EPERM', readEtc: 'EPERM', write: 'EPERM', spawn: 'EPERM', env: 'ALLOWED', net: 'EPERM' });
  });

  it('without either, the same probe can do it all: the layers are what stop it', () => {
    const out = runProbe(cwd, false, false, { HOME: os.homedir() });
    expect(out).toMatchObject({ readHome: 'ALLOWED', readEtc: 'ALLOWED', write: 'ALLOWED', spawn: 'ALLOWED' });
    expect(fs.existsSync(path.join(cwd, 'probe.txt'))).toBe(true);
  });

  it('allows the sandboxed child only its own empty folder and Node itself', () => {
    const profile = seatbeltProfile('/opt/node/bin/node', '/private/var/folders/x/empty');
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain('(deny process-exec)');
    expect(profile).toContain('(allow process-exec (literal "/opt/node/bin/node"))');
    expect(profile).toContain('(allow file-read* (literal "/private/var/folders/x/empty"))');
    expect(seatbeltProfile('/n', '/a"b')).toContain('(literal "/a\\"b")');
  });

  it('builds layer 2 from the heap size, and starts the script with -e, inside sandbox-exec when asked', () => {
    expect(nodeFlags(32)).toEqual(['--permission', '--disallow-code-generation-from-strings', '--max-old-space-size=32', '--max-semi-space-size=2', '--no-warnings']);
    expect(NODE_FLAGS).toEqual(nodeFlags(64));
    const plain = jailCommand('1', '/tmp/x', false, 16);
    expect(plain.command).toBe(fs.realpathSync(process.execPath));
    expect(plain.args).toEqual([...nodeFlags(16), '-e', '1']);
    const boxed = jailCommand('1', '/tmp/x', true);
    expect(boxed.command).toBe(SANDBOX_EXEC);
    expect(boxed.args.slice(0, 2)).toEqual(['-p', seatbeltProfile(plain.command, '/tmp/x')]);
    expect(boxed.args.slice(2)).toEqual([plain.command, ...NODE_FLAGS, '-e', '1']);
  });
});
