/**
 * A daemon that refuses to start used to be invisible to the client: its
 * stderr is `.codegraph/daemon.log`, so the session just degraded to an
 * in-process engine with no reason given. These cover the reason getting back
 * to the client's own stderr — the log-window reader, and one end-to-end run
 * where a live direct-mode writer makes a real daemon refuse.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getWriterPidPath } from '../src/mcp/writer-lock';
import {
  describeDaemonSpawnFailure,
  getDaemonLogPath,
  readDaemonRefusal,
  snapshotDaemonLogSize,
} from '../src/mcp/daemon-refusal';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function stamped(line: string): string {
  return `[${new Date().toISOString()}] ${line}\n`;
}

describe('daemon refusal reader', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-refusal-')));
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('reports no reason when the daemon logged nothing', () => {
    expect(readDaemonRefusal(root, 0)).toBeNull();
    fs.writeFileSync(getDaemonLogPath(root), '');
    expect(readDaemonRefusal(root, 0)).toBeNull();
  });

  it('quotes only what was written after the snapshot', () => {
    const log = getDaemonLogPath(root);
    fs.writeFileSync(log, stamped('[CodeGraph daemon] Shutting down (idle timeout).'));
    const since = snapshotDaemonLogSize(root);
    fs.appendFileSync(log, stamped('[CodeGraph daemon] CodeGraph writer lock held by PID 4242 (direct mode).'));

    const reason = readDaemonRefusal(root, since);
    expect(reason).toContain('PID 4242');
    // A refusal from an earlier run must never be quoted as this one's.
    expect(reason).not.toContain('idle timeout');
  });

  it('strips the log timestamp and prefers the daemon\'s own lines over a stack trace', () => {
    const log = getDaemonLogPath(root);
    fs.writeFileSync(
      log,
      stamped('[CodeGraph daemon] CodeGraph writer lock held by PID 7 (direct mode).') +
      'file:///dist/mcp/daemon.js:301\n' +
      '    throw new Error(msg);\n' +
      '    ^\n',
    );

    const reason = readDaemonRefusal(root, 0);
    expect(reason).toBe('[CodeGraph daemon] CodeGraph writer lock held by PID 7 (direct mode).');
    expect(reason).not.toMatch(/^\[\d{4}-/);
  });

  it('falls back to untagged lines, capped, when nothing is tagged', () => {
    const log = getDaemonLogPath(root);
    fs.writeFileSync(log, Array.from({ length: 20 }, (_, i) => `plain line ${i}`).join('\n') + '\n');

    const reason = readDaemonRefusal(root, 0) as string;
    expect(reason).toContain('plain line 19');
    expect(reason).not.toContain('plain line 15');
    expect(reason.length).toBeLessThanOrEqual(601);
  });

  it('reads the tail when the log was rotated below the snapshot', () => {
    const log = getDaemonLogPath(root);
    fs.writeFileSync(log, stamped('[CodeGraph daemon] old and long enough to matter'.repeat(4)));
    const since = snapshotDaemonLogSize(root);
    // Rotation leaves a shorter file, so the recorded offset is past its end.
    fs.writeFileSync(log, stamped('[CodeGraph daemon] Could not acquire the daemon lock; exiting.'));

    expect(readDaemonRefusal(root, since)).toContain('Could not acquire the daemon lock');
  });

  it('always names the log, even with no reason to quote', () => {
    const described = describeDaemonSpawnFailure(root, 0);
    expect(described).toContain(getDaemonLogPath(root));
    expect(described).toContain('never bound');
  });
});

describe('daemon refusal reaches the client', () => {
  let root: string;
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-refusal-e2e-')));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'export function a() { return 1; }\n');
    const cg = await CodeGraph.init(root);
    await cg.indexAll();
    cg.close();
  });

  afterEach(async () => {
    for (const c of children) {
      try { c.kill('SIGTERM'); } catch { /* ignore */ }
    }
    children.length = 0;
    await sleep(300);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('names the refusal on the client\'s stderr instead of degrading silently', async () => {
    // A live direct-mode writer: never stolen from, and — unlike `fallback` —
    // never asked to stand down, so the daemon this client spawns must refuse.
    const holder = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000);'], { stdio: 'ignore' }) as ChildProcessWithoutNullStreams;
    children.push(holder);
    if (!holder.pid) throw new Error('failed to spawn the writer-lock holder');
    fs.writeFileSync(
      getWriterPidPath(root),
      JSON.stringify({ pid: holder.pid, mode: 'direct', startedAt: Date.now() }) + '\n',
    );

    const client = spawn(process.execPath, [BIN, 'serve', '--mcp'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEGRAPH_NO_WATCHDOG: '1' },
    }) as ChildProcessWithoutNullStreams;
    children.push(client);
    client.on('error', () => {});
    client.stdin.on('error', () => {});
    client.stdout.on('data', () => {});
    let stderr = '';
    client.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !stderr.includes('Shared daemon unavailable')) {
      await sleep(100);
    }

    expect(stderr).toContain('Shared daemon unavailable');
    // The point of the fix: the cause, not just the symptom.
    expect(stderr).toContain(`PID ${holder.pid}`);
    expect(stderr).toContain(getDaemonLogPath(root));
  }, 45000);
});
