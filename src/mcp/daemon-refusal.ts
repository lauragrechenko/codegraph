/**
 * Why a daemon refusal never reaches the client, and how it gets back.
 *
 * The daemon is detached: the launcher hands it `.codegraph/daemon.log` as its
 * stderr and shares no pipe with it. So every reason a daemon can refuse to
 * start — the project's writer lock held by another live writer, a daemon lock
 * it could not acquire, a throw while binding the socket — lands in a file the
 * client never reads. From the client's side a refusal and a slow start look
 * identical: nothing binds the socket, the connect poll runs out, and the
 * session quietly degrades to an in-process engine. The operator gets a slower
 * session and no reason for it.
 *
 * The launcher closes that gap by noting the log's size *before* it spawns and
 * reading only the bytes that appear after. Those bytes are this spawn's output
 * and nothing else — no timestamp parsing, and no way to quote a refusal left
 * behind by an earlier run.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from '../directory';

/** Only the tail is read: daemon.log grows across runs and can be large. */
const MAX_TAIL_BYTES = 64 * 1024;
/** A refusal is usually one line; a throw adds a stack we don't want verbatim. */
const MAX_REASON_LINES = 4;
const MAX_REASON_CHARS = 600;

/** Absolute path to the log the detached daemon writes its stderr to. */
export function getDaemonLogPath(projectRoot: string): string {
  return path.join(getCodeGraphDir(projectRoot), 'daemon.log');
}

/**
 * Byte length of the daemon log right now, to be passed back to
 * {@link readDaemonRefusal} after the spawn. A missing log reads as 0 — the
 * daemon creates it, and everything in it is then ours.
 */
export function snapshotDaemonLogSize(projectRoot: string): number {
  try {
    return fs.statSync(getDaemonLogPath(projectRoot)).size;
  } catch {
    return 0;
  }
}

/** Drop the `[ISO-8601] ` stamp the daemon prefixes every line with (#1431). */
function stripStamp(line: string): string {
  return line.replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]*\]\s*/, '');
}

/**
 * The reason a daemon spawned at `sinceBytes` gave for not serving, or null
 * when it wrote nothing. Lines the daemon tagged itself win over anything else
 * in the window: a refusal is one such line, while a throw buries the same
 * message under a stack trace and an unhandled-rejection preamble.
 */
export function readDaemonRefusal(projectRoot: string, sinceBytes: number): string | null {
  const logPath = getDaemonLogPath(projectRoot);
  let text: string;
  try {
    const size = fs.statSync(logPath).size;
    // A rotated or truncated log invalidates the offset; fall back to the tail.
    const start = size < sinceBytes ? Math.max(0, size - MAX_TAIL_BYTES) : Math.max(sinceBytes, size - MAX_TAIL_BYTES);
    if (size <= start) return null;
    const fd = fs.openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = text
    .split('\n')
    .map((l) => stripStamp(l.trim()))
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  const tagged = lines.filter((l) => l.includes('[CodeGraph daemon]') || l.includes('[CodeGraph MCP]'));
  const chosen = (tagged.length > 0 ? tagged : lines).slice(-MAX_REASON_LINES);
  const reason = chosen.join(' | ');
  return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS)}…` : reason;
}

/**
 * Client-facing one-liner for "the daemon never bound". Always names the log,
 * so a refusal too mangled to quote still leaves the operator somewhere to look.
 */
export function describeDaemonSpawnFailure(projectRoot: string, sinceBytes: number): string {
  const reason = readDaemonRefusal(projectRoot, sinceBytes);
  const logPath = getDaemonLogPath(projectRoot);
  return reason
    ? `${reason} — see ${logPath}`
    : `the daemon never bound its socket and wrote no reason to ${logPath}`;
}
