import type { QuickJSWASMModule } from 'quickjs-emscripten-core';
import { EngineFailure, QuickEngine, type EngineAnswer, type EngineCall, type EngineConfig } from './engine.js';

/** What the host sends a jail worker: the engine's config once, then one request at a time. */
export type ToWorker = { type: 'config'; config: EngineConfig } | { type: 'run'; id: number; code: string; calls: EngineCall[] };

/** What a jail worker answers. `failure`: the script ran out of memory; `fatal`: the engine broke, terminate it. */
export type FromWorker =
  | { type: 'ready' }
  | { type: 'answer'; id: number; answer: EngineAnswer }
  | { type: 'failure'; id: number; message: string }
  | { type: 'fatal'; id?: number; message: string };

/** The part of a worker's global scope the jail uses (`self` in a Web Worker). */
export interface WorkerScope {
  postMessage(message: FromWorker): void;
  onmessage: ((event: { data: ToWorker }) => void) | null;
}

/** Makes `scope` a jail worker: QuickJS loads on the config, then each request runs in the engine. */
export function serveJail(scope: WorkerScope, load: () => Promise<QuickJSWASMModule>): void {
  let engine: QuickEngine | null = null;
  scope.onmessage = ({ data }) => {
    if (data.type === 'config') {
      load()
        .then((module) => {
          engine = new QuickEngine(module, data.config);
          scope.postMessage({ type: 'ready' });
        })
        .catch((err: unknown) => scope.postMessage({ type: 'fatal', message: `QuickJS did not load: ${(err as Error)?.message ?? err}` }));
      return;
    }
    if (data.type !== 'run') return;
    if (!engine) return scope.postMessage({ type: 'fatal', id: data.id, message: 'The engine is not loaded' });
    try {
      scope.postMessage({ type: 'answer', id: data.id, answer: engine.answer(data.code, data.calls) });
    } catch (err) {
      if (err instanceof EngineFailure) return scope.postMessage({ type: 'failure', id: data.id, message: err.message });
      scope.postMessage({ type: 'fatal', id: data.id, message: (err as Error)?.message ?? String(err) });
    }
  };
}
