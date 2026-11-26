import { describe, it, expect, vi } from 'vitest';
import { loadQuickJS } from '../src/jail.ts';
import { serveJail, type FromWorker, type ToWorker, type WorkerScope } from '../src/serve.ts';
import { WorkerJail, type WorkerLike } from '../src/workerJail.ts';

/**
 * The worker jail (`src/workerJail.ts`) against an in-process stand-in for a Web Worker that serves exactly as
 * `src/worker.ts` does, with messages passed on a later tick and cloned, as a real worker's are.
 */

const ECHO = 'function main(input) { return { got: input, r: rand() }; }';

type TestWorker = WorkerLike & { terminated: boolean; sent: ToWorker[] };

/** A worker that serves the jail (or, with `serve` false, only says it is ready and never answers a request). */
function inProcessWorker(serve = true): TestWorker {
  const worker: TestWorker = {
    terminated: false,
    sent: [],
    onmessage: null,
    onerror: null,
    postMessage(message) {
      worker.sent.push(message);
      setTimeout(() => !worker.terminated && scope.onmessage?.({ data: structuredClone(message) }));
    },
    terminate() {
      worker.terminated = true;
    },
  };
  const scope: WorkerScope = {
    postMessage: (message: FromWorker) => setTimeout(() => !worker.terminated && worker.onmessage?.({ data: structuredClone(message) })),
    onmessage: null,
  };
  if (serve) serveJail(scope, loadQuickJS);
  else scope.onmessage = ({ data }) => data.type === 'config' && scope.postMessage({ type: 'ready' });
  return worker;
}

const one = async (j: WorkerJail, code: string, input: unknown = 'x') => (await j.run(code, [{ input }]))[0];

describe('WorkerJail', () => {
  it('runs scripts in one worker: answers, load errors (not counted) and timeouts inside QuickJS', async () => {
    const workers: TestWorker[] = [];
    const jail = new WorkerJail({ worker: () => (workers.push(inProcessWorker()), workers.at(-1)!), maxFailures: 1 });
    try {
      expect(await jail.run(ECHO, [{ input: 1, seed: 7 }])).toEqual([{ value: { got: 1, r: 0.011704753153026104 } }]);
      expect(await one(jail, 'function nope() {}')).toEqual({ error: 'The script must define function main()' });
      expect(await one(jail, 'function nope() {}')).toEqual({ error: 'The script must define function main()' });
      expect(await one(jail, 'function main() { for (;;) {} }')).toEqual({ error: 'main() took longer than 50 ms' });
      expect(workers).toHaveLength(1);
      expect(workers[0].sent[0]).toMatchObject({ type: 'config', config: { entry: 'main', callMs: 50 } });
    } finally {
      jail.stop();
    }
  });

  it('terminates a worker that runs over the request time, counts it, and starts a new worker for the next request', async () => {
    const workers: TestWorker[] = [];
    const onWarn = vi.fn();
    // The first worker never answers a request; the second serves
    const jail = new WorkerJail({ worker: () => (workers.push(inProcessWorker(workers.length > 0)), workers.at(-1)!), requestBaseMs: 50, perCallMs: 0, maxFailures: 1, onWarn });
    try {
      expect(await one(jail, ECHO)).toEqual({ error: 'The script took longer than 50 ms' });
      expect(workers[0].terminated).toBe(true);
      expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/terminated/));
      expect(await one(jail, ECHO)).toEqual({ error: 'This script failed too often and is not run again' });
      expect(await one(jail, 'function main(x) { return x; }', 3)).toEqual({ value: 3 });
      expect(workers).toHaveLength(2);
    } finally {
      jail.stop();
    }
  });

  it("checks the worker's answers as untrusted: a wrong count or shape terminates it", async () => {
    let worker!: TestWorker;
    const jail = new WorkerJail({
      worker: () => {
        worker = inProcessWorker(false);
        const post = worker.postMessage;
        worker.postMessage = (message) => {
          post(message);
          if (message.type === 'run') setTimeout(() => worker.onmessage?.({ data: { type: 'answer', id: message.id, answer: { results: ['1', { evil: true }] } } }));
        };
        return worker;
      },
    });
    try {
      expect(await one(jail, ECHO)).toEqual({ error: 'The worker answered nonsense' });
      expect(worker.terminated).toBe(true);
    } finally {
      jail.stop();
    }
  });

  it('terminates the worker on a fatal answer or an error event', async () => {
    const workers: TestWorker[] = [];
    const jail = new WorkerJail({ worker: () => (workers.push(inProcessWorker(false)), workers.at(-1)!), onWarn: () => undefined });
    const fatal = one(jail, ECHO);
    await vi.waitFor(() => expect(workers[0]?.sent.some((m) => m.type === 'run')).toBe(true));
    workers[0].onmessage?.({ data: { type: 'fatal', id: 1, message: 'unreachable' } });
    expect(await fatal).toEqual({ error: 'The engine failed: unreachable' });
    expect(workers[0].terminated).toBe(true);
    const failed = one(jail, 'function main() { return 1; }');
    await vi.waitFor(() => expect(workers[1]?.sent.some((m) => m.type === 'run')).toBe(true));
    workers[1].onerror?.(new Event('error'));
    expect(await failed).toEqual({ error: 'The worker failed' });
    expect(workers[1].terminated).toBe(true);
  });

  it('gives up on a worker that never gets ready', async () => {
    const silent: WorkerLike = { postMessage: () => undefined, terminate: vi.fn(), onmessage: null, onerror: null };
    const jail = new WorkerJail({ worker: () => silent, startMs: 30, onWarn: () => undefined });
    expect(await one(jail, ECHO)).toEqual({ error: 'The worker did not start' });
    expect(silent.terminate).toHaveBeenCalled();
  });
});
