/**
 * Project writer lock (#1740) — unit coverage for acquire / re-entrant /
 * stale-dead-pid / live-holder refusal.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_REARM_POLL_MS, MCPEngine, parseRearmPollMs } from '../src/mcp/engine';
import {
  clearTakeoverRequest,
  decodeWriterLockInfo,
  getTakeoverRequestPath,
  getWriterPidPath,
  readTakeoverRequest,
  releaseWriterLock,
  requestWriterTakeover,
  takeoverRequestedFrom,
  TAKEOVER_REQUEST_TTL_MS,
  tryAcquireWriterLock,
  writerLockHeldMessage,
} from '../src/mcp/writer-lock';

describe('writer lock (#1740)', () => {
  let dir: string;
  let holder: ChildProcess | null = null;

  afterEach(() => {
    try { holder?.kill('SIGKILL'); } catch { /* already gone */ }
    holder = null;
    if (dir) {
      releaseWriterLock(dir);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function makeProject(): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg1740-lock-'));
    fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
    return dir;
  }

  it('acquires and releases writer.pid', () => {
    const root = makeProject();
    const r = tryAcquireWriterLock(root, 'direct');
    expect(r.kind).toBe('acquired');
    expect(fs.existsSync(getWriterPidPath(root))).toBe(true);
    const info = decodeWriterLockInfo(fs.readFileSync(getWriterPidPath(root), 'utf8'));
    expect(info?.pid).toBe(process.pid);
    expect(info?.mode).toBe('direct');
    releaseWriterLock(root);
    expect(fs.existsSync(getWriterPidPath(root))).toBe(false);
  });

  it('is re-entrant for the same pid', () => {
    const root = makeProject();
    expect(tryAcquireWriterLock(root, 'daemon').kind).toBe('acquired');
    const again = tryAcquireWriterLock(root, 'fallback');
    expect(again.kind).toBe('acquired');
    releaseWriterLock(root);
  });

  it('reports taken when a live foreign pid holds the lock', () => {
    const root = makeProject();
    // Use our own pid first, then overwrite with a fake live-looking pid by
    // writing a pid that is alive: process.pid of this test — simulate foreign
    // by writing a different alive pid. On Linux, PID 1 is almost always alive.
    fs.writeFileSync(
      getWriterPidPath(root),
      JSON.stringify({ pid: 1, mode: 'direct', startedAt: Date.now() }) + '\n',
      { flag: 'wx' },
    );
    const r = tryAcquireWriterLock(root, 'direct');
    expect(r.kind).toBe('taken');
    if (r.kind === 'taken') {
      expect(r.existing?.pid).toBe(1);
      const msg = writerLockHeldMessage(r.existing, r.pidPath);
      expect(msg).toMatch(/writer lock held/i);
      expect(msg).toMatch(/CODEGRAPH_NO_DAEMON/);
      expect(msg).toMatch(/daemon stop/);
    }
  });

  it('clamps the re-arm cadence and honours the opt-out', () => {
    expect(parseRearmPollMs(undefined)).toBe(DEFAULT_REARM_POLL_MS);
    expect(parseRearmPollMs('   ')).toBe(DEFAULT_REARM_POLL_MS);
    expect(parseRearmPollMs('nope')).toBe(DEFAULT_REARM_POLL_MS);
    expect(parseRearmPollMs('1.5')).toBe(DEFAULT_REARM_POLL_MS);
    expect(parseRearmPollMs('5000')).toBe(5000);
    // Opt out, restoring "yield once, never watch again".
    expect(parseRearmPollMs('0')).toBe(0);
    expect(parseRearmPollMs('-1')).toBe(0);
    // Out of range reads as a misconfiguration, not a value to cap silently.
    expect(parseRearmPollMs('10')).toBe(DEFAULT_REARM_POLL_MS);
    expect(parseRearmPollMs('99999999')).toBe(DEFAULT_REARM_POLL_MS);
  });

  it('clears a stale dead-pid lock and acquires', () => {
    const root = makeProject();
    // Pick a pid that is extremely unlikely to be alive.
    const deadPid = 2147483646;
    fs.writeFileSync(
      getWriterPidPath(root),
      JSON.stringify({ pid: deadPid, mode: 'direct', startedAt: Date.now() }) + '\n',
    );
    const r = tryAcquireWriterLock(root, 'direct');
    expect(r.kind).toBe('acquired');
    releaseWriterLock(root);
  });

  it('lets a fallback engine atomically claim and release writer ownership', () => {
    const root = makeProject();
    const engine = new MCPEngine({ writerLockRoot: root });

    expect(decodeWriterLockInfo(fs.readFileSync(getWriterPidPath(root), 'utf8'))).toMatchObject({
      pid: process.pid,
      mode: 'fallback',
    });

    engine.stop();
    expect(fs.existsSync(getWriterPidPath(root))).toBe(false);
  });

  it('rejects a fallback engine before opening when another process owns writer.pid', () => {
    const root = makeProject();
    holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    if (!holder.pid) throw new Error('Failed to spawn writer-lock holder');
    fs.writeFileSync(
      getWriterPidPath(root),
      JSON.stringify({ pid: holder.pid, mode: 'daemon', startedAt: Date.now() }) + '\n',
    );

    expect(() => new MCPEngine({ writerLockRoot: root })).toThrow(/writer lock held/i);
  });

  describe('cooperative takeover', () => {
    const DEAD_PID = 2147483646;

    it('asks only the named holder to yield', () => {
      const root = makeProject();
      requestWriterTakeover(root, 4242);

      expect(takeoverRequestedFrom(root, 4242)).toBe(true);
      // A holder that is not the target must keep its lock — otherwise a
      // request left over from an earlier holder would strip the next one.
      expect(takeoverRequestedFrom(root, 4243)).toBe(false);

      const req = readTakeoverRequest(root);
      expect(req).toMatchObject({ pid: process.pid, target: 4242 });
    });

    it('ignores a request whose requester has died', () => {
      const root = makeProject();
      fs.writeFileSync(
        getTakeoverRequestPath(root),
        JSON.stringify({ pid: DEAD_PID, target: process.pid, requestedAt: Date.now() }) + '\n',
      );
      // Standing down for a daemon that is gone would cost the watcher and
      // hand it to nobody.
      expect(takeoverRequestedFrom(root, process.pid)).toBe(false);
    });

    it('ignores a request older than the TTL', () => {
      const root = makeProject();
      fs.writeFileSync(
        getTakeoverRequestPath(root),
        JSON.stringify({
          pid: process.pid,
          target: process.pid,
          requestedAt: Date.now() - (TAKEOVER_REQUEST_TTL_MS + 1_000),
        }) + '\n',
      );
      expect(takeoverRequestedFrom(root, process.pid)).toBe(false);
    });

    it('ignores an unreadable request file', () => {
      const root = makeProject();
      fs.writeFileSync(getTakeoverRequestPath(root), 'not json\n');
      expect(readTakeoverRequest(root)).toBeNull();
      expect(takeoverRequestedFrom(root, process.pid)).toBe(false);
    });

    it('clears a request', () => {
      const root = makeProject();
      requestWriterTakeover(root, process.pid);
      expect(fs.existsSync(getTakeoverRequestPath(root))).toBe(true);
      clearTakeoverRequest(root);
      expect(fs.existsSync(getTakeoverRequestPath(root))).toBe(false);
      expect(takeoverRequestedFrom(root, process.pid)).toBe(false);
    });

    it('lets a daemon through once the fallback holder stands down', () => {
      const root = makeProject();
      // A live foreign process holding the lock in the degraded mode.
      holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      if (!holder.pid) throw new Error('Failed to spawn writer-lock holder');
      const holderPid = holder.pid;
      fs.writeFileSync(
        getWriterPidPath(root),
        JSON.stringify({ pid: holderPid, mode: 'fallback', startedAt: Date.now() }) + '\n',
      );

      // Before the fix this was terminal for the daemon: a live holder is
      // never stolen from, so it exited and the project stayed degraded.
      expect(tryAcquireWriterLock(root, 'daemon').kind).toBe('taken');

      requestWriterTakeover(root, holderPid);
      expect(takeoverRequestedFrom(root, holderPid)).toBe(true);

      // What the holder's poll does when it sees the request.
      releaseWriterLockAs(root, holderPid);

      const reclaimed = tryAcquireWriterLock(root, 'daemon');
      expect(reclaimed.kind).toBe('acquired');
      clearTakeoverRequest(root);
      expect(
        decodeWriterLockInfo(fs.readFileSync(getWriterPidPath(root), 'utf8')),
      ).toMatchObject({ pid: process.pid, mode: 'daemon' });
      releaseWriterLock(root);
    });
  });
});

/**
 * `releaseWriterLock` only drops a lock this process owns, so a test standing
 * in for another process's release has to remove the file itself.
 */
function releaseWriterLockAs(root: string, pid: number): void {
  const raw = fs.readFileSync(getWriterPidPath(root), 'utf8');
  if (decodeWriterLockInfo(raw)?.pid !== pid) throw new Error('not the expected holder');
  fs.unlinkSync(getWriterPidPath(root));
}
