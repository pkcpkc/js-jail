# js-jail

Run JavaScript you do not trust. `js-jail` provides two packages for executing model-generated or user-supplied code
without giving that code direct access to the host. It is intended for short, pure JavaScript functions: pass JSON
data in, receive JSON data out, and treat the result as untrusted.

A script defines one function, such as `main`, and is called once per input with a seeded `rand()` function. Both
packages use the same API, seeded random behavior, and JSON-only contract, so browser previews and server results can
stay in agreement.

## Node approach

[`@js-jail/node`](node/README.md) is the server-side package for macOS and Node 25+. It combines a fresh `vm` context,
withheld Node permissions, and an optional macOS seatbelt profile. It uses a warm worker, request and call timeouts,
memory limits, and bounded answers.

Use this when code runs on a macOS server and defense in depth is more important than portability.

## WASM approach

[`@js-jail/wasm`](wasm/README.md) runs QuickJS compiled to WebAssembly. It works in Node, browser pages, and Web
Workers, and is fully embedded, so no separate `.wasm` file needs to be served. Each script gets its own runtime with
time, memory, and stack limits. `WorkerJail` keeps script execution off the browser's main thread.

Use this when the same jail must run in different JavaScript hosts or when browser-side previews are required.

## Install

```sh
npm install @js-jail/node       # macOS/Node server
npm install @js-jail/wasm       # Node, browser, or Web Worker
```

See the package readmes for complete examples and options:

- [`@js-jail/node`](node/README.md)
- [`@js-jail/wasm`](wasm/README.md)

No package gives an untrusted script a host filesystem, network, subprocess, DOM, or database connection. Neither
package validates or sanitizes the returned JSON: applications must validate, clamp, and safely render values.

## Develop locally

```sh
npm install      # both packages, and builds their dist/ (prepare)
npm run check    # typecheck, build, and every test
npm test         # Vitest, both packages; or `npm test` in node/ or wasm/
```

A project uses a package from a checkout next to it as `"@js-jail/node": "file:../js-jail/node"`. Run `npm install`
here first: the packages are used from their built `dist/`.

## License

MIT. See [LICENSE](LICENSE).
