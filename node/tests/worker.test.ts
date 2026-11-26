import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { workerSource, type WorkerConfig } from '../src/worker.ts';

/**
 * The worker's source (`src/worker.ts`) on its own: started with a plain `node -e` (no jail around it, which
 * `jail.test.ts` adds), fed JSON lines, as `JsJail` feeds it.
 */

const CONFIG: WorkerConfig = { entry: 'main', removeGlobals: ['Date'], callMs: 50, loadMs: 200, maxAnswer: 100, keep: 2 };

/** Starts the worker, sends `requests` one per line (a string as it is), and answers its lines, parsed. */
function talk(config: WorkerConfig, requests: unknown[]): unknown[] {
  const res = spawnSync(process.execPath, ['-e', workerSource(config)], { input: requests.map((r) => `${typeof r === 'string' ? r : JSON.stringify(r)}\n`).join(''), encoding: 'utf8', timeout: 20000 });
  return res.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('workerSource', () => {
  it('puts the config in as JSON, ahead of the worker body', () => {
    const source = workerSource({ ...CONFIG, entry: 'effect' });
    expect(source.startsWith(`'use strict';\nconst CONFIG = ${JSON.stringify({ ...CONFIG, entry: 'effect' })};\n`)).toBe(true);
  });

  it('says it is ready, then answers each request line with its id: JSON per call, or an error per call', () => {
    const [ready, first, second] = talk(CONFIG, [
      { id: 1, hash: 'a', code: 'function main(x) { return [x, typeof Date, rand() < 1]; }', calls: [{ input: 2, seed: 1 }] },
      { id: 2, hash: 'b', code: 'function main() { return "x".repeat(200); }', calls: [{ input: 0, seed: 0 }] },
    ]);
    expect(ready).toEqual({ ready: true });
    expect(first).toEqual({ id: 1, results: ['[2,"undefined",true]'] });
    expect(second).toEqual({ id: 2, results: [{ error: 'main() answered more than 100 characters' }] });
  });

  it('answers a script that does not load, or defines no entry, with one error for the request', () => {
    const [, broken, missing] = talk(CONFIG, [
      { id: 1, hash: 'a', code: 'function main( {', calls: [{ input: 0, seed: 0 }] },
      { id: 2, hash: 'b', code: 'function other() {}', calls: [{ input: 0, seed: 0 }] },
    ]);
    expect(broken).toMatchObject({ id: 1, error: expect.any(String) });
    expect(missing).toEqual({ id: 2, error: 'The script must define function main()' });
  });

  it('gives an object input the seeded rand under inputRand, and skips lines that are no JSON', () => {
    const [, answer] = talk({ ...CONFIG, inputRand: 'rand' }, ['not json', { id: 5, hash: 'a', code: 'function main({ rand }) { return typeof rand; }', calls: [{ input: {}, seed: 3 }] }]);
    expect(answer).toEqual({ id: 5, results: ['"function"'] });
  });
});
