import { describe, it, expect } from 'vitest';
import { ENGINE_DEFAULTS, Failures, MAX_STACK_KB, REFUSED, engineConfig, toResults } from '../src/common.ts';

/** What both jails share (`src/common.ts`): the engine's config, the answers as results, and counting failures. */

describe('engineConfig', () => {
  it('fills in the defaults, and takes what is given', () => {
    const { maxFailures: _, ...defaults } = ENGINE_DEFAULTS;
    expect(engineConfig({})).toEqual(defaults);
    expect(engineConfig({ entry: 'effect', inputRand: 'rand', callMs: 10 })).toMatchObject({ entry: 'effect', inputRand: 'rand', callMs: 10 });
    expect(engineConfig({ maxFailures: 9, onWarn: () => undefined })).not.toHaveProperty('maxFailures');
  });

  it('refuses names that are no identifiers (they go into source) and a stack deeper than the host allows', () => {
    expect(() => engineConfig({ entry: 'a; globalThis' })).toThrow(/identifier/);
    expect(() => engineConfig({ inputRand: 'x}' })).toThrow(/identifier/);
    expect(() => engineConfig({ stackKb: MAX_STACK_KB + 1 })).toThrow(/stackKb/);
    expect(() => engineConfig({ stackKb: 0 })).toThrow(/stackKb/);
    expect(engineConfig({ stackKb: MAX_STACK_KB }).stackKb).toBe(MAX_STACK_KB);
  });
});

describe('toResults', () => {
  it('parses each answer, and turns a thrown value, an error or no JSON into an error', () => {
    expect(toResults(['{"a":1}', '{"__error":"boom"}', { error: 'slow' }, 'nope', '[1]'], 'main')).toEqual([
      { value: { a: 1 } },
      { error: 'main() threw: boom' },
      { error: 'slow' },
      { error: 'main() answered something that is not JSON' },
      { value: [1] },
    ]);
  });
});

describe('Failures', () => {
  it('refuses a script once it failed max times, and only that script', () => {
    const failures = new Failures(2);
    failures.add('a');
    expect(failures.refused('a')).toBe(false);
    failures.add('a');
    expect(failures.refused('a')).toBe(true);
    expect(failures.refused('b')).toBe(false);
    expect(REFUSED).toMatch(/not run again/);
  });
});
