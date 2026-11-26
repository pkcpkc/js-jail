import type { QuickJSContext, QuickJSHandle, QuickJSRuntime, QuickJSWASMModule } from 'quickjs-emscripten-core';

/**
 * The engine: QuickJS, compiled to WebAssembly, runs each script in a runtime of its own. Nothing here touches the
 * platform, so the same engine runs in Node, in a browser page and in a Web Worker (`WasmJail`, `WorkerJail`).
 *
 * A script sees only the language: no host object is ever handed in, so there is nothing to reach. Its runtime has a
 * memory limit and a stack limit, and an interrupt handler stops it at its deadline (endless loops included, in
 * getters, `toJSON` and thrown values too). Inputs go in as one JSON string per call; only strings come back.
 */

/** How the engine runs scripts; checked by the jails before it gets here. */
export interface EngineConfig {
  /** The function a script must define. */
  entry: string;
  /** When set, an object input gets the call's seeded `rand()` under this key. */
  inputRand?: string;
  /** Globals deleted from every context, after the prelude. */
  removeGlobals: string[];
  /** A call's time and a script's load time (ms). */
  callMs: number;
  loadMs: number;
  /** One script's memory (MB) and stack (KB). */
  memoryMb: number;
  stackKb: number;
  /** One answer's longest JSON. */
  maxAnswer: number;
  /** Scripts kept loaded, each with its runtime. */
  keep: number;
}

export interface EngineCall {
  input: unknown;
  seed: number;
}

/** One answer per call: the JSON the entry function answered, or why there is none. */
export type EngineResults = (string | { error: string })[];

/** The calls' answers, or why the script has none (it did not load, or defines no entry function). */
export type EngineAnswer = { results: EngineResults } | { loadError: string };

/** Why a script's runtime is gone: it ran out of memory. The jails count it against the script. */
export class EngineFailure extends Error {}

/** The script did not load or defines no entry function. */
class LoadFailure extends Error {}

/** The seeded rand (mulberry32, the same as `@js-jail/node`'s), the call wrapper, and the globals taken away. */
export function preludeSource(config: Pick<EngineConfig, 'entry' | 'inputRand'>): string {
  return [
    'let __seed = 0;',
    'globalThis.rand = () => { let a = (__seed = (__seed + 0x6d2b79f5) | 0); let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };',
    'Math.random = globalThis.rand;',
    'globalThis.__call = (json, seed) => {',
    '  try {',
    '    __seed = seed | 0;',
    '    const input = JSON.parse(json);',
    config.inputRand
      ? `    const arg = input && typeof input === "object" && !Array.isArray(input) ? Object.freeze(Object.assign(input, { ${JSON.stringify(config.inputRand)}: globalThis.rand })) : input;`
      : '    const arg = input;',
    `    const out = ${config.entry}(arg);`,
    '    return JSON.stringify(out === undefined ? null : out);',
    '  } catch (e) {',
    '    let message = "the script threw";',
    '    try { message = String(e && typeof e === "object" && "message" in e ? e.message : e); } catch {}',
    '    return JSON.stringify({ __error: message.slice(0, 300) });',
    '  }',
    '};',
  ].join('\n');
}

interface Loaded {
  code: string;
  runtime: QuickJSRuntime;
  ctx: QuickJSContext;
  call: QuickJSHandle;
}

type Outcome = { ok: true; handle: QuickJSHandle } | { ok: false; message: string };

const MEMORY = /out of memory/i;
const OUT_OF_MEMORY = JSON.stringify({ __error: 'out of memory' });

export class QuickEngine {
  /** Loaded scripts by their code (not a hash: two scripts never share a runtime), the last used last. */
  private readonly loaded = new Map<string, Loaded>();
  private deadline = 0;
  private interrupted = false;
  private readonly prelude: string;

  constructor(
    private readonly quickjs: QuickJSWASMModule,
    private readonly config: EngineConfig
  ) {
    this.prelude = preludeSource(config);
  }

  /** Calls the script's entry function once per call. Throws `EngineFailure` when the script ran out of memory. */
  answer(code: string, calls: EngineCall[]): EngineAnswer {
    let script: Loaded;
    try {
      script = this.load(code);
    } catch (err) {
      // Only the script's own failure to load is its answer; anything else (a trap) goes up
      if (err instanceof LoadFailure) return { loadError: err.message };
      throw err;
    }
    const { entry, callMs, maxAnswer } = this.config;
    const results: EngineResults = calls.map((c) => {
      const json = script.ctx.newString(JSON.stringify(c.input === undefined ? null : c.input) ?? 'null');
      const seed = script.ctx.newNumber(c.seed | 0);
      const outcome = this.within(script.ctx, callMs, () => script.ctx.callFunction(script.call, script.ctx.undefined, json, seed));
      json.dispose();
      seed.dispose();
      if (!outcome.ok) {
        if (MEMORY.test(outcome.message)) {
          this.drop(code);
          throw new EngineFailure('The script used too much memory');
        }
        return { error: this.interrupted ? `${entry}() took longer than ${callMs} ms` : outcome.message || `${entry}() threw` };
      }
      const out = script.ctx.typeof(outcome.handle) === 'string' ? script.ctx.getString(outcome.handle) : undefined;
      outcome.handle.dispose();
      if (out === undefined) return { error: `${entry}() gave no answer` };
      // The wrapper caught it, but the runtime is full: start the script afresh next time
      if (out === OUT_OF_MEMORY) {
        this.drop(code);
        throw new EngineFailure('The script used too much memory');
      }
      if (out.length > maxAnswer) return { error: `${entry}() answered more than ${maxAnswer} characters` };
      return out;
    });
    return { results };
  }

  /** Frees every runtime. Not after a trap: the module is broken then, and is dropped whole. */
  dispose(): void {
    for (const code of [...this.loaded.keys()]) this.drop(code);
  }

  private load(code: string): Loaded {
    const known = this.loaded.get(code);
    if (known) {
      this.loaded.delete(code);
      this.loaded.set(code, known);
      return known;
    }
    const { entry, removeGlobals, callMs, loadMs, memoryMb, stackKb, keep } = this.config;
    const runtime = this.quickjs.newRuntime();
    runtime.setMemoryLimit(memoryMb * 1024 * 1024);
    runtime.setMaxStackSize(stackKb * 1024);
    runtime.setInterruptHandler(() => {
      if (Date.now() <= this.deadline) return false;
      this.interrupted = true;
      return true;
    });
    // No clock in the language itself; the other globals go after the prelude, which needs none of them
    const ctx = runtime.newContext({ intrinsics: { BaseObjects: true, Date: false, Eval: true, StringNormalize: true, RegExp: true, JSON: true, Proxy: true, MapSet: true, TypedArrays: true, Promise: true } });
    const fail = (message: string): never => {
      ctx.dispose();
      runtime.dispose();
      throw MEMORY.test(message) ? new EngineFailure('The script used too much memory') : new LoadFailure(message);
    };
    const run = (source: string, ms: number, filename: string, timeout: string) => {
      const outcome = this.within(ctx, ms, () => ctx.evalCode(source, filename));
      if (!outcome.ok) fail(this.interrupted ? timeout : outcome.message || 'The script threw while it loaded');
      return (outcome as { handle: QuickJSHandle }).handle;
    };
    run(this.prelude, callMs, 'prelude.js', 'The prelude timed out').dispose();
    run(`for (const k of ${JSON.stringify(removeGlobals)}) delete globalThis[k];`, callMs, 'globals.js', 'Removing the globals timed out').dispose();
    run(code, loadMs, 'script.js', `The script timed out after ${loadMs} ms while it loaded`).dispose();
    const kind = run(`typeof ${entry}`, callMs, 'entry.js', 'The script timed out');
    const isFunction = ctx.typeof(kind) === 'string' && ctx.getString(kind) === 'function';
    kind.dispose();
    if (!isFunction) fail(`The script must define function ${entry}()`);
    const script = { code, runtime, ctx, call: ctx.getProp(ctx.global, '__call') };
    this.loaded.set(code, script);
    if (this.loaded.size > keep) this.drop(this.loaded.keys().next().value as string);
    return script;
  }

  /** Runs `work` in `ctx` until `ms` from now; a thrown value's message is read inside the same deadline. */
  private within(ctx: QuickJSContext, ms: number, work: () => ReturnType<QuickJSContext['evalCode']>): Outcome {
    this.deadline = Date.now() + ms;
    this.interrupted = false;
    const result = work();
    if (!result.error) return { ok: true, handle: result.value };
    let message = '';
    try {
      // The thrown value may be the script's own (a getter, a Proxy): read only a string message, still on the clock
      const m = ctx.getProp(result.error, 'message');
      if (ctx.typeof(m) === 'string') message = ctx.getString(m).slice(0, 300);
      m.dispose();
    } catch {
      message = '';
    }
    result.error.dispose();
    return { ok: false, message };
  }

  private drop(code: string): void {
    const script = this.loaded.get(code);
    if (!script) return;
    this.loaded.delete(code);
    script.call.dispose();
    script.ctx.dispose();
    script.runtime.dispose();
  }
}
