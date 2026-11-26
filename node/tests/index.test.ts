import { describe, it, expect } from 'vitest';
import * as api from '../src/index.ts';

/** The package's entry (`src/index.ts`): what it exports, and nothing else. */
describe('@js-jail/node', () => {
  it('exports the jail, its layers and the worker source', () => {
    expect(Object.keys(api).sort()).toEqual(['JsJail', 'NODE_FLAGS', 'SANDBOX_EXEC', 'ScriptError', 'hasSeatbelt', 'jailCommand', 'nodeFlags', 'scriptHash', 'seatbeltProfile', 'workerSource']);
  });

  it('hashes a script the same way every time, and two scripts apart', () => {
    expect(api.scriptHash('a')).toBe(api.scriptHash('a'));
    expect(api.scriptHash('a')).not.toBe(api.scriptHash('b'));
    expect(api.scriptHash('a')).toMatch(/^[0-9a-f]{32}$/);
  });
});
