import type { EngineConfig, EngineResults } from './engine.js';

/** One call of a script's entry function: its input (JSON-able) and the seed of its `rand()`. */
export interface JailCall {
  input: unknown;
  seed?: number;
}

/** What a call answered (its JSON, parsed), or why it has no answer. */
export type JailResult = { value: unknown } | { error: string };

/** What both jails take: how the engine runs a script, and when a script is refused. */
export interface EngineOptions {
  /** The function a script must define, called once per call with its input. Default `main`. */
  entry?: string;
  /** When set, an object input gets the call's seeded `rand()` under this key. */
  inputRand?: string;
  /** Globals deleted from every context (default: shared memory, weak references; `Date` is never built in). */
  removeGlobals?: string[];
  /** A call's time and a script's load time (ms). */
  callMs?: number;
  loadMs?: number;
  /** One script's memory (MB) and stack (KB, at most `MAX_STACK_KB`: QuickJS's stack is the host's own). */
  memoryMb?: number;
  stackKb?: number;
  /** One answer's longest JSON. */
  maxAnswer?: number;
  /** Scripts kept loaded. */
  keep?: number;
  /** After this many failed requests (out of memory, over time, a crash) a script is refused. */
  maxFailures?: number;
  /** Told what went wrong (a timeout, a crash). */
  onWarn?: (message: string) => void;
}

export const ENGINE_DEFAULTS: EngineConfig & { maxFailures: number } = {
  entry: 'main',
  removeGlobals: ['SharedArrayBuffer', 'Atomics', 'WeakRef', 'FinalizationRegistry', 'WebAssembly'],
  callMs: 50,
  loadMs: 200,
  memoryMb: 32,
  stackKb: 192,
  maxAnswer: 65536,
  keep: 8,
  maxFailures: 3,
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The deepest stack a script may get. In WebAssembly, QuickJS recurses on the host's own stack: past about 300 KB the
 * host's limit comes first and breaks the module instead of QuickJS throwing a catchable stack overflow.
 */
export const MAX_STACK_KB = 256;

/** The engine's config from a jail's options, its names checked: they go into the prelude's source. */
export function engineConfig(options: EngineOptions): EngineConfig {
  const { entry, inputRand, removeGlobals, callMs, loadMs, memoryMb, stackKb, maxAnswer, keep } = { ...ENGINE_DEFAULTS, ...options };
  if (!IDENTIFIER.test(entry)) throw new Error(`The entry must be an identifier, not "${entry}"`);
  if (inputRand !== undefined && !IDENTIFIER.test(inputRand)) throw new Error(`inputRand must be an identifier, not "${inputRand}"`);
  if (!(stackKb > 0 && stackKb <= MAX_STACK_KB)) throw new Error(`stackKb must be between 1 and ${MAX_STACK_KB}, not ${stackKb}`);
  return { entry, ...(inputRand ? { inputRand } : {}), removeGlobals, callMs, loadMs, memoryMb, stackKb, maxAnswer, keep };
}

/** The engine's answers as results: JSON parsed, a thrown value as an error. Still untrusted data. */
export function toResults(raw: EngineResults, entry: string): JailResult[] {
  return raw.map((answer): JailResult => {
    if (typeof answer !== 'string') return { error: answer.error };
    let value: unknown;
    try {
      value = JSON.parse(answer);
    } catch {
      return { error: `${entry}() answered something that is not JSON` };
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && '__error' in value) return { error: `${entry}() threw: ${String((value as { __error: unknown }).__error)}` };
    return { value };
  });
}

/** Counts failed requests per script, and refuses one that failed `max` times. */
export class Failures {
  private readonly counts = new Map<string, number>();
  constructor(private readonly max: number) {}
  refused(code: string): boolean {
    return (this.counts.get(code) ?? 0) >= this.max;
  }
  add(code: string): void {
    this.counts.set(code, (this.counts.get(code) ?? 0) + 1);
  }
}

export const REFUSED = 'This script failed too often and is not run again';
