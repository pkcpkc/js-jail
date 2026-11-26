import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as api from '../src/index.ts';

/** The package's entry (`src/index.ts`) and its manifest: what it exports, and which QuickJS each platform gets. */
describe('@js-jail/wasm', () => {
  it('exports both jails, the engine and the worker side', () => {
    expect(Object.keys(api).sort()).toEqual(['ENGINE_DEFAULTS', 'EngineFailure', 'QuickEngine', 'WasmJail', 'WorkerJail', 'loadQuickJS', 'preludeSource', 'serveJail']);
  });

  it('maps #variant to a browser and a Node build of the same QuickJS', () => {
    const pkg = createRequire(import.meta.url)('../package.json') as { imports: Record<string, Record<string, string>>; dependencies: Record<string, string>; exports: Record<string, { types: string; default: string }> };
    const { browser, default: node } = pkg.imports['#variant'];
    expect(browser).toMatch(/singlefile-browser/);
    expect(node).toMatch(/singlefile-mjs/);
    expect(pkg.dependencies[browser]).toBe(pkg.dependencies[node]);
    expect(pkg.dependencies['quickjs-emscripten-core']).toBe(pkg.dependencies[node]);
    expect(pkg.exports['./worker']).toEqual({ types: './dist/worker.d.ts', default: './dist/worker.js' });
  });
});
