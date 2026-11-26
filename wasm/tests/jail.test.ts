import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WasmJail, loadQuickJS } from '../src/jail.ts';

/** The in-thread jail (`src/jail.ts`): QuickJS loaded once, requests one at a time, failures counted. */

const ECHO = 'function main(input) { return { got: input, r: rand() }; }';

let jail: WasmJail;
beforeAll(() => {
  jail = new WasmJail({ maxFailures: 2 });
});
afterAll(() => jail.stop());

const one = async (code: string, input: unknown = 'x', j = jail) => (await j.run(code, [{ input }]))[0];

describe('WasmJail', () => {
  it('calls the entry function with each input and answers its JSON, rand seeded per call', async () => {
    const [a, b, c] = await jail.run(ECHO, [{ input: { n: 1 }, seed: 7 }, { input: [1, 'two'], seed: 7 }, { input: null, seed: 8 }]);
    expect(a).toMatchObject({ value: { got: { n: 1 } } });
    expect(b).toMatchObject({ value: { got: [1, 'two'] } });
    expect((a as { value: { r: number } }).value.r).toBe((b as { value: { r: number } }).value.r);
    expect((c as { value: { r: number } }).value.r).not.toBe((a as { value: { r: number } }).value.r);
  });

  it("draws the same rand() as @js-jail/node's (mulberry32), so a script answers the same in either jail", async () => {
    const [a, b] = await jail.run('function main(n) { return Array.from({ length: n }, () => Math.random()); }', [
      { input: 2, seed: 7 },
      { input: 3, seed: 4294967295 },
    ]);
    expect(a).toEqual({ value: [0.011704753153026104, 0.06195825757458806] });
    expect(b).toEqual({ value: [0.8964226141106337, 0.189478256739676, 0.7156526781618595] });
  });

  it('adds rand to object inputs under inputRand, and answers a load error for every call', async () => {
    const own = new WasmJail({ entry: 'effect', inputRand: 'rand' });
    try {
      const [r] = await own.run('function effect({ rand, n }) { return [typeof rand, n, rand() === Math.random() ? "same" : "next"]; }', [{ input: { n: 2 } }]);
      expect(r).toEqual({ value: ['function', 2, 'next'] });
      expect(await own.run('function main() { return 1; }', [{ input: 1 }, { input: 2 }])).toEqual(Array(2).fill({ error: 'The script must define function effect()' }));
    } finally {
      own.stop();
    }
    expect(() => new WasmJail({ entry: 'a; globalThis' })).toThrow(/identifier/);
  });

  it('counts a script that runs out of memory, runs others as before, and refuses it after maxFailures', async () => {
    const bomb = 'function main() { const a = []; for (;;) a.push(new Array(1e5).fill(1)); }';
    expect(await one(bomb)).toEqual({ error: 'The script used too much memory' });
    expect(await one('function main(x) { return x; }', 5)).toEqual({ value: 5 });
    expect(await one(bomb)).toEqual({ error: 'The script used too much memory' });
    expect(await one(bomb)).toEqual({ error: 'This script failed too often and is not run again' });
  });

  it('answers what a script threw, as an error', async () => {
    expect(await one('function main() { throw new Error("boom"); }')).toEqual({ error: 'main() threw: boom' });
    expect(await one('function main() {}')).toEqual({ value: null });
  });

  it('stops a request that runs over requestMaxMs, and counts it against the script', async () => {
    const slow = new WasmJail({ requestMaxMs: 60, callMs: 1000, maxFailures: 1 });
    try {
      const code = 'function main() { let x = 0; for (let i = 0; i < 3e6; i++) x += i; return x > 0; }';
      const results = await slow.run(code, Array.from({ length: 50 }, () => ({ input: 0 })));
      expect(results).toHaveLength(50);
      expect(results.at(-1)).toEqual({ error: 'The script took longer than 60 ms' });
      expect(await one(code, 0, slow)).toEqual({ error: 'This script failed too often and is not run again' });
    } finally {
      slow.stop();
    }
  });

  it('drops a broken module whole and loads a fresh one for the next request', async () => {
    let loads = 0;
    const warnings: string[] = [];
    const broken = new WasmJail({
      load: async () => {
        loads++;
        const module = await loadQuickJS();
        if (loads === 1)
          module.newRuntime = () => {
            throw new WebAssembly.RuntimeError('unreachable');
          };
        return module;
      },
      onWarn: (m) => warnings.push(m),
    });
    try {
      expect(await one(ECHO, 'x', broken)).toEqual({ error: 'The script crashed the engine' });
      expect(warnings).toEqual(['the QuickJS module failed: unreachable']);
      expect(await one(ECHO, 'x', broken)).toHaveProperty('value');
      expect(loads).toBe(2);
    } finally {
      broken.stop();
    }
  });

  it('loads again after stop()', async () => {
    const short = new WasmJail();
    expect(await one('function main() { return 1; }', 0, short)).toEqual({ value: 1 });
    short.stop();
    expect(await one('function main() { return 2; }', 0, short)).toEqual({ value: 2 });
    short.stop();
  });
});
