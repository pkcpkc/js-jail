import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { JsJail } from '../src/jail.ts';

/**
 * The jail (`src/jail.ts`), attacked: every script here runs for real in the worker (the vm context, Node's permission
 * model and, on macOS, the seatbelt). `seatbelt.test.ts` shows that each outer layer holds on its own.
 */

const ECHO = 'function main(input) { return { got: input, r: rand() }; }';

let jail: JsJail;
beforeAll(() => {
  jail = new JsJail({ maxFailures: 3 });
});
afterAll(() => jail.stop());

const one = async (code: string, input: unknown = 'x') => (await jail.run(code, [{ input }]))[0];
const errorOf = async (code: string) => {
  const r = await one(code);
  return 'error' in r ? r.error : 'NO ERROR';
};

describe('the jail', () => {
  it('calls the entry function with each input and answers its JSON, rand seeded per call', async () => {
    const [a, b, c] = await jail.run(ECHO, [{ input: { n: 1 }, seed: 7 }, { input: [1, 'two'], seed: 7 }, { input: null, seed: 8 }]);
    expect(a).toMatchObject({ value: { got: { n: 1 } } });
    expect(b).toMatchObject({ value: { got: [1, 'two'] } });
    expect((a as { value: { r: number } }).value.r).toBe((b as { value: { r: number } }).value.r);
    expect((c as { value: { r: number } }).value.r).not.toBe((a as { value: { r: number } }).value.r);
  });

  it('adds rand to object inputs under inputRand, and calls another entry', async () => {
    const own = new JsJail({ entry: 'effect', inputRand: 'rand' });
    try {
      const [r] = await own.run('function effect({ rand, n }) { return [typeof rand, n, rand() === Math.random() ? "same" : "next"]; }', [{ input: { n: 2 } }]);
      expect(r).toEqual({ value: ['function', 2, 'next'] });
      expect((await own.run('function main() { return 1; }', [{ input: 1 }]))[0]).toEqual({ error: 'The script must define function effect()' });
    } finally {
      own.stop();
    }
    expect(() => new JsJail({ entry: 'a; process' })).toThrow(/identifier/);
  });

  it('gives a script nothing of Node: no require, process, clock, timers, fetch, WebAssembly', async () => {
    expect(await one('function main() { return [typeof require, typeof process, typeof Date, typeof setTimeout, typeof fetch, typeof WebAssembly, typeof globalThis.Buffer]; }')).toEqual({
      value: Array(7).fill('undefined'),
    });
    expect(await errorOf('function main() { return eval("1"); }')).toMatch(/Code generation from strings disallowed/);
    expect(await errorOf('function main() { return new Function("return 1")(); }')).toMatch(/Code generation from strings disallowed/);
  });

  it('stops the classic way out of a vm context (the outer Function through a constructor)', async () => {
    expect(await errorOf('function main() { return this.constructor.constructor("return process")().mainModule.require("fs").readFileSync("/etc/hosts", "utf8"); }')).toMatch(
      /Code generation from strings disallowed/
    );
    expect(await errorOf('function main() { return rand.constructor("return process")(); }')).toMatch(/Code generation from strings disallowed/);
  });

  it('cuts off a script that runs too long: in its call, in a getter of what it throws, in a promise, while it loads', async () => {
    expect(await errorOf('function main() { while (true) {} }')).toMatch(/longer than 50 ms/);
    expect(await errorOf('function main() { throw { get message() { while (true) {} } }; }')).toMatch(/longer than 50 ms/);
    expect(await errorOf('function main() { Promise.resolve().then(() => { while (true) {} }); return 1; }')).toMatch(/longer than 50 ms/);
    expect(await errorOf('while (true) {}')).toMatch(/timed out/);
    expect(await one(ECHO)).toHaveProperty('value');
  });

  it('survives a script that eats all memory: the worker dies at its heap limit and the next request starts a new one', async () => {
    // Time enough per call that the heap runs out first, however busy the machine
    const roomy = new JsJail({ callMs: 10000, requestMaxMs: 20000, requestBaseMs: 20000 });
    try {
      expect((await roomy.run('function main() { const a = []; for (;;) a.push(new Array(1e6).fill(1)); }', [{ input: 1 }]))[0]).toEqual({ error: 'The script used too much memory' });
      expect((await roomy.run('function main(x) { return x; }', [{ input: 5 }]))[0]).toEqual({ value: 5 });
    } finally {
      roomy.stop();
    }
  });

  it('answers what a script threw, and refuses an answer that is too long or no JSON', async () => {
    expect(await errorOf('function main() { throw new Error("boom"); }')).toBe('main() threw: boom');
    expect(await errorOf('function main( {')).toMatch(/Unexpected|expected/i);
    expect(await errorOf('function main() { return "x".repeat(70000); }')).toMatch(/more than 65536 characters/);
    expect(await one('function main() { return undefined; }')).toEqual({ value: null });
    expect(await errorOf('function main() { return { toJSON() { return 1n; } }; }')).toMatch(/threw: .*BigInt/);
  });

  it('refuses a script after its failures (requests the worker was killed for), and runs the others', async () => {
    // Its own calls may run long, so each request runs over its time and the worker is killed: a failure every time
    const strict = new JsJail({ callMs: 5000, requestBaseMs: 100, perCallMs: 0, maxFailures: 2 });
    try {
      const hang = 'function main() { while (true) {} }';
      for (let i = 0; i < 2; i++) expect((await strict.run(hang, [{ input: 1 }]))[0]).toEqual({ error: 'The script took longer than 100 ms' });
      expect((await strict.run(hang, [{ input: 1 }]))[0]).toEqual({ error: 'This script failed too often and is not run again' });
      expect((await strict.run('function main(x) { return x; }', [{ input: 4 }]))[0]).toEqual({ value: 4 });
    } finally {
      strict.stop();
    }
  });

  it('keeps one script from reaching another: each has its own context', async () => {
    await one('globalThis.stolen = 1; function main() { return 1; }');
    expect(await one('function main() { return typeof stolen; }')).toEqual({ value: 'undefined' });
  });

  it('kills a request that runs over its time, and goes on', async () => {
    const slow = new JsJail({ requestBaseMs: 100, perCallMs: 0, callMs: 2000 });
    try {
      expect((await slow.run('function main() { while (true) {} }', [{ input: 1 }]))[0]).toEqual({ error: 'The script took longer than 100 ms' });
      expect((await slow.run('function main(x) { return x; }', [{ input: 3 }]))[0]).toEqual({ value: 3 });
    } finally {
      slow.stop();
    }
  });
});
