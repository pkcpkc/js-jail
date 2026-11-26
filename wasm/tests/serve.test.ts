import { describe, it, expect } from 'vitest';
import { engineConfig } from '../src/common.ts';
import { loadQuickJS } from '../src/jail.ts';
import { serveJail, type FromWorker, type ToWorker, type WorkerScope } from '../src/serve.ts';

/** A jail worker's side (`src/serve.ts`), on a stand-in for a worker's global scope. */

function scope() {
  const posted: FromWorker[] = [];
  let next: ((m: FromWorker) => void) | null = null;
  const s: WorkerScope & { posted: FromWorker[]; send: (m: ToWorker) => void; answer: () => Promise<FromWorker> } = {
    posted,
    onmessage: null,
    postMessage(message) {
      posted.push(message);
      next?.(message);
      next = null;
    },
    send(message) {
      s.onmessage?.({ data: message });
    },
    answer: () => new Promise<FromWorker>((resolve) => (next = resolve)),
  };
  return s;
}

describe('serveJail', () => {
  it('loads QuickJS on the config, says ready, then answers each request with its id', async () => {
    const s = scope();
    serveJail(s, loadQuickJS);
    const ready = s.answer();
    s.send({ type: 'config', config: engineConfig({}) });
    expect(await ready).toEqual({ type: 'ready' });
    s.send({ type: 'run', id: 4, code: 'function main(x) { return x * 2; }', calls: [{ input: 21, seed: 0 }] });
    expect(s.posted.at(-1)).toEqual({ type: 'answer', id: 4, answer: { results: ['42'] } });
    s.send({ type: 'run', id: 5, code: 'function nope() {}', calls: [{ input: 0, seed: 0 }] });
    expect(s.posted.at(-1)).toEqual({ type: 'answer', id: 5, answer: { loadError: 'The script must define function main()' } });
  });

  it('answers failure when a script runs out of memory, and fatal when the engine breaks', async () => {
    const s = scope();
    let module!: Awaited<ReturnType<typeof loadQuickJS>>;
    serveJail(s, async () => (module = await loadQuickJS()));
    const ready = s.answer();
    s.send({ type: 'config', config: engineConfig({ memoryMb: 4 }) });
    await ready;
    s.send({ type: 'run', id: 1, code: 'function main() { const a = []; for (;;) a.push(new Array(1e5).fill(1)); }', calls: [{ input: 0, seed: 0 }] });
    expect(s.posted.at(-1)).toEqual({ type: 'failure', id: 1, message: 'The script used too much memory' });
    module.newRuntime = () => {
      throw new WebAssembly.RuntimeError('unreachable');
    };
    s.send({ type: 'run', id: 2, code: 'function main() { return 1; }', calls: [{ input: 0, seed: 0 }] });
    expect(s.posted.at(-1)).toEqual({ type: 'fatal', id: 2, message: 'unreachable' });
  });

  it('answers fatal for a request before the config, and when QuickJS does not load', async () => {
    const s = scope();
    serveJail(s, () => Promise.reject(new Error('no wasm')));
    s.send({ type: 'run', id: 1, code: '', calls: [] });
    expect(s.posted.at(-1)).toEqual({ type: 'fatal', id: 1, message: 'The engine is not loaded' });
    const fatal = s.answer();
    s.send({ type: 'config', config: engineConfig({}) });
    expect(await fatal).toEqual({ type: 'fatal', message: 'QuickJS did not load: no wasm' });
  });
});
