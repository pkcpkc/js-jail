import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import variant from '#variant';
import { ENGINE_DEFAULTS, Failures, REFUSED, engineConfig, toResults, type EngineOptions, type JailCall, type JailResult } from './common.js';
import { EngineFailure, QuickEngine, type EngineConfig } from './engine.js';

/** A fresh QuickJS module (its own WebAssembly memory), from the variant for this platform. */
export const loadQuickJS = (): Promise<QuickJSWASMModule> => newQuickJSWASMModuleFromVariant(variant);

export interface WasmJailOptions extends EngineOptions {
  /** A request's longest time (ms), all its calls together; then the rest fail and it counts against the script. */
  requestMaxMs?: number;
  /** Where the QuickJS module comes from (default: `loadQuickJS`). */
  load?: () => Promise<QuickJSWASMModule>;
}

/**
 * Runs code it does not trust in QuickJS-in-WebAssembly, in this thread: in Node, in a browser page or inside a Web
 * Worker. A call can't run past its time (the interrupt handler stops it), but it does run on this thread: in a page,
 * prefer `WorkerJail`, which keeps the page responsive and can terminate a worker as a last resort.
 *
 * A script that runs out of memory loses its runtime and counts as a failure; after `maxFailures` it is refused. A
 * WebAssembly trap drops the whole module, and the next request loads a fresh one. Answers are parsed JSON: still
 * untrusted data.
 */
export class WasmJail {
  private engine: Promise<QuickEngine> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly config: EngineConfig;
  private readonly failures: Failures;
  private readonly requestMaxMs: number;
  private readonly load: () => Promise<QuickJSWASMModule>;
  private readonly onWarn?: (message: string) => void;

  constructor(options: WasmJailOptions = {}) {
    this.config = engineConfig(options);
    this.failures = new Failures(options.maxFailures ?? ENGINE_DEFAULTS.maxFailures);
    this.requestMaxMs = options.requestMaxMs ?? 8000;
    this.load = options.load ?? loadQuickJS;
    this.onWarn = options.onWarn;
  }

  /** Calls the script's entry function once per call: each answer, or why there is none (all of them when the script failed). */
  run(code: string, calls: JailCall[]): Promise<JailResult[]> {
    // One request at a time, so stop() never frees an engine a request is about to use
    const run = this.queue.then(() => this.request(code, calls));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async request(code: string, calls: JailCall[]): Promise<JailResult[]> {
    if (this.failures.refused(code)) return calls.map(() => ({ error: REFUSED }));
    const engine = await this.start();
    const started = Date.now();
    const raw: JailResult[] = [];
    try {
      for (const [i, call] of calls.entries()) {
        if (Date.now() - started > this.requestMaxMs) {
          this.failures.add(code);
          this.onWarn?.(`a script took longer than ${this.requestMaxMs} ms`);
          return [...raw, ...calls.slice(i).map(() => ({ error: `The script took longer than ${this.requestMaxMs} ms` }))];
        }
        const answer = engine.answer(code, [{ input: call.input, seed: call.seed ?? 0 }]);
        if ('loadError' in answer) return calls.map(() => ({ error: answer.loadError }));
        raw.push(...toResults(answer.results, this.config.entry));
      }
      return raw;
    } catch (err) {
      this.failures.add(code);
      if (!(err instanceof EngineFailure)) {
        // A trap in the WebAssembly itself: the module may be broken, so the next request gets a fresh one
        this.onWarn?.(`the QuickJS module failed: ${(err as Error).message}`);
        this.engine = null;
      }
      const why = err instanceof EngineFailure ? err.message : 'The script crashed the engine';
      return calls.map(() => ({ error: why }));
    }
  }

  /** Frees the engine (it loads again on the next request). */
  stop(): void {
    const engine = this.engine;
    this.engine = null;
    engine?.then((e) => e.dispose()).catch(() => undefined);
  }

  private start(): Promise<QuickEngine> {
    if (!this.engine) {
      const loading = this.load().then((module) => new QuickEngine(module, this.config));
      loading.catch(() => {
        if (this.engine === loading) this.engine = null;
      });
      this.engine = loading;
    }
    return this.engine;
  }
}
