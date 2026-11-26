import { describe, it, expect, vi, afterEach } from 'vitest';
import { engineConfig } from '../src/common.ts';
import type { FromWorker, ToWorker } from '../src/serve.ts';

/** The worker entry (`src/worker.ts`): imported into a stand-in worker scope, it serves the jail on `onmessage`. */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the worker entry', () => {
  it('serves the jail on its global scope, with the QuickJS build for this platform', async () => {
    const posted: FromWorker[] = [];
    vi.stubGlobal('postMessage', (m: FromWorker) => posted.push(m));
    vi.stubGlobal('onmessage', null);
    await import('../src/worker.ts');
    const onmessage = (globalThis as unknown as { onmessage: (e: { data: ToWorker }) => void }).onmessage;
    expect(typeof onmessage).toBe('function');
    onmessage({ data: { type: 'config', config: engineConfig({}) } });
    await vi.waitFor(() => expect(posted).toEqual([{ type: 'ready' }]));
    onmessage({ data: { type: 'run', id: 1, code: 'function main() { return typeof Date; }', calls: [{ input: 0, seed: 0 }] } });
    expect(posted.at(-1)).toEqual({ type: 'answer', id: 1, answer: { results: ['"undefined"'] } });
  });
});
