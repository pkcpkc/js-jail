# @js-jail/node

The server half of [js-jail](../README.md). Run JavaScript you do not trust: a script written by a model, a user, or anyone else. It runs in a long-lived worker
behind three layers, and each layer holds on its own. Only JSON goes in and comes out.

```ts
import { JsJail } from '@js-jail/node';

const jail = new JsJail({ entry: 'effect', inputRand: 'rand' });
const results = await jail.run(
  'function effect({ text, rand }) { return Array.from(text, () => ({ rotate: rand() * 10 })); }',
  [{ input: { text: 'HELLO' }, seed: 42 }]
);
// [{ value: [{ rotate: 3.1 }, …] }]  or  [{ error: 'effect() took longer than 50 ms' }]
jail.stop();
```

The script defines one function (`entry`, default `main`), and `run()` calls it once per call with that call's
`input`. Each call gets a seeded `rand()`, which is also `Math.random` and the global `rand`. Set `inputRand` and
`rand` is also added to object inputs under that key. The answers are parsed JSON, and **still untrusted data**:
check them before you use them.

## The layers

| Layer | What | Holds against |
| --- | --- | --- |
| 1. Context | A fresh `vm` context per script (`Object.create(null)`): nothing of Node in it, `codeGeneration: { strings: false, wasm: false }`, no `Date`, `WebAssembly`, `SharedArrayBuffer`, `Atomics`, `WeakRef` or `FinalizationRegistry`. Microtasks run inside the call's timeout (`microtaskMode: 'afterEvaluate'`). Inputs go in as string literals of the call. Only strings come back. A thrown value is never touched outside the context, except for an own data property of a native error. | Reaching Node. Endless loops (`callMs`, 50 ms), including in getters, `toJSON` and promises. Nondeterminism. |
| 2. Process | One `node` child started with `--permission` and nothing allowed: no files, network, child processes, workers, addons or WASI. Also `--disallow-code-generation-from-strings` (which also stops the classic `this.constructor.constructor('return process')` escape), a heap of `heapMb` (64 MB), an empty environment, and an empty folder as its working directory. Its source comes with `-e`, so it reads no file. | Code that got out of the context. Memory bombs (the child dies and is restarted). |
| 3. OS | macOS seatbelt (`sandbox-exec`): no network, no writes, no fork or exec except Node itself, no reading `/Users`, `/Volumes`, temp folders, `/etc` or the Keychain. | Code that got out of Node, for example through a bug in the permission model. Node's docs call the permission model a seat belt, not a guarantee against malicious code. |

The parent sends one request at a time. It kills the child when a request runs over its time (`requestBaseMs` plus
`perCallMs` per call, at most `requestMaxMs`) or answers more than 8 MB, and starts a new child with the next request.
A script is refused after `maxFailures` timeouts or crashes. A script that does not load or defines no entry function
fails right away, and that does not count as a failure.

Without macOS (or with `seatbelt: false`), layer 3 is missing; `jail.seatbelt` tells you which you have.

## What it does not do

- It does not bound CPU across requests: a script may use up its time limit on every call. Rate-limit callers if that matters.
- It does not judge the answers: they are JSON, and a hostile script answers hostile JSON. Validate and clamp them,
  and escape them before they go into HTML or SVG.
- Layer 3 is macOS only.

## API

- `new JsJail(options)`: `entry`, `inputRand`, `seatbelt`, `removeGlobals`, `callMs`, `loadMs`, `heapMb`, `maxAnswer`, `requestBaseMs`, `perCallMs`, `requestMaxMs`, `maxFailures`, `onWarn`
- `jail.run(code, calls)`: resolves to `{ value } | { error }` per call, and never rejects
- `jail.stop()`
- `jailCommand(script, cwd, seatbelt)`: the command that runs any script in layers 2 and 3 (for probes)
- `seatbeltProfile(node, cwd)`, `nodeFlags(heapMb)`, `hasSeatbelt()`, `scriptHash(code)`

Tests (`npm test`, Vitest), one file per source file: `jail.test.ts` attacks the jail as a whole, `seatbelt.test.ts`
runs the outer layers alone with a probe that has all of Node available, `worker.test.ts` talks to the worker's
source on its own, and `index.test.ts` checks the exports.

Requires Node 25 or later (`--permission` restricts the network).
