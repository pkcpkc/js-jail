import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { engineConfig } from '../src/common.ts';
import { EngineFailure, QuickEngine, preludeSource } from '../src/engine.ts';
import { loadQuickJS } from '../src/jail.ts';

/**
 * The engine (`src/engine.ts`), attacked: every script runs for real in QuickJS-in-WebAssembly. The jails around it
 * (counting, refusing, workers) have their own tests.
 */

let engine: QuickEngine;
beforeAll(async () => {
  engine = new QuickEngine(await loadQuickJS(), engineConfig({ keep: 3 }));
});
afterAll(() => engine.dispose());

/** One call's raw answer: the JSON string, or `{ error }`; a load error as `{ loadError }`. */
const call = (code: string, input: unknown = 'x', seed = 0) => {
  const answer = engine.answer(code, [{ input, seed }]);
  return 'loadError' in answer ? answer : answer.results[0];
};
const value = (code: string, input?: unknown) => JSON.parse(call(code, input) as string);

describe('preludeSource', () => {
  it('wraps the entry, and adds rand under inputRand only when asked', () => {
    expect(preludeSource({ entry: 'effect' })).toContain('const out = effect(arg);');
    expect(preludeSource({ entry: 'main' })).not.toContain('Object.freeze');
    expect(preludeSource({ entry: 'main', inputRand: 'rnd' })).toContain('{ "rnd": globalThis.rand }');
  });
});

describe('QuickEngine', () => {
  it('answers JSON per call, rand seeded by the call', () => {
    const answer = engine.answer('function main(x) { return [x, rand()]; }', [
      { input: 1, seed: 7 },
      { input: 2, seed: 7 },
    ]);
    expect(answer).toEqual({ results: ['[1,0.011704753153026104]', '[2,0.011704753153026104]'] });
  });

  it('gives a script only the language: no host, no clock, no timers, no fetch, no WebAssembly, no std or os modules', () => {
    expect(value('function main() { return [typeof require, typeof process, typeof Date, typeof setTimeout, typeof fetch, typeof WebAssembly, typeof Buffer, typeof std, typeof os, typeof self, typeof window]; }')).toEqual(
      Array(11).fill('undefined')
    );
  });

  it('lets eval and the Function constructor run, but only inside the interpreter: there is nothing outside to reach', () => {
    expect(value('function main() { return [eval("typeof process"), new Function("return typeof require")(), this.constructor.constructor("return typeof process")()]; }')).toEqual([
      'undefined',
      'undefined',
      'undefined',
    ]);
  });

  it('cuts off a script that runs too long: in its call, in a getter of what it throws, in toJSON, while it loads', () => {
    expect(call('function main() { while (true) {} }')).toEqual({ error: 'main() took longer than 50 ms' });
    expect(call('function main() { throw { get message() { while (true) {} } }; }')).toEqual({ error: 'main() took longer than 50 ms' });
    expect(call('function main() { return { toJSON() { for (;;) {} } }; }')).toEqual({ error: 'main() took longer than 50 ms' });
    expect(call('while (true) {}')).toEqual({ loadError: 'The script timed out after 200 ms while it loaded' });
  });

  it('never runs promise jobs: a loop queued in a promise stays queued', () => {
    expect(value('function main() { Promise.resolve().then(() => { while (true) {} }); return 1; }')).toBe(1);
  });

  it('throws EngineFailure at the memory limit, and loads that script afresh next time', () => {
    const bomb = 'let calls = 0; function main(fill) { calls++; const a = []; if (fill) for (;;) a.push(new Array(1e5).fill(1)); return calls; }';
    expect(value(bomb, false)).toBe(1);
    expect(() => call(bomb, true)).toThrow(EngineFailure);
    expect(value(bomb, false)).toBe(1);
  });

  it('throws a catchable stack overflow before the host stack runs out', () => {
    expect(call('function main() { const f = () => f(); return f(); }')).toBe('{"__error":"stack overflow"}');
    expect(value('function main() { let n = 0; const f = () => { n++; f(); }; try { f(); } catch {} return n > 500; }')).toBe(true);
  });

  it('answers a load error, a missing entry, a too long answer, and no answer', () => {
    expect(call('throw new Error("at load")')).toEqual({ loadError: 'at load' });
    expect(call('function nope() {}')).toEqual({ loadError: 'The script must define function main()' });
    expect(call('function main() { return "x".repeat(70000); }')).toEqual({ error: 'main() answered more than 65536 characters' });
    expect(call('function main() { return () => 1; }')).toEqual({ error: 'main() gave no answer' });
    expect(call('function main() { throw new Error("boom"); }')).toBe('{"__error":"boom"}');
  });

  it('gives each script its own runtime, keeps its state across calls, and keeps only the last `keep`', () => {
    call('globalThis.secret = 42; function main() { return 1; }');
    expect(value('function main() { return typeof secret; }')).toBe('undefined');
    const counter = 'let n = 0; function main() { return ++n; }';
    expect([value(counter), value(counter)]).toEqual([1, 2]);
    for (const i of [1, 2, 3]) call(`function main() { return ${i}; }`);
    expect(value(counter)).toBe(1);
  });

  it('never mixes up two scripts: they are kept by their code', () => {
    expect(value('function main() { return "a"; }')).toBe('a');
    expect(value('function main() { return "b"; }')).toBe('b');
  });
});
