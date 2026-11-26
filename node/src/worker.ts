/**
 * The jail's worker, as the source `node -e` runs: no file of it is read, so the jail allows no file at all. It answers
 * JSON lines on stdin with JSON lines on stdout, one request at a time, after a first `{ ready: true }`:
 *
 *   in:  { id, hash, code, calls: [{ input, seed }] }
 *   out: { id, results: [string | { error }] }   (each string the JSON the entry function answered, at most maxAnswer long)
 *        { id, error }                             (the script did not load, or defines no entry function)
 *
 * Layer 1 of the jail (the process flags and the OS sandbox are layers 2 and 3): each script gets a fresh `vm` context
 * with nothing of Node in it, no code from strings (eval, Function), no WebAssembly, no clock or other `removeGlobals`,
 * and its microtasks inside the call's timeout. The input goes in as a string literal of the call itself (nothing is set
 * on the context), and everything the script's values can run (getters, toJSON, toString) runs inside that context and
 * its timeout: only strings cross back. A thrown value is never touched outside the context, but for an own data
 * property of a native error.
 */

/** What the worker is built with (`workerSource()`), checked by `JsJail`. */
export interface WorkerConfig {
  /** The name of the function a script must define. */
  entry: string;
  /** When set, an object input gets the call's seeded `rand()` under this key (it is also `Math.random` and global `rand`). */
  inputRand?: string;
  /** Globals deleted from every context. */
  removeGlobals: string[];
  callMs: number;
  loadMs: number;
  maxAnswer: number;
  /** Scripts kept compiled, by hash. */
  keep: number;
}

/** The worker's source for `config`: the config goes in as JSON, the entry and the rand key as checked identifiers. */
export function workerSource(config: WorkerConfig): string {
  return `'use strict';\nconst CONFIG = ${JSON.stringify(config)};\n${WORKER_BODY}`;
}

const WORKER_BODY = String.raw`
const vm = require('node:vm');
const readline = require('node:readline');
const { isNativeError } = require('node:util').types;

// What a script gets besides its own code: the call wrapper and a seeded rand (also as Math.random)
const PRELUDE = [
  'for (const k of ' + JSON.stringify(CONFIG.removeGlobals) + ') delete globalThis[k];',
  'let rand = () => 0;',
  'const __call = (json, seed) => {',
  '  try {',
  '    let a = seed >>> 0;',
  '    rand = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };',
  '    Math.random = rand;',
  '    const input = JSON.parse(json);',
  CONFIG.inputRand
    ? '    const arg = input && typeof input === "object" && !Array.isArray(input) ? Object.freeze(Object.assign(input, { ' + JSON.stringify(CONFIG.inputRand) + ': rand })) : input;'
    : '    const arg = input;',
  '    const out = ' + CONFIG.entry + '(arg);',
  '    return JSON.stringify(out === undefined ? null : out);',
  '  } catch (e) {',
  '    let message = "the script threw";',
  '    try { message = String(e && typeof e === "object" && "message" in e ? e.message : e); } catch {}',
  '    return JSON.stringify({ __error: message.slice(0, 300) });',
  '  }',
  '};',
].join('\n');

const compiled = new Map();

// A thrown value may be the script's own (a Proxy, a getter): read only an own data property of a native error, never call it
function messageOf(e, key = 'message') {
  try {
    if (!isNativeError(e)) return '';
    const d = Object.getOwnPropertyDescriptor(e, key);
    return d && typeof d.value === 'string' ? d.value.slice(0, 300) : '';
  } catch {
    return '';
  }
}

function compile(hash, code) {
  const known = compiled.get(hash);
  if (known) {
    compiled.delete(hash);
    compiled.set(hash, known);
    return known;
  }
  const ctx = vm.createContext(Object.create(null), { name: 'jail', codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  vm.runInContext(PRELUDE, ctx, { timeout: CONFIG.callMs });
  new vm.Script(code, { filename: 'script.js' }).runInContext(ctx, { timeout: CONFIG.loadMs });
  if (vm.runInContext('typeof ' + CONFIG.entry, ctx, { timeout: CONFIG.callMs }) !== 'function') throw new Error('The script must define function ' + CONFIG.entry + '()');
  const entry = { ctx };
  compiled.set(hash, entry);
  if (compiled.size > CONFIG.keep) compiled.delete(compiled.keys().next().value);
  return entry;
}

function answer(req) {
  let entry;
  try {
    entry = compile(String(req.hash), String(req.code));
  } catch (e) {
    return { id: req.id, error: messageOf(e) || 'The script threw while it loaded' };
  }
  const results = req.calls.map((c) => {
    try {
      const json = JSON.stringify(c.input === undefined ? null : c.input);
      const out = new vm.Script('__call(' + JSON.stringify(json) + ', ' + (c.seed >>> 0) + ')', { filename: 'call.js' }).runInContext(entry.ctx, { timeout: CONFIG.callMs });
      if (typeof out !== 'string') return { error: CONFIG.entry + '() gave no answer' };
      if (out.length > CONFIG.maxAnswer) return { error: CONFIG.entry + '() answered more than ' + CONFIG.maxAnswer + ' characters' };
      return out;
    } catch (e) {
      return { error: messageOf(e, 'code') === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? CONFIG.entry + '() took longer than ' + CONFIG.callMs + ' ms' : messageOf(e) || CONFIG.entry + '() threw' };
    }
  });
  return { id: req.id, results };
}

// Ready: the parent starts a request's clock from here, not from the process start
process.stdout.write('{"ready":true}\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  process.stdout.write(JSON.stringify(answer(req)) + '\n');
});
`;
