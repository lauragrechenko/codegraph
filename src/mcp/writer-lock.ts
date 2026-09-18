/**
 * Project writer lock (#1740).
 *
 * At most one long-lived MCP *writer* (shared daemon OR direct-mode /
 * in-process engine that owns the FileWatcher) may serve a given project.
 * The shared daemon already multiplexes N stdio proxies onto one writer; this
 * lock closes the same-OS gap where two direct-mode `serve --mcp` processes
 * (via `CODEGRAPH_NO_DAEMON=1` or proxy→in-process fallback) each start a
 * watcher, contend on `codegraph.lock`, and degrade auto-sync.
 *
 * Deliberately separate from `daemon.pid`: proxies probe the daemon socket
 * and may clear a live pid that has no socket. A direct-mode holder must not
 * look like a daemon. `writer.pid` is only about "who owns live auto-sync".
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from '../directory';
/** Signal-0 liveness (EPERM ⇒ alive). Local copy to avoid a daemon↔writer cycle. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EPERM') return true;
    return false;
  }
}


/** Absolute path to the writer pid lockfile for `projectRoot`. */
export function getWriterPidPath(projectRoot: string): string {
  let root = projectRoot;
  try { root = fs.realpathSync(projectRoot); } catch { /* keep lexical */ }
  return path.join(getCodeGraphDir(root), 'writer.pid');
}

/** Structured contents of the writer pidfile. */
export interface WriterLockInfo {
  pid: number;
  /** `direct` | `daemon` | `fallback` — for actionable error text only. */
  mode: string;
  startedAt: number;
}

export type WriterAcquireResult =
  | { kind: 'acquired'; pidPath: string; info: WriterLockInfo }
  | { kind: 'taken'; existing: WriterLockInfo | null; pidPath: string };

function encode(info: WriterLockInfo): string {
  return JSON.stringify(info) + '\n';
}

export function decodeWriterLockInfo(raw: string): WriterLockInfo | null {
  try {
    const parsed = JSON.parse(raw.trim()) as Partial<WriterLockInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.mode !== 'string') return null;
    return {
      pid: parsed.pid,
      mode: parsed.mode,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Atomically create `writer.pid` (link-into-place, O_EXCL fallback). If held
 * by a dead PID, clear and retry once. Does not steal from a live holder.
 */
export function tryAcquireWriterLock(
  projectRoot: string,
  mode: string,
): WriterAcquireResult {
  const pidPath = getWriterPidPath(projectRoot);
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });

  const info: WriterLockInfo = {
    pid: process.pid,
    mode,
    startedAt: Date.now(),
  };

  const attempt = (): WriterAcquireResult => {
    const tmp = `${pidPath}.${process.pid}.tmp`;
    let acquired = false;
    try {
      fs.writeFileSync(tmp, encode(info), { mode: 0o600 });
      try {
        fs.linkSync(tmp, pidPath);
        acquired = true;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          // taken
        } else {
          // No hard links — O_EXCL create.
          try {
            const fd = fs.openSync(pidPath, 'wx', 0o600);
            try {
              fs.writeSync(fd, encode(info));
              acquired = true;
            } finally {
              fs.closeSync(fd);
            }
          } catch (e2: unknown) {
            if ((e2 as NodeJS.ErrnoException).code !== 'EEXIST') throw e2;
          }
        }
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }

    if (acquired) return { kind: 'acquired', pidPath, info };

    let existing: WriterLockInfo | null = null;
    try {
      existing = decodeWriterLockInfo(fs.readFileSync(pidPath, 'utf8'));
    } catch { /* unreadable */ }
    return { kind: 'taken', existing, pidPath };
  };

  let result = attempt();
  if (result.kind === 'taken' && result.existing && result.existing.pid === process.pid) {
    // Same process already holds it (daemon acquired before engine watch).
    return { kind: 'acquired', pidPath: result.pidPath, info: result.existing };
  }
  if (result.kind === 'taken') {
    const existing = result.existing;
    if (!existing || existing.pid <= 0 || !isProcessAlive(existing.pid)) {
      // Stale — clear (pid-verified) and retry once.
      try {
        const raw = fs.readFileSync(pidPath, 'utf8');
        const cur = decodeWriterLockInfo(raw);
        if (!cur || cur.pid === existing?.pid) {
          if (!cur || cur.pid <= 0 || !isProcessAlive(cur.pid)) {
            fs.unlinkSync(pidPath);
          }
        }
      } catch { /* ENOENT ok */ }
      result = attempt();
    }
  }
  return result;
}

/** Release if we still own the lock (pid match). */
export function releaseWriterLock(projectRoot: string): void {
  const pidPath = getWriterPidPath(projectRoot);
  try {
    if (!fs.existsSync(pidPath)) return;
    const info = decodeWriterLockInfo(fs.readFileSync(pidPath, 'utf8'));
    if (info && info.pid === process.pid) {
      fs.unlinkSync(pidPath);
    }
  } catch { /* best-effort */ }
}

/** Read current lock without acquiring. */
export function readWriterLock(projectRoot: string): WriterLockInfo | null {
  const pidPath = getWriterPidPath(projectRoot);
  try {
    return decodeWriterLockInfo(fs.readFileSync(pidPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Actionable message when another live process owns the writer lock (#1740).
 */
export function writerLockHeldMessage(
  existing: WriterLockInfo | null,
  pidPath: string,
): string {
  const who = existing && existing.pid > 0
    ? `PID ${existing.pid} (${existing.mode || 'unknown'} mode)`
    : 'another process';
  return (
    'CodeGraph writer lock held by ' + who + '. ' +
    'Only one live MCP writer may serve a project (auto-sync / index). ' +
    'Stop the other server (codegraph daemon stop if a shared daemon, or end the other MCP session), ' +
    'or unset CODEGRAPH_NO_DAEMON so additional clients proxy to the shared daemon. ' +
    'If this is stale, delete ' + pidPath
  );
}

/* ------------------------------------------------------------------ *
 * Cooperative takeover
 *
 * `fallback` is the degraded path: an in-process engine that could not
 * reach a shared daemon. Because the lock is never stolen from a live
 * holder, a fallback holder used to block the daemon *permanently* — the
 * daemon would spawn, lose the lock, and exit, so every later client also
 * fell back. One degraded session pinned the whole project to the degraded
 * path until someone deleted writer.pid by hand.
 *
 * The daemon therefore asks the fallback holder to stand down rather than
 * taking the lock away from it. A request is a file naming both parties;
 * the holder polls, drops its watcher, and releases. Two properties matter:
 *
 *   - We never signal a pid. Signalling a recycled pid would kill an
 *     unrelated process (SIGUSR2 terminates by default), and a fallback
 *     holder has no socket to verify identity against — the same hazard
 *     `canProbeDaemonIdentity` exists to avoid for daemons.
 *   - `target` pins the request to one holder, so a request left behind by
 *     a crashed daemon cannot make the *next* holder yield.
 *
 * A holder that never yields (old build, wedged event loop) just leaves the
 * daemon to time out and behave exactly as it did before.
 * ------------------------------------------------------------------ */

/** Absolute path to the takeover-request file for `projectRoot`. */
export function getTakeoverRequestPath(projectRoot: string): string {
  let root = projectRoot;
  try { root = fs.realpathSync(projectRoot); } catch { /* keep lexical */ }
  return path.join(getCodeGraphDir(root), 'writer.takeover');
}

/** A daemon's standing request that `target` release the writer lock. */
export interface TakeoverRequest {
  /** The requesting daemon. */
  pid: number;
  /** The holder being asked to yield — matched against writer.pid. */
  target: number;
  requestedAt: number;
}

/** Requests come from a daemon that is about to retry; stale ones are ignored. */
export const TAKEOVER_REQUEST_TTL_MS = 30_000;

export function requestWriterTakeover(projectRoot: string, targetPid: number): void {
  const reqPath = getTakeoverRequestPath(projectRoot);
  const body: TakeoverRequest = {
    pid: process.pid,
    target: targetPid,
    requestedAt: Date.now(),
  };
  try {
    fs.mkdirSync(path.dirname(reqPath), { recursive: true });
    // Write-then-rename: a holder must never read a half-written record.
    const tmp = `${reqPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, reqPath);
  } catch { /* best effort — the daemon still times out safely */ }
}

export function readTakeoverRequest(projectRoot: string): TakeoverRequest | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(getTakeoverRequestPath(projectRoot), 'utf8').trim(),
    ) as Partial<TakeoverRequest>;
    if (typeof parsed.pid !== 'number' || typeof parsed.target !== 'number') return null;
    return {
      pid: parsed.pid,
      target: parsed.target,
      requestedAt: typeof parsed.requestedAt === 'number' ? parsed.requestedAt : 0,
    };
  } catch {
    return null;
  }
}

export function clearTakeoverRequest(projectRoot: string): void {
  try { fs.unlinkSync(getTakeoverRequestPath(projectRoot)); } catch { /* ENOENT ok */ }
}

/**
 * True when a live, non-stale request asks `selfPid` to release the lock.
 * The requester must still be alive — otherwise a daemon that died mid-retry
 * would strip the watcher off a holder with nothing to hand it to.
 */
export function takeoverRequestedFrom(projectRoot: string, selfPid: number): boolean {
  const req = readTakeoverRequest(projectRoot);
  if (!req || req.target !== selfPid) return false;
  if (Date.now() - req.requestedAt > TAKEOVER_REQUEST_TTL_MS) return false;
  return req.pid > 0 && isProcessAlive(req.pid);
}
