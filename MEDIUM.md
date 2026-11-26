# Running Untrusted JavaScript, Safely Enough

JavaScript is useful for more than browser interfaces. It can express a scoring function, generate a chart, reshape a
document, or calculate the next step in a deterministic product experience. But once JavaScript is supplied by a
model or a user, “run this function” starts to look less like an expression and more like an attack surface.

That is the problem [js-jail](README.md) is designed to solve.

The project provides two packages with one simple contract:

- Define a function.
- Pass it JSON input.
- Receive JSON output.
- Optionally use a seeded `rand()` function for reproducible results.
- Treat every result as untrusted.

The two approaches serve different environments and priorities.

## The Node Approach: Defense in Depth

[`@js-jail/node`](node/README.md) is built for macOS servers running Node 25 or newer. It executes code through
several layers:

1. A fresh Node `vm` context prevents access to Node globals.
2. A Node child process is started with nearly every permission disabled.
3. On macOS, a seatbelt profile restricts network access, files, subprocesses, and other host resources.

It also limits execution time and memory, and it is explicitly careful about what crosses the JavaScript boundary.
Only JSON-shaped values pass back to the application.

This approach is a good fit for server-side workloads where macOS is available and strong isolation is the priority.
It is not a portable browser solution, and applications should still validate and clamp returned values.

## The WASM Approach: Portable and Predictable

[`@js-jail/wasm`](wasm/README.md) uses QuickJS compiled to WebAssembly. It runs in Node, in browser pages, and in Web
Workers.

Each script receives a separate QuickJS runtime with no host objects, meaning it cannot directly reach `fetch`,
`process`, the DOM, timers, or Node modules. Execution has time, memory, and stack limits. For browser applications,
`WorkerJail` moves execution off the main thread and terminates hung or broken workers.

The WebAssembly build is embedded in the package, so it does not require a separate `.wasm` file to serve.

This approach is ideal when code needs to run across JavaScript environments, especially when a browser preview should
match server behavior.

## The Same Script, the Same Seed

Both packages implement compatible behavior, including seeded randomness using Mulberry32. Given the same seed, the
same script should produce the same random sequence in Node or WebAssembly.

That makes it possible to preview a generated result in the browser and reproduce it later on the server. It also
keeps the API simple: script authors do not need to learn a separate format for each host.

```ts
const jail = new WasmJail({
  entry: 'effect',
  inputRand: 'rand',
});

const results = await jail.run(
  'function effect({ text, rand }) { ' +
  '  return Array.from(text, () => ({ rotate: rand() * 10 })); ' +
  '}',
  [{ input: { text: 'HELLO' }, seed: 42 }],
);
```

The exact package is interchangeable based on the environment, while the intent remains the same: a deterministic
function, bounded execution, and JSON only.

## What “Safe” Does not Mean

A jail is a boundary, not an assertion that all output is good.

No package makes a hostile script produce trustworthy output. Applications must still:

- Validate returned structure and value ranges.
- Clamp numbers and collection sizes.
- Escape or sanitize data before rendering HTML or SVG.
- Apply application-level rate limits.
- Use a WorkerJail in a browser when UI responsiveness matters.

And neither sandbox is a replacement for a threat model. These tools reduce host access and interrupt runaway code,
but browser, Node, and WebAssembly have different platforms and guarantees.

## Choosing an Approach

- Choose `@js-jail/node` for macOS server execution and defense in depth.
- Choose `@js-jail/wasm` for Node, browser, or Web Worker portability.
- Choose `@js-jail/wasm` with `WorkerJail` when browser code must never block the main thread.

Together, they offer a practical answer to a modern problem: letting JavaScript express useful work without letting
it directly own the host.

## How It Differs from Existing Approaches

Running untrusted JavaScript is not a new problem. The existing choices are generally more mature than `js-jail`,
and in many cases they provide stronger or broader isolation:

- **`isolated-vm`** gives Node applications direct access to V8 isolates and is the migration option recommended
  by the discontinued `vm2` project. Its maintainer warns that isolating V8 does not remove all risk: scripts can
  crash or hang, and objects handed to untrusted code can become bridges back into the host. The project is now in
  maintenance mode. [isolated-vm on GitHub](https://github.com/laverdet/isolated-vm)
- **`vm2`** is a much-used proxy-based Node sandbox, but it has been discontinued. Its own README says it contains
  critical security issues and should not be used in production. Node's `vm` module is also explicit: it is not a
  security mechanism. [vm2 on GitHub](https://github.com/patriksimek/vm2) |
  [Node `vm` documentation](https://nodejs.org/api/vm.html)
- **Deno** removes file, network, environment, and subprocess access by default. It is a stronger general runtime
  default than Node, but Deno's own security documentation warns against completely untrusted code and describes
  Web Workers and permissions as operating at specific privilege levels. Native FFI and subprocess permissions can
  also bypass or escape the intended boundary. [Deno security documentation](https://docs.deno.com/runtime/fundamentals/security/)
- **Cloudflare Workers** are purpose-built multi-tenant infrastructure. They use V8 isolates, carefully constrain APIs,
  add process isolation for sensitive workloads, and are designed around side-channel resistance. A local or
  user-managed setup does not automatically include every hosted defense. This is a much more advanced platform than
  a library wrapping a single JavaScript runtime.
  [Cloudflare Workers security model](https://developers.cloudflare.com/workers/reference/security-model/)
- **Browser iframes and Web Workers** solve a different part of the problem. A sandboxed iframe is a browser browsing
  context with origin and permission-policy controls. A Worker can run code outside the page thread and can be
  terminated, but workers remain browser-hosted JavaScript threads rather than an interpreter such as QuickJS.
  [MDN: iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe) |
  [MDN: Worker](https://developer.mozilla.org/en-US/docs/Web/API/Worker)

The `js-jail` Node package is not claiming that V8 contexts or Node's permission model are individually secure.
Node explicitly says that its `vm` module is not a security boundary and that the permission model is a seat belt,
not a guarantee against malicious code. [Node permission documentation](https://nodejs.org/api/permissions.html)
The package combines context restrictions, a permission-disabled child process, and macOS `sandbox-exec`, but it is
an application-specific boundary with some important limits: it is macOS-focused, it does not provide OS isolation
when that layer is unavailable, and it cannot turn a V8 bug or kernel exploit into a solved problem.

The WASM package is built on `quickjs-emscripten`, an existing library that is designed to evaluate untrusted JavaScript
and supports memory limits and interrupt handlers. It differs from a V8 isolate primarily by using another engine and
by making no host objects available. That is a useful portability and API-surface reduction, not a proof that QuickJS
or WebAssembly is automatically safer. `js-jail` adds runtimes per script, JSON marshalling, deterministic randomness,
timeouts, worker termination, failure limits, and a common contract. It does not introduce a new JavaScript engine or
claim the protections of a mature hosted isolate platform.
[`quickjs-emscripten` documentation](https://github.com/justjake/quickjs-emscripten)

In short, `js-jail` is best understood as a small, opinionated wrapper around established isolation primitives:

| Approach | Relative strength |
| --- | --- |
| `vm` or `vm2` alone | Not sufficient for hostile code |
| `@js-jail/node` | Defense in depth on macOS; still host and V8 dependent |
| `@js-jail/wasm` | Portable interpreter boundary with strict limits; no host bridge |
| `isolated-vm` | A stronger V8-native Node isolate library, but maintenance caveats and careful host exposure remain |
| Deno permissions | Strong runtime defaults for trusted and moderately restricted applications |
| Cloudflare Workers / sandboxed iframe | Mature platform or browser boundary for its intended environment |

For high-value, adversarial workloads, the strongest available choice is usually not one npm package alone. It is
likely a mature isolate or platform combined with an OS container or VM boundary, kernel and engine updates,
separate processes or hosts for critical services, and application-level data validation.

**Packages:** [`@js-jail/node`](node/README.md) and [`@js-jail/wasm`](wasm/README.md)  
**Repository:** [js-jail](README.md)  
**License:** MIT
