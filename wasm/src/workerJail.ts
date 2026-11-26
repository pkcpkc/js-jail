import { ENGINE_DEFAULTS, Failures, REFUSED, engineConfig, toResults, type EngineOptions, type JailCall, type JailResult } from './common.js';
import type { EngineConfig, EngineResults } from './engine.js';
import type { FromWorker, ToWorker } from './serve.js';

/** The part of a `Worker` the jail uses. */
export interface WorkerLike {
  postMessage(message: ToWorker): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface WorkerJailOptions extends EngineOptions {
  /** Starts the jail's worker (`src/worker.ts`), e.g. `() => new JailWorker()` with Vite's `?worker` import. */
  worker: () => WorkerLike;
  /** A request's time: `requestBaseMs` and `perCallMs` per call, at most `requestMaxMs`; then the worker is terminated. */
  requestBaseMs?: number;
  perCallMs?: number;
  requestMaxMs?: number;
  /** A worker that is not ready this long after its start is terminated. */
  startMs?: number;
}

interface Pending {
  id: number;
  count: number;
  resolve: (results: EngineResults) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The script did not load or defines no entry function: its own answer, not the worker's failure. */
class LoadError extends Error {}

/**
 * Runs code it does not trust in a Web Worker, in QuickJS-in-WebAssembly: two layers, the interpreter (a script reaches
 * nothing but the language) and the worker (off the page's thread, no DOM, terminated when a request runs over its time
 * or the engine breaks; the next request starts a new one). One request at a time.
 *
 * What the worker answers is checked before it is used, as if the worker were the script's: shape, ids and counts.
 */
export class WorkerJail {
  private worker: WorkerLike | null = null;
  private ready: Promise<WorkerLike> | null = null;
  private onReady: (() => void) | null = null;
  private onStartFailed: ((err: Error) => void) | null = null;
  private pending: Pending | null = null;
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly config: EngineConfig;
  private readonly failures: Failures;
  private readonly options: Required<Pick<WorkerJailOptions, 'requestBaseMs' | 'perCallMs' | 'requestMaxMs' | 'startMs'>> & WorkerJailOptions;

  constructor(options: WorkerJailOptions) {
    this.config = engineConfig(options);
    this.failures = new Failures(options.maxFailures ?? ENGINE_DEFAULTS.maxFailures);
    this.options = { requestBaseMs: 1500, perCallMs: 60, requestMaxMs: 8000, startMs: 15000, ...options };
  }

  /** Calls the script's entry function once per call: each answer, or why there is none (all of them when the script failed). */
  async run(code: string, calls: JailCall[]): Promise<JailResult[]> {
    if (this.failures.refused(code)) return calls.map(() => ({ error: REFUSED }));
    let raw: EngineResults;
    try {
      raw = await this.request(code, calls);
    } catch (err) {
      if (!(err instanceof LoadError)) this.failures.add(code);
      return calls.map(() => ({ error: (err as Error).message }));
    }
    return toResults(raw, this.config.entry);
  }

  /** Terminates the worker (it starts again with the next request). */
  stop(): void {
    this.kill('stopped');
  }

  private request(code: string, calls: JailCall[]): Promise<EngineResults> {
    const run = this.queue.then(() => this.send(code, calls));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(code: string, calls: JailCall[]): Promise<EngineResults> {
    const worker = await this.start();
    const id = this.nextId++;
    const { requestBaseMs, perCallMs, requestMaxMs, onWarn } = this.options;
    return new Promise<EngineResults>((resolve, reject) => {
      const ms = Math.min(requestMaxMs, requestBaseMs + calls.length * perCallMs);
      const timer = setTimeout(() => {
        onWarn?.(`a script took longer than ${ms} ms: the worker is terminated`);
        this.kill(`The script took longer than ${ms} ms`);
      }, ms);
      this.pending = { id, count: calls.length, resolve, reject, timer };
      worker.postMessage({ type: 'run', id, code, calls: calls.map((c) => ({ input: c.input, seed: c.seed ?? 0 })) });
    });
  }

  private start(): Promise<WorkerLike> {
    if (this.worker && this.ready) return this.ready;
    const worker = this.options.worker();
    this.worker = worker;
    this.ready = new Promise<WorkerLike>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.options.onWarn?.(`the worker was not ready after ${this.options.startMs} ms`);
        this.kill('The worker did not start');
        reject(new Error('The worker did not start'));
      }, this.options.startMs);
      this.onReady = () => {
        clearTimeout(timer);
        resolve(worker);
      };
      this.onStartFailed = (err) => {
        clearTimeout(timer);
        reject(err);
      };
    });
    this.ready.catch(() => undefined);
    worker.onmessage = (event) => {
      if (this.worker === worker) this.onAnswer(event.data);
    };
    worker.onerror = () => {
      if (this.worker !== worker) return;
      this.options.onWarn?.('the worker failed');
      this.kill('The worker failed');
    };
    worker.postMessage({ type: 'config', config: this.config });
    return this.ready;
  }

  private onAnswer(data: unknown): void {
    const message = (data && typeof data === 'object' ? data : {}) as Partial<FromWorker> & Record<string, unknown>;
    if (message.type === 'ready') {
      this.onReady?.();
      this.onReady = this.onStartFailed = null;
      return;
    }
    if (message.type === 'fatal') {
      const why = `The engine failed: ${String(message.message).slice(0, 300)}`;
      this.options.onWarn?.(why);
      this.onStartFailed?.(new Error(why));
      this.onStartFailed = null;
      return this.kill(why);
    }
    const pending = this.pending;
    if (!pending || message.id !== pending.id) return;
    if (message.type === 'failure') return this.settle((p) => p.reject(new Error(String(message.message).slice(0, 300))));
    if (message.type !== 'answer') return this.kill('The worker answered nonsense');
    const answer = message.answer as Record<string, unknown> | undefined;
    if (answer && typeof answer.loadError === 'string') {
      const why = answer.loadError.slice(0, 300);
      return this.settle((p) => p.reject(new LoadError(why)));
    }
    const results = answer?.results;
    const valid =
      Array.isArray(results) &&
      results.length === pending.count &&
      results.every((r) => typeof r === 'string' || (r && typeof r === 'object' && typeof (r as { error?: unknown }).error === 'string'));
    if (!valid) return this.kill('The worker answered nonsense');
    this.settle((p) => p.resolve(results as EngineResults));
  }

  private settle(done: (pending: Pending) => void): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    done(pending);
  }

  private kill(why: string): void {
    const worker = this.worker;
    this.worker = null;
    this.ready = null;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
    this.settle((p) => p.reject(new Error(why)));
  }
}
