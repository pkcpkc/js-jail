# @js-jail/wasm

The portable half of [js-jail](../README.md). Run JavaScript you do not trust in [QuickJS](https://bellard.org/quickjs/)
compiled to WebAssembly ([quickjs-emscripten](https://github.com/justjake/quickjs-emscripten)): in Node, in a browser
page, or in a Web Worker. Nothing is compiled at run time: the interpreter was compiled to WebAssembly once, and a
script is only text that it interprets. Only JSON goes in and comes out.

```ts
import { WasmJail } from '@js-jail/wasm';

const jail = new WasmJail({ entry: 'effect', inputRand: 'rand' });
const results = await jail.run(
  'function effect({ text, rand }) { return Array.from(text, () => ({ rotate: rand() * 10 })); }',
  [{ input: { text: 'HELLO' }, seed: 42 }]
);
// [{ value: [{ rotate: 3.1 }, …] }]  or  [{ error: 'effect() took longer than 50 ms' }]
jail.stop();
```

In a page, run it in a worker instead, so a script never holds up the page (with Vite):

```ts
import { WorkerJail } from '@js-jail/wasm';
import JailWorker from '@js-jail/wasm/worker?worker';

const jail = new WorkerJail({ worker: () => new JailWorker(), entry: 'effect', inputRand: 'rand' });
```

The contract is the same as `@js-jail/node`'s: the script defines one function (`entry`, default `main`), called once
per call with that call's `input`, with a seeded `rand()` that is also `Math.random` and the global `rand` (the same
mulberry32: a script answers the same numbers in either jail). The answers are parsed JSON, and **still untrusted
data**: check them before you use them.

## The layers

| Layer | What | Holds against |
| --- | --- | --- |
| 1. Interpreter | Each script gets a QuickJS runtime of its own inside the WebAssembly module. No host object is ever handed in, so there is nothing to reach: no `require`, `process`, `fetch`, timers, DOM, or QuickJS's `std` and `os` modules. `Date` is not built in. Inputs go in as one JSON string per call, and only strings come back. | Reaching the host. Other scripts (a runtime each, kept by their code, not a hash). Nondeterminism. |
| 2. Limits | An interrupt handler stops a call at `callMs` (50 ms) and a load at `loadMs`, including loops in getters, `toJSON` and thrown values. `memoryMb` (32 MB) per runtime, and a stack of `stackKb` (192 KB) that throws a catchable `stack overflow`. Promise jobs never run. | Endless loops, memory bombs, deep recursion. |
| 3. WebAssembly | The interpreter's own memory is a sandboxed linear memory: a bug in QuickJS breaks the module, not the host. A trap drops the whole module, and the next request loads a fresh one. | Code that got out of the interpreter through a QuickJS bug. |
| 4. Worker (`WorkerJail`) | Off the page's thread, without the DOM. Terminated when a request runs over its time (`requestBaseMs` plus `perCallMs` per call, at most `requestMaxMs`), when the engine breaks, or when it answers something that is not a well-formed answer for that request. | A hung or broken worker, and a page that would freeze. |

A script is refused after `maxFailures` failed requests: out of memory, over its request time, or a crash. A script that
does not load or defines no entry function fails right away, and that does not count.

## What it does not do

- `eval` and `new Function` work, inside the interpreter. They reach nothing more than the script itself does.
- It is an interpreter: about 20 to 50 times slower than V8. Small pure functions don't notice.
- `WasmJail` runs on the calling thread. A call can't run past its time, but in a page, use `WorkerJail`.
- The stack is the host's own. `stackKb` is at most `MAX_STACK_KB` (256); past about 300 KB the host's limit comes first.
- It does not judge the answers: a hostile script answers hostile JSON. Validate and clamp them, and escape them before
  they go into HTML or SVG.
- It does not draw or touch the DOM. A script that renders UI needs a different sandbox, such as a sandboxed iframe.

## API

- `new WasmJail(options)`: `entry`, `inputRand`, `removeGlobals`, `callMs`, `loadMs`, `memoryMb`, `stackKb`,
  `maxAnswer`, `keep`, `maxFailures`, `requestMaxMs`, `load`, `onWarn`
- `new WorkerJail(options)`: the same engine options, plus `worker` (required), `requestBaseMs`, `perCallMs`,
  `requestMaxMs`, `startMs`
- `jail.run(code, calls)`: resolves to `{ value } | { error }` per call, and never rejects
- `jail.stop()`
- `QuickEngine`, `serveJail(scope, load)`, `loadQuickJS()`: the parts, for your own host

`#variant` picks the QuickJS build: `@jitl/quickjs-singlefile-browser-release-sync` under the `browser` condition, and
`@jitl/quickjs-singlefile-mjs-release-sync` otherwise. Both embed the WebAssembly, so there is no `.wasm` file to serve.

Tests (`npm test`, Vitest), one file per source file: `engine.test.ts` attacks the interpreter, `jail.test.ts` and
`workerJail.test.ts` the two jails (the worker as an in-process stand-in), `serve.test.ts` and `worker.test.ts` the
worker's side, `common.test.ts` the shared parts, and `index.test.ts` the exports and the manifest.
