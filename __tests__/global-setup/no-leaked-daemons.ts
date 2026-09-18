/**
 * Fail the run when a suite leaves a CodeGraph process behind.
 *
 * The spawn-based suites start real daemons on throwaway projects, and a
 * daemon is detached on purpose: killing the launcher does not kill it, so a
 * missed `afterEach` leaves a process holding a temp project that the test
 * just deleted. Nothing in the run notices — the suites stay green and the
 * machine accumulates one stray daemon per run until someone looks at `ps`.
 *
 * Only processes that appeared DURING the run and are anchored to a temp
 * directory count. A developer's own daemon, serving a real repo, is running
 * on the same machine while the suite executes and must never fail it.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

/** Roots a throwaway test project can live under; a real repo lives nowhere near. */
const TEMP_ROOTS = [os.tmpdir(), '/tmp', '/var/folders', '/private/var/folders']
  .map((p) => p.replace(/\/+$/, ''))
  .filter((p) => p.length > 0);

/** Give a daemon that is already shutting down a moment before accusing it. */
const SETTLE_TIMEOUT_MS = 3000;
const SETTLE_POLL_MS = 200;

function run(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // Non-zero exit is the normal "no matches" answer from pgrep, and a
    // missing tool must never fail a test run.
    return null;
  }
}

function processArgs(pid: number): string | null {
  const out = run('ps', ['-p', String(pid), '-o', 'args=']);
  return out ? out.trim() : null;
}

/** Best-effort cwd: a daemon spawned with `cwd` in a temp dir carries no path in its args. */
function processCwd(pid: number): string | null {
  if (process.platform === 'linux') {
    try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
  }
  const out = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  if (!out) return null;
  const line = out.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

function underTempRoot(value: string | null): boolean {
  if (!value) return false;
  return TEMP_ROOTS.some((root) => value.includes(`${root}/`));
}

/** Live CodeGraph processes anchored to a temp project, keyed by pid. */
function findTestOwnedProcesses(): Map<number, string> {
  const found = new Map<number, string>();
  if (process.platform === 'win32') return found; // no pgrep/lsof to lean on
  const listed = run('pgrep', ['-f', 'codegraph']);
  if (!listed) return found;
  for (const raw of listed.split('\n')) {
    const pid = Number(raw.trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    const args = processArgs(pid);
    if (!args || !args.includes('codegraph')) continue;
    if (underTempRoot(args) || underTempRoot(processCwd(pid))) found.set(pid, args);
  }
  return found;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let before = new Map<number, string>();

export function setup(): void {
  before = findTestOwnedProcesses();
}

export async function teardown(): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let leaked = new Map<number, string>();
  for (;;) {
    leaked = new Map([...findTestOwnedProcesses()].filter(([pid]) => !before.has(pid)));
    if (leaked.size === 0 || Date.now() > deadline) break;
    await sleep(SETTLE_POLL_MS);
  }
  if (leaked.size === 0) return;

  const lines = [...leaked].map(([pid, args]) => `  pid ${pid}: ${args.slice(0, 160)}`);
  throw new Error(
    `The test run leaked ${leaked.size} CodeGraph process(es) on temp projects.\n` +
    `${lines.join('\n')}\n` +
    'A detached daemon outlives the launcher, so the suite that spawned it must reap it — ' +
    'see the writer.pid reaping in __tests__/mcp-writer-lock.test.ts.\n' +
    `Kill them with: kill ${[...leaked.keys()].join(' ')}\n`
  );
}
