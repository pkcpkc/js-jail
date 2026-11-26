import fs from 'fs';

/** Layer 2's flags: Node's permission model with nothing allowed, no code from strings, a heap of `heapMb`. */
export const nodeFlags = (heapMb = 64): string[] => ['--permission', '--disallow-code-generation-from-strings', `--max-old-space-size=${heapMb}`, '--max-semi-space-size=2', '--no-warnings'];

/** The flags of layer 2 at the default heap. */
export const NODE_FLAGS = nodeFlags();

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Whether this machine has layer 3, the OS sandbox (macOS's sandbox-exec). */
export const hasSeatbelt = (): boolean => process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC);

/**
 * Layer 3, the macOS seatbelt profile: no network, no writes, no new processes, no reading the user's files or the
 * Keychain; Node itself may start (its binary and libraries) and stand in `cwd`, an empty folder.
 */
export function seatbeltProfile(node: string, cwd: string): string {
  const q = (p: string) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    '(allow file-write-data (literal "/dev/null"))',
    '(deny file-read* (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/private/etc") (subpath "/Library/Keychains"))',
    '(allow file-read-metadata)',
    `(allow file-read* (literal ${q(cwd)}))`,
    '(deny process-fork)',
    '(deny process-exec)',
    `(allow process-exec (literal ${q(node)}))`,
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.secd"))',
  ].join('\n');
}

/**
 * The command that starts `script` in the jail from `cwd` (an empty folder): this Node with layer 2's flags and the
 * script as `-e`, inside the OS sandbox when `seatbelt`. The jail starts its worker with it; tests start probes with it.
 */
export function jailCommand(script: string, cwd: string, seatbelt: boolean, heapMb = 64): { command: string; args: string[] } {
  const node = fs.realpathSync(process.execPath);
  const args = [...nodeFlags(heapMb), '-e', script];
  return seatbelt ? { command: SANDBOX_EXEC, args: ['-p', seatbeltProfile(node, cwd), node, ...args] } : { command: node, args };
}
