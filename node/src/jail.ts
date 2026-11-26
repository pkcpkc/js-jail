import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hasSeatbelt, jailCommand } from './seatbelt.js';
import { workerSource } from './worker.js';

/** One call of a script's entry function: its input (JSON-able) and the seed of its `rand()`. */
export interface JailCall {
  input: unknown;
  seed?: number;
}

/** What a call answered (its JSON, parsed), or why it has no answer. */
export type JailResult = { value: unknown } | { error: string };

export interface JsJailOptions {
  /** The function a script must define, called once per call with its input. Default `main`. */
  entry?: string;
  /** When set, an object input gets the call's seeded `rand()` under this key. */
  inputRand?: string;
  /** Layer 3, the OS sandbox: on by default where the machine has it (macOS). */
  seatbelt?: boolean;
  /** Globals deleted from every context (default: the clock, WebAssembly, shared memory, weak references). */
  removeGlobals?: string[];
  /** A call's time, a script's load time (ms), the worker's heap (MB), one answer's longest JSON. */
  callMs?: number;
  loadMs?: number;
  heapMb?: number;
  maxAnswer?: number;
  /** A request's time: `requestBaseMs` and `perCallMs` per call, at most `requestMaxMs`; then the worker is killed. */
  requestBaseMs?: number;
  perCallMs?: number;
  requestMaxMs?: number;
  /** After this many failed requests (timeout, crash) a script is refused. */
  maxFailures?: number;
  /** Told what went wrong with the worker (a timeout, a crash). */
  onWarn?: (message: string) => void;
}

const DEFAULTS = {
  entry: 'main',
  removeGlobals: ['Date', 'WebAssembly', 'SharedArrayBuffer', 'Atomics', 'WeakRef', 'FinalizationRegistry'],
  callMs: 50,
  loadMs: 200,
  heapMb: 64,
  maxAnswer: 65536,
  requestBaseMs: 1500,
  perCallMs: 60,
  requestMaxMs: 8000,
  maxFailures: 3,
};

/** At most this many calls go in one request to the worker. */
const MAX_CALLS = 400;
/** A worker that is not ready this long after its start is killed (a cold start under load, the sandbox's setup). */
const START_MS = 15000;
/** A worker answer longer than this kills it. */
const MAX_LINE = 8 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** The script did not load or defines no entry function: its own answer, not the worker's failure. */
export class ScriptError extends Error {}

/** The hash a script is kept and counted by. */
export const scriptHash = (code: string): string => createHash('sha256').update(code).digest('hex').slice(0, 32);

interface Pending {
  id: number;
  resolve: (results: unknown[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs code it does not trust (`README.md`). Three layers each hold on their own:
 *
 * 1. **The context** (`worker.ts`): a fresh `vm` context per script, nothing of Node in it, no code from strings, no
 *    clock, `callMs` per call; only strings cross back.
 * 2. **The process**: one long-lived `node` child with Node's permission model and nothing allowed (no files, network,
 *    child processes, workers, addons, WASI), no code from strings even outside the context, `heapMb` of heap, an empty
 *    environment and an empty folder to stand in. Its source comes with `-e`, so it reads no file.
 * 3. **The OS** (macOS seatbelt): no network, no writes, no new processes, no reading the user's files or the Keychain.
 *
 * One request at a time; the child is killed when one takes too long or answers too much (it starts again with the
 * next), and a script is refused after `maxFailures` failed requests. Answers are parsed JSON: still untrusted data.
 */
export class JsJail {
  private child: ChildProcessWithoutNullStreams | null = null;
  /** The running worker, once it said it is ready. */
  private ready: Promise<ChildProcessWithoutNullStreams> | null = null;
  private onReady: (() => void) | null = null;
  private cwd: string | null = null;
  private buffer = '';
  private pending: Pending | null = null;
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly failures = new Map<string, number>();
  private readonly options: Required<Omit<JsJailOptions, 'inputRand' | 'onWarn' | 'seatbelt'>> & Pick<JsJailOptions, 'inputRand' | 'onWarn'>;
  private readonly source: string;
  readonly seatbelt: boolean;

  constructor(options: JsJailOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
    const { entry, inputRand } = this.options;
    if (!IDENTIFIER.test(entry)) throw new Error(`The entry must be an identifier, not "${entry}"`);
    if (inputRand !== undefined && !IDENTIFIER.test(inputRand)) throw new Error(`inputRand must be an identifier, not "${inputRand}"`);
    this.seatbelt = options.seatbelt ?? hasSeatbelt();
    const { callMs, loadMs, maxAnswer, removeGlobals } = this.options;
    this.source = workerSource({ entry, ...(inputRand ? { inputRand } : {}), removeGlobals, callMs, loadMs, maxAnswer, keep: 32 });
  }

  /** Calls the script's entry function once per call: each answer, or why there is none (all of them when the script failed). */
  async run(code: string, calls: JailCall[]): Promise<JailResult[]> {
    const hash = scriptHash(code);
    const { maxFailures, entry } = this.options;
    if ((this.failures.get(hash) ?? 0) >= maxFailures) return calls.map(() => ({ error: 'This script failed too often and is not run again' }));
    const raw: unknown[] = [];
    try {
      for (let i = 0; i < calls.length; i += MAX_CALLS) raw.push(...(await this.request(hash, code, calls.slice(i, i + MAX_CALLS))));
    } catch (err) {
      // A timeout or a crash counts against the script; one that does not load is only its own answer
      if (!(err instanceof ScriptError)) this.failures.set(hash, (this.failures.get(hash) ?? 0) + 1);
      return calls.map(() => ({ error: (err as Error).message }));
    }
    return raw.map((answer): JailResult => {
      if (answer && typeof answer === 'object' && 'error' in answer) return { error: String((answer as { error: unknown }).error) };
      if (typeof answer !== 'string') return { error: `${entry}() gave no answer` };
      let value: unknown;
      try {
        value = JSON.parse(answer);
      } catch {
        return { error: `${entry}() answered something that is not JSON` };
      }
      if (value && typeof value === 'object' && !Array.isArray(value) && '__error' in value) return { error: `${entry}() threw: ${String((value as { __error: unknown }).__error)}` };
      return { value };
    });
  }

  /** Stops the worker and removes its folder (shut down; tests). */
  stop(): void {
    this.kill('stopped');
    if (this.cwd) fs.rmSync(this.cwd, { recursive: true, force: true });
    this.cwd = null;
  }

  private request(hash: string, code: string, calls: JailCall[]): Promise<unknown[]> {
    const run = this.queue.then(() => this.send(hash, code, calls));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(hash: string, code: string, calls: JailCall[]): Promise<unknown[]> {
    const child = await this.start();
    const id = this.nextId++;
    const { requestBaseMs, perCallMs, requestMaxMs } = this.options;
    return new Promise<unknown[]>((resolve, reject) => {
      const ms = Math.min(requestMaxMs, requestBaseMs + calls.length * perCallMs);
      const timer = setTimeout(() => {
        this.options.onWarn?.(`script ${hash.slice(0, 8)} took longer than ${ms} ms: the worker is stopped`);
        this.kill(`The script took longer than ${ms} ms`);
      }, ms);
      this.pending = { id, resolve, reject, timer };
      child.stdin.write(`${JSON.stringify({ id, hash, code, calls: calls.map((c) => ({ input: c.input, seed: c.seed ?? 0 })) })}\n`);
    });
  }

  /** The worker, started in the jail when none runs, once it is ready. */
  private start(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child && this.ready) return this.ready;
    this.cwd ??= fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'js-jail-')));
    const { command, args } = jailCommand(this.source, this.cwd, this.seatbelt, this.options.heapMb);
    const child = spawn(command, args, { cwd: this.cwd, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.buffer = '';
    this.ready = new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.options.onWarn?.(`the worker was not ready after ${START_MS} ms`);
        reject(new Error('The worker did not start'));
        this.kill('The worker did not start');
      }, START_MS);
      this.onReady = () => {
        clearTimeout(timer);
        resolve(child);
      };
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('The worker stopped before it was ready'));
      });
    });
    // Its rejection is the request's; nobody else waits on it
    this.ready.catch(() => undefined);
    let stderr = '';
    let outOfMemory = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > MAX_LINE) return this.kill('The script answered too much');
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        this.onAnswer(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      outOfMemory ||= /heap out of memory|Allocation failed/i.test(chunk);
      // Its first lines say why (a crash's native stack follows)
      if (stderr.length < 2000) stderr = (stderr + chunk).slice(0, 2000);
    });
    child.stdin.on('error', () => undefined);
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      const why = outOfMemory ? 'The script used too much memory' : `The worker stopped (${signal ?? `exit ${code}`})`;
      if (this.pending) this.options.onWarn?.(`${why}: ${stderr.trim().split('\n').filter(Boolean).slice(0, 2).join(' | ')}`);
      this.fail(why);
    });
    child.on('error', (err) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      this.options.onWarn?.(`the worker could not start: ${err.message}`);
      this.fail(`The worker could not start: ${err.message}`);
    });
    return this.ready;
  }

  private onAnswer(line: string): void {
    let answer: { id?: number; results?: unknown[]; error?: unknown; ready?: unknown };
    try {
      answer = JSON.parse(line);
    } catch {
      return this.kill('The worker answered nonsense');
    }
    if (answer.ready === true) {
      this.onReady?.();
      this.onReady = null;
      return;
    }
    const pending = this.pending;
    if (!pending) return;
    if (answer.id !== pending.id) return;
    clearTimeout(pending.timer);
    this.pending = null;
    if (typeof answer.error === 'string') return pending.reject(new ScriptError(answer.error));
    pending.resolve(Array.isArray(answer.results) ? answer.results : []);
  }

  private fail(why: string): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reject(new Error(why));
  }

  private kill(why: string): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    child?.kill('SIGKILL');
    this.fail(why);
  }
}
