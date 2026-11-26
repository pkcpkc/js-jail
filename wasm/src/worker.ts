/**
 * The Web Worker that `WorkerJail` starts: QuickJS in WebAssembly, serving one request at a time. Start it as a module
 * worker; with Vite: `import JailWorker from '@js-jail/wasm/worker?worker'` and `new WorkerJail({ worker: () => new JailWorker() })`.
 */
import { loadQuickJS } from './jail.js';
import { serveJail, type WorkerScope } from './serve.js';

serveJail(globalThis as unknown as WorkerScope, loadQuickJS);
