/**
 * Issue #1740 — concurrent direct-mode serve --mcp must fail fast on the
 * second writer instead of silently degrading auto-sync.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { once } from 'events';
import { CodeGraph } from '../src';
import { getTakeoverRequestPath, getWriterPidPath } from '../src/mcp/writer-lock';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface WriterLockFile { pid: number; mode: string }

/**
 * Spawn the detached shared daemon directly. `Daemon.stop()` always calls
 * `process.exit`, so an in-process daemon cannot be torn down inside a test —
 * the daemon has to be a child, as it is in production.
 */
function spawnDaemon(cwd: string): { child: ChildProcessWithoutNullStreams; getStderr: () => string } {
  return spawnMcp(cwd, { CODEGRAPH_DAEMON_INTERNAL: '1' });
}

/**
 * A REAL in-process fallback engine: holds writer.pid in `fallback` mode AND
 * runs a watcher. The stand-in holders elsewhere in this file cannot watch
 * files, which is fine for "does the daemon get the lock" but useless for
 * "does the yielded engine watch again".
 *
 * Driven straight out of dist/ because the engine's lazy `require('../index')`
 * resolves only in the compiled build, not under the test transform.
 */
function spawnFallbackEngine(
  root: string,
  env: NodeJS.ProcessEnv,
): { child: ChildProcessWithoutNullStreams; getStderr: () => string } {
  const child = spawn(
    process.execPath,
    [
      '-e',
      'const {MCPEngine}=require(process.argv[1]);' +
      'const e=new MCPEngine({watch:true});' +
      'e.ensureInitialized(process.argv[2])' +
      '.catch((err)=>{process.stderr.write("INIT FAILED: "+err.message+"\\n")});' +
      'setInterval(()=>{},1000);',
      path.resolve(__dirname, '../dist/mcp/engine.js'),
      root,
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      // FORCE_WATCH keeps the watcher assertions honest on hosts where
      // watch-policy would otherwise opt out (WSL /mnt).
      env: { ...process.env, CODEGRAPH_FORCE_WATCH: '1', ...env },
    },
  ) as ChildProcessWithoutNullStreams;
  child.on('error', () => {});
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
  return { child, getStderr: () => stderr };
}

/** Poll writer.pid until `pred` holds, so we don't race the handover. */
async function waitForLock(
  lockPath: string,
  pred: (lock: WriterLockFile) => boolean,
  timeoutMs: number,
): Promise<WriterLockFile> {
  const deadline = Date.now() + timeoutMs;
  let last: WriterLockFile | null = null;
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as WriterLockFile;
      if (pred(last)) return last;
    } catch { /* mid-write or absent */ }
    await sleep(50);
  }
  throw new Error(`writer.pid never satisfied the predicate (last: ${JSON.stringify(last)})`);
}

function spawnMcp(
  cwd: string,
  env: NodeJS.ProcessEnv,
): { child: ChildProcessWithoutNullStreams; getStderr: () => string } {
  const child = spawn(process.execPath, [BIN, 'serve', '--mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  }) as ChildProcessWithoutNullStreams;
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
  child.stdout.on('data', () => {});
  return { child, getStderr: () => stderr };
}

describe('issue #1740 — direct-mode writer lock', () => {
  let tempDir: string;
  let realRoot: string;
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg1740-mcp-'));
    realRoot = fs.realpathSync(tempDir);
    fs.mkdirSync(path.join(realRoot, 'src'));
    fs.writeFileSync(path.join(realRoot, 'src/a.ts'), 'export function a() { return 1; }\n');
    const cg = await CodeGraph.init(realRoot);
    await cg.indexAll();
    cg.close();
  });

  afterEach(async () => {
    // The launcher re-execs into a detached daemon, so killing the child we
    // spawned leaves that daemon behind holding a temp project that is about
    // to be deleted. Take the pid off writer.pid before the tree goes.
    let detached: number | null = null;
    try {
      const lock = JSON.parse(
        fs.readFileSync(getWriterPidPath(realRoot), 'utf8'),
      ) as WriterLockFile;
      if (lock.mode === 'daemon' && lock.pid > 0) detached = lock.pid;
    } catch { /* no lock, or already cleaned up */ }

    for (const c of children) {
      try { c.kill('SIGTERM'); } catch { /* ignore */ }
    }
    children.length = 0;
    if (detached !== null && !children.some((c) => c.pid === detached)) {
      try { process.kill(detached, 'SIGTERM'); } catch { /* already gone */ }
    }
    await sleep(300);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('second CODEGRAPH_NO_DAEMON serve --mcp exits with writer-lock error', async () => {
    const env = {
      CODEGRAPH_NO_DAEMON: '1',
      CODEGRAPH_MCP_DEBUG: '1',
      CODEGRAPH_NO_WATCHDOG: '1',
      CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS: '0',
      // Avoid wasm --liftoff-only re-exec so lock.pid matches the spawned pid.
      CODEGRAPH_NO_RELAUNCH: '1',
      CODEGRAPH_WASM_RELAUNCHED: '1',
    };
    const first = spawnMcp(realRoot, env);
    children.push(first.child);

    const lockPath = getWriterPidPath(realRoot);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !fs.existsSync(lockPath)) {
      await sleep(50);
    }
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(first.child.exitCode).toBeNull();

    const second = spawnMcp(realRoot, env);
    children.push(second.child);

    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(second.child.exitCode), 10000);
      second.child.on('close', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });

    expect(code).toBe(1);
    expect(second.getStderr()).toMatch(/writer lock held/i);
    expect(second.getStderr()).toMatch(/CODEGRAPH_NO_DAEMON/);
    expect(first.child.exitCode).toBeNull();
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number };
    expect(lock.pid).toBe(first.child.pid);
  }, 20000);

  it('default daemon mode still allows two proxies to share one writer', async () => {
    const env = {
      CODEGRAPH_MCP_LOG_ATTACH: '1',
      CODEGRAPH_NO_WATCHDOG: '1',
      CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS: '0',
      CODEGRAPH_NO_RELAUNCH: '1',
      CODEGRAPH_WASM_RELAUNCHED: '1',
    };
    const a = spawnMcp(realRoot, env);
    const b = spawnMcp(realRoot, env);
    children.push(a.child, b.child);

    const lockPath = getWriterPidPath(realRoot);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !fs.existsSync(lockPath)) {
      await sleep(50);
    }
    expect(fs.existsSync(lockPath)).toBe(true);
    await sleep(1000);
    expect(a.child.exitCode).toBeNull();
    expect(b.child.exitCode).toBeNull();

    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number; mode: string };
    expect(lock.mode).toBe('daemon');
    expect(lock.pid).not.toBe(a.child.pid);
    expect(lock.pid).not.toBe(b.child.pid);
  }, 25000);

  it('daemon reclaims the writer lock from a live fallback holder', async () => {
    const lockPath = getWriterPidPath(realRoot);
    const reqPath = getTakeoverRequestPath(realRoot);

    // Stand-in for a degraded in-process engine: holds writer.pid in
    // `fallback` mode and drops it when a daemon asks, exactly as the engine's
    // takeover poll now does. It stays alive afterwards — the point is that a
    // LIVE holder no longer blocks the daemon forever.
    const holder = spawn(
      process.execPath,
      [
        '-e',
        'const fs=require("fs");const [w,t]=process.argv.slice(1);let done=false;' +
        'setInterval(()=>{if(!done&&fs.existsSync(t)){done=true;try{fs.unlinkSync(w)}catch(e){}}},25);',
        lockPath,
        reqPath,
      ],
      { stdio: 'ignore' },
    ) as ChildProcessWithoutNullStreams;
    children.push(holder);
    if (!holder.pid) throw new Error('Failed to spawn fallback holder');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: holder.pid, mode: 'fallback', startedAt: Date.now() }) + '\n',
    );

    // Before the fix this daemon died here: a live holder is never stolen
    // from, so it exited and every later client fell back too.
    const daemon = spawnDaemon(realRoot);
    children.push(daemon.child);

    const lock = await waitForLock(lockPath, (l) => l.mode === 'daemon', 15000);
    expect(lock.mode).toBe('daemon');
    // Not the pid we spawned: the launcher re-execs into the detached daemon.
    expect(lock.pid).not.toBe(holder.pid);
    expect(() => process.kill(lock.pid, 0)).not.toThrow();
    // The request must not outlive the handover.
    expect(fs.existsSync(reqPath)).toBe(false);
  }, 25000);

  it('daemon still refuses when the fallback holder never answers', async () => {
    const lockPath = getWriterPidPath(realRoot);

    // A holder that ignores the request — an older build, or a wedged loop.
    const holder = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    ) as ChildProcessWithoutNullStreams;
    children.push(holder);
    if (!holder.pid) throw new Error('Failed to spawn fallback holder');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: holder.pid, mode: 'fallback', startedAt: Date.now() }) + '\n',
    );

    const daemon = spawnDaemon(realRoot);
    children.push(daemon.child);
    await once(daemon.child, 'exit');

    // The holder keeps what it had, and no request is left lying around for
    // whoever holds the lock next.
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number; mode: string };
    expect(lock.pid).toBe(holder.pid);
    expect(lock.mode).toBe('fallback');
    expect(fs.existsSync(getTakeoverRequestPath(realRoot))).toBe(false);
  }, 25000);

  /** Poll a predicate, so a slow box shows up as a timeout, not a wrong count. */
  async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred()) return;
      await sleep(25);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  /** Bring a fallback engine up and hand its writer slot to a fresh daemon. */
  async function handOverToDaemon(
    rearmPollMs: string,
  ): Promise<{
    fallback: { child: ChildProcessWithoutNullStreams; getStderr: () => string };
    watcherStarts: () => number;
    daemonPid: number;
  }> {
    const lockPath = getWriterPidPath(realRoot);
    const fallback = spawnFallbackEngine(realRoot, {
      CODEGRAPH_TAKEOVER_POLL_MS: '100',
      CODEGRAPH_REARM_POLL_MS: rearmPollMs,
    });
    children.push(fallback.child);
    const watcherStarts = (): number =>
      fallback.getStderr().split('File watcher active').length - 1;

    await waitForLock(lockPath, (l) => l.pid === fallback.child.pid && l.mode === 'fallback', 20000);
    await waitFor(() => watcherStarts() === 1, 15000, 'the fallback watcher to start');

    const daemon = spawnDaemon(realRoot);
    children.push(daemon.child);
    const daemonLock = await waitForLock(lockPath, (l) => l.mode === 'daemon', 20000);
    await sleep(500);
    expect(watcherStarts()).toBe(1);

    return { fallback, watcherStarts, daemonPid: daemonLock.pid };
  }

  it('a fallback engine watches again after the daemon it yielded to is killed', async () => {
    const lockPath = getWriterPidPath(realRoot);
    const { fallback, watcherStarts, daemonPid } = await handOverToDaemon('200');

    // SIGKILL: the harsh path, where writer.pid survives naming a dead process
    // and the re-arm has to recognise it as stale.
    process.kill(daemonPid, 'SIGKILL');

    // Before this fix nothing ever watched the project again: the engine had
    // cancelled its own poll on the way out, so the hand-over was one-way.
    const reclaimed = await waitForLock(lockPath, (l) => l.pid === fallback.child.pid, 20000);
    expect(reclaimed.mode).toBe('fallback');
    await waitFor(() => watcherStarts() === 2, 15000, 'the fallback watcher to restart');
    expect(fallback.getStderr()).toMatch(/Writer lock vacant again/);
  }, 90000);

  it('re-arms on a graceful daemon exit and catches up on what changed meanwhile', async () => {
    const lockPath = getWriterPidPath(realRoot);
    // A wide re-arm window, so the edit below provably lands while NOTHING is
    // watching instead of racing a fast poll.
    const { fallback, watcherStarts, daemonPid } = await handOverToDaemon('3000');

    // SIGTERM: what the daemon's 5-minute idle timeout actually does once its
    // last client disconnects — the common path, and the one the SIGKILL test
    // above cannot cover, because a graceful daemon RELEASES writer.pid.
    process.kill(daemonPid, 'SIGTERM');
    await waitFor(() => !fs.existsSync(lockPath), 20000, 'the daemon to release writer.pid');

    // No watcher exists anywhere for this project right now. An edit made in
    // this window is invisible to the graph until someone reconciles it, which
    // is the whole reason re-arming also re-runs catch-up.
    fs.writeFileSync(path.join(realRoot, 'src/b.ts'), 'export function b() { return 2; }\n');

    const reclaimed = await waitForLock(lockPath, (l) => l.pid === fallback.child.pid, 20000);
    expect(reclaimed.mode).toBe('fallback');
    await waitFor(() => watcherStarts() === 2, 15000, 'the fallback watcher to restart');
    await waitFor(
      () => /Caught up \d+ file\(s\) changed since last run/.test(fallback.getStderr()),
      20000,
      'the re-armed engine to catch up on the edit nobody watched',
    );
  }, 90000);
});
