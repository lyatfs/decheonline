import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildTunnelCommand,
  createTunnelAdapter,
  extractPublicUrlFromLine,
  redactSecrets,
  validateLocalUrl,
  validatePublicUrl,
} from './tunnel.ts';
import type {
  TunnelLogEntry,
  TunnelProcessLike,
  TunnelStatus,
  TunnelTimerApi,
} from './tunnel.ts';

class FakeStream extends EventEmitter {
  pushText(chunk: string): void {
    this.emit('data', Buffer.from(chunk, 'utf8'));
  }

  endStream(): void {
    this.emit('end');
  }
}

class FakeChildProcess extends EventEmitter implements TunnelProcessLike {
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  autoCloseOnKill: boolean;

  constructor(pid: number, autoCloseOnKill = true) {
    super();
    this.pid = pid;
    this.autoCloseOnKill = autoCloseOnKill;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    if (this.autoCloseOnKill && this.exitCode === null && this.signalCode === null) {
      const sig: NodeJS.Signals = typeof signal === 'string' ? signal : 'SIGTERM';
      this.simulateClose(null, sig);
    }
    return true;
  }

  simulateClose(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.endStream();
    this.stderr.endStream();
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  simulateError(err: Error): void {
    this.emit('error', err);
  }
}

interface ScheduledTimer {
  id: number;
  due: number;
  cb: () => void;
}

class FakeTimers implements TunnelTimerApi {
  private now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, ScheduledTimer>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { id, due: this.now + ms, cb: callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') {
      this.timers.delete(handle);
    }
  }

  async advance(ms: number): Promise<void> {
    this.now += ms;
    while (true) {
      const dueList = [...this.timers.values()]
        .filter((entry) => entry.due <= this.now)
        .sort((a, b) => a.due - b.due || a.id - b.id);
      const next = dueList[0];
      if (!next) break;
      this.timers.delete(next.id);
      next.cb();
      await flushMicrotasks();
    }
  }

  pendingCount(): number {
    return this.timers.size;
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

interface SpawnInvocation {
  command: string;
  args: string[];
  options: SpawnOptions;
  child: FakeChildProcess;
}

describe('tunnel URL validation and parsing (O07)', () => {
  it('accepts valid public HTTPS origins and normalizes trailing slash', () => {
    expect(validatePublicUrl('https://autumn-wind-1234.trycloudflare.com')).toEqual({
      ok: true,
      url: 'https://autumn-wind-1234.trycloudflare.com',
    });
    expect(validatePublicUrl('https://aoe.signalsradar.space/')).toEqual({
      ok: true,
      url: 'https://aoe.signalsradar.space',
    });
    expect(validatePublicUrl('https://play.example.org:8443/')).toEqual({
      ok: true,
      url: 'https://play.example.org:8443',
    });
  });

  it('rejects malformed, non-HTTPS, credentialed, subpath/query, and internal/private URLs', () => {
    const invalidUrls = [
      '',
      'not a url',
      'http://autumn-wind-1234.trycloudflare.com',
      'ws://autumn-wind-1234.trycloudflare.com',
      'wss://autumn-wind-1234.trycloudflare.com',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://user:pass@aoe.example.com',
      'https://aoe.example.com/?token=secret',
      'https://aoe.example.com/subpath',
      'https://aoe.example.com/#frag',
      'https://localhost',
      'https://localhost:8787',
      'https://sub.localhost',
      'https://mybox.local',
      'https://game.internal',
      'https://host.lan',
      'https://intranet',
      'https://127.0.0.1',
      'https://0.0.0.0',
      'https://10.0.0.5',
      'https://172.16.0.1',
      'https://172.31.255.254',
      'https://192.168.1.50',
      'https://169.254.169.254',
      'https://100.64.0.1',
      'https://[::1]',
      'https://[::]',
      'https://[fe80::1]',
      'https://[fc00::1]',
      'https://[::ffff:127.0.0.1]',
      'https://[::ffff:192.168.1.1]',
      'https://2130706433', // decimal 127.0.0.1
    ];

    for (const candidate of invalidUrls) {
      const result = validatePublicUrl(candidate);
      expect(result.ok, `Expected rejection for ${candidate}`).toBe(false);
    }
  });

  it('validates local server origin URLs', () => {
    expect(validateLocalUrl('http://127.0.0.1:8787/')).toEqual({
      ok: true,
      url: 'http://127.0.0.1:8787',
    });
    expect(validateLocalUrl('http://localhost:8787')).toEqual({
      ok: true,
      url: 'http://localhost:8787',
    });
    expect(validateLocalUrl('ftp://localhost:8787').ok).toBe(false);
    expect(validateLocalUrl('http://user:pw@localhost:8787').ok).toBe(false);
    expect(validateLocalUrl('http://localhost:8787/path').ok).toBe(false);
  });

  it('extracts cloudflared quick tunnel URL from ANSI/box output while ignoring docs/API URLs', () => {
    expect(
      extractPublicUrlFromLine('INF Requesting new quick Tunnel on https://api.trycloudflare.com/v1'),
    ).toBeNull();
    expect(
      extractPublicUrlFromLine('INF See https://developers.cloudflare.com/cloudflare-one/ for docs'),
    ).toBeNull();
    expect(
      extractPublicUrlFromLine(
        '\u001b[32m2026-11-24T12:00:00Z INF |  https://quiet-pine-42.trycloudflare.com  |\u001b[0m',
      ),
    ).toBe('https://quiet-pine-42.trycloudflare.com');
  });
});

describe('tunnel adapter lifecycle and no stale URL (O07)', () => {
  it('starts cloudflared quick tunnel across chunked stderr output and marks kind temporary', async () => {
    const spawns: SpawnInvocation[] = [];
    const timers = new FakeTimers();
    const statuses: TunnelStatus[] = [];
    const logs: TunnelLogEntry[] = [];

    const adapter = createTunnelAdapter({
      provider: 'cloudflared',
      timers,
      onStatusChange: (st) => statuses.push(st),
      onLog: (entry) => logs.push(entry),
      spawn: (command, args, options) => {
        const child = new FakeChildProcess(41001);
        spawns.push({ command, args: [...args], options, child });
        return child;
      },
    });

    const startPromise = adapter.start({ localUrl: 'http://127.0.0.1:8787' });
    await flushMicrotasks();

    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.command).toBe('cloudflared');
    expect(spawns[0]?.args).toEqual(['tunnel', '--url', 'http://127.0.0.1:8787']);
    expect(spawns[0]?.options.shell).toBe(false);
    expect(adapter.status().state).toBe('starting');
    expect(adapter.status().publicUrl).toBeNull();

    const child = spawns[0]!.child;
    child.stderr.pushText('INF Requesting new quick Tunnel on https://api.trycloudflare.com\n');
    child.stderr.pushText('INF |  https://bright-oak-99.');
    child.stderr.pushText('trycloudflare.com  |\n');

    const status = await startPromise;
    expect(status.state).toBe('ready');
    expect(status.pid).toBe(41001);
    expect(status.kind).toBe('temporary');
    expect(status.publicUrl).toBe('https://bright-oak-99.trycloudflare.com');
    expect(status.error).toBeUndefined();
    expect(timers.pendingCount()).toBe(0);
    expect(statuses.some((s) => s.state === 'starting')).toBe(true);
    expect(statuses.at(-1)?.state).toBe('ready');
    expect(logs.some((entry) => entry.line.includes('bright-oak-99.trycloudflare.com'))).toBe(true);

    await adapter.stop();
    const afterStop = adapter.status();
    expect(afterStop.state).toBe('stopped');
    expect(afterStop.pid).toBeNull();
    expect(afterStop.publicUrl).toBeNull();
  });

  it('parses ngrok forwarding URLs and ignores ngrok docs URLs', async () => {
    const timers = new FakeTimers();
    let spawnedChild: FakeChildProcess | null = null;
    const adapter = createTunnelAdapter({
      provider: 'ngrok',
      timers,
      spawn: () => {
        spawnedChild = new FakeChildProcess(42001);
        return spawnedChild;
      },
    });

    const startPromise = adapter.start({ localUrl: 'http://127.0.0.1:8787' });
    await flushMicrotasks();

    spawnedChild!.stdout.pushText('t=2026-11-24 lvl=info msg="see https://ngrok.com/docs"\n');
    spawnedChild!.stdout.pushText('t=2026-11-24 lvl=info msg="started tunnel" url=https://fast-river.ngrok-free.app\n');

    const status = await startPromise;
    expect(status.state).toBe('ready');
    expect(status.kind).toBe('temporary');
    expect(status.publicUrl).toBe('https://fast-river.ngrok-free.app');

    await adapter.stop();
  });

  it('supports fixed named tunnel with user-supplied https publicUrl', async () => {
    const timers = new FakeTimers();
    const spawns: SpawnInvocation[] = [];
    const adapter = createTunnelAdapter({
      provider: 'cloudflared',
      tokenFile: '/etc/aoe1web/tunnel.token',
      timers,
      spawn: (command, args, options) => {
        const child = new FakeChildProcess(43001);
        spawns.push({ command, args: [...args], options, child });
        return child;
      },
    });

    const startPromise = adapter.start({
      localUrl: 'http://127.0.0.1:8787',
      publicUrl: 'https://aoe.signalsradar.space/',
    });
    await flushMicrotasks();

    expect(spawns[0]?.args).toEqual(['tunnel', 'run', '--token-file', '/etc/aoe1web/tunnel.token']);
    spawns[0]!.child.stderr.pushText('2026-11-24T12:00:00Z INF Registered tunnel connection connIndex=0\n');

    const status = await startPromise;
    expect(status.state).toBe('ready');
    expect(status.kind).toBe('fixed');
    expect(status.publicUrl).toBe('https://aoe.signalsradar.space');

    await adapter.stop();
  });

  it('ignores non-HTTPS and internal URLs from process output and times out cleanly', async () => {
    const timers = new FakeTimers();
    let spawnedChild: FakeChildProcess | null = null;
    const adapter = createTunnelAdapter({
      provider: 'cloudflared',
      timers,
      spawn: () => {
        spawnedChild = new FakeChildProcess(44001);
        return spawnedChild;
      },
    });

    const startPromise = adapter.start({
      localUrl: 'http://127.0.0.1:8787',
      timeoutMs: 5_000,
    });
    await flushMicrotasks();

    spawnedChild!.stderr.pushText('INF http://insecure.trycloudflare.com\n');
    spawnedChild!.stderr.pushText('INF https://192.168.1.50:8787\n');
    spawnedChild!.stderr.pushText('INF https://localhost:8787\n');
    await flushMicrotasks();
    expect(adapter.status().state).toBe('starting');

    await timers.advance(5_000);
    const status = await startPromise;
    expect(status.state).toBe('failed');
    expect(status.pid).toBeNull();
    expect(status.publicUrl).toBeNull();
    expect(status.error).toMatch(/timed out/i);
    expect(spawnedChild!.killSignals).toEqual(['SIGTERM']);
  });

  it('handles spawn ENOENT errors without retaining stale URLs', async () => {
    const timers = new FakeTimers();
    const adapter = createTunnelAdapter({
      provider: 'cloudflared',
      timers,
      spawn: () => {
        const child = new FakeChildProcess(45001);
        queueMicrotask(() => child.simulateError(new Error('spawn cloudflared ENOENT')));
        return child;
      },
    });

    const status = await adapter.start({ localUrl: 'http://127.0.0.1:8787' });
    expect(status.state).toBe('failed');
    expect(status.pid).toBeNull();
    expect(status.publicUrl).toBeNull();
    expect(status.error).toMatch(/ENOENT/);
  });

  it('clears publicUrl immediately if tunnel crashes after becoming ready, and restarts cleanly without stale URL', async () => {
    const timers = new FakeTimers();
    const children: FakeChildProcess[] = [];
    const statusChanges: TunnelStatus[] = [];
    let nextPid = 46001;

    const adapter = createTunnelAdapter({
      provider: 'cloudflared',
      timers,
      onStatusChange: (st) => statusChanges.push(st),
      spawn: () => {
        const child = new FakeChildProcess(nextPid++);
        children.push(child);
        return child;
      },
    });

    const firstStart = adapter.start({ localUrl: 'http://127.0.0.1:8787' });
    await flushMicrotasks();
    children[0]!.stderr.pushText('INF |  https://first-link.trycloudflare.com  |\n');
    const firstStatus = await firstStart;
    expect(firstStatus.publicUrl).toBe('https://first-link.trycloudflare.com');

    // Crash after becoming ready: must clear publicUrl immediately.
    children[0]!.stderr.pushText('ERR connection lost\n');
    children[0]!.simulateClose(1, null);
    await flushMicrotasks();

    const crashed = adapter.status();
    expect(crashed.state).toBe('failed');
    expect(crashed.pid).toBeNull();
    expect(crashed.publicUrl).toBeNull();
    expect(statusChanges.at(-1)?.publicUrl).toBeNull();

    // Restart must clear prior error/URL and emit fresh URL; late events on old child must be ignored.
    const secondStart = adapter.start({ localUrl: 'http://127.0.0.1:8787' });
    await flushMicrotasks();
    expect(adapter.status().state).toBe('starting');
    expect(adapter.status().publicUrl).toBeNull();

    // Late emission on old child 0 must not pollute run 2
    children[0]!.stderr.pushText('INF |  https://stale-ghost.trycloudflare.com  |\n');
    await flushMicrotasks();
    expect(adapter.status().publicUrl).toBeNull();

    children[1]!.stderr.pushText('INF |  https://second-link.trycloudflare.com  |\n');
    const secondStatus = await secondStart;
    expect(secondStatus.state).toBe('ready');
    expect(secondStatus.pid).toBe(46002);
    expect(secondStatus.publicUrl).toBe('https://second-link.trycloudflare.com');

    // Calling start() directly while already ready stops old child and starts fresh without leaking child[1].
    const thirdStart = adapter.start({ localUrl: 'http://127.0.0.1:8787' });
    await flushMicrotasks();
    expect(children[1]!.killSignals).toEqual(['SIGTERM']);
    children[2]!.stderr.pushText('INF |  https://third-link.trycloudflare.com  |\n');
    const thirdStatus = await thirdStart;
    expect(thirdStatus.publicUrl).toBe('https://third-link.trycloudflare.com');

    await adapter.stop();
  });
});

describe('tunnel secret redaction, argv safety, and process ownership (O08)', () => {
  it('redacts tunnel tokens, Bearer headers, query tokens, basic auth, and JWTs', () => {
    const rawSecret = 'super-secret-cf-token-987654321';
    const sample = [
      `Authorization: Bearer ${rawSecret}`,
      `TUNNEL_TOKEN=${rawSecret}`,
      `NGROK_AUTHTOKEN="${rawSecret}"`,
      `cloudflared tunnel run --token ${rawSecret}`,
      `cloudflared tunnel run --token=${rawSecret}`,
      `https://example.com/?room=ABCDE&token=${rawSecret}&access_token=abc123456`,
      'https://alice:hunter2@proxy.example.com',
      '{"token":"json-secret-value-1234"}',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturePartHere123',
      'https://valid-host.trycloudflare.com',
    ].join('\n');

    const redacted = redactSecrets(sample, [rawSecret]);
    expect(redacted).not.toContain(rawSecret);
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('abc123456');
    expect(redacted).not.toContain('json-secret-value-1234');
    expect(redacted).not.toContain('signaturePartHere123');
    expect(redacted).toContain('https://valid-host.trycloudflare.com');
    expect(redacted).toContain('room=ABCDE');
  });

  it('passes token via child env (not argv) and redacts secrets from log file and status error', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'aoe-tunnel-test-'));
    const logPath = join(tempDir, 'tunnel.log');
    const secretToken = 'eyJhIjoiYWJjZGVmZ2hpamsxMjM0NTY3ODkwMTIzNCIsInQiOiJzZWNyZXQifQ==';
    const spawns: SpawnInvocation[] = [];
    const timers = new FakeTimers();

    try {
      const adapter = createTunnelAdapter({
        provider: 'cloudflared',
        token: secretToken,
        timers,
        spawn: (command, args, options) => {
          const child = new FakeChildProcess(51001);
          spawns.push({ command, args: [...args], options, child });
          return child;
        },
      });

      const startPromise = adapter.start({
        localUrl: 'http://127.0.0.1:8787',
        publicUrl: 'https://aoe.signalsradar.space',
        logPath,
      });
      await flushMicrotasks();

      // Token must NOT appear in argv; it is passed via child env only.
      expect(spawns[0]!.args.join(' ')).not.toContain(secretToken);
      expect(spawns[0]!.options.env?.TUNNEL_TOKEN).toBe(secretToken);
      expect(spawns[0]!.options.shell).toBe(false);

      spawns[0]!.child.stderr.pushText(`ERR failed auth with Bearer ${secretToken} and --token=${secretToken}\n`);
      spawns[0]!.child.simulateClose(1, null);

      const status = await startPromise;
      expect(status.state).toBe('failed');
      expect(status.error ?? '').not.toContain(secretToken);
      expect(status.error).toMatch(/\[REDACTED\]/);

      // Ensure async log writer flushed to disk.
      await adapter.stop();
      const logContents = await readFile(logPath, 'utf8');
      expect(logContents).not.toContain(secretToken);
      expect(logContents).toMatch(/\[REDACTED\]/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('builds validated argv with shell: false, supports Unicode/spaced paths, and rejects unsafe inputs', () => {
    const spacedUnicodePath = 'D:\\Công cụ\\cloudflared tunnel\\cloudflared.exe';
    const cmd = buildTunnelCommand(
      { provider: 'cloudflared', executable: spacedUnicodePath, noAutoupdate: true },
      { localUrl: 'http://127.0.0.1:8787/' },
    );
    expect(cmd.executable).toBe(spacedUnicodePath);
    expect(cmd.args).toEqual(['--no-autoupdate', 'tunnel', '--url', 'http://127.0.0.1:8787']);
    expect(cmd.kind).toBe('temporary');

    const customCmd = buildTunnelCommand(
      {
        provider: 'custom',
        executable: 'C:\\Tools\\my-tunnel.exe',
        args: ['--forward', '{localUrl}', '--domain', '{publicUrl}'],
      },
      { localUrl: 'http://127.0.0.1:8787', publicUrl: 'https://play.example.com' },
    );
    expect(customCmd.args).toEqual([
      '--forward',
      'http://127.0.0.1:8787',
      '--domain',
      'https://play.example.com',
    ]);
    expect(customCmd.kind).toBe('fixed');

    expect(() =>
      buildTunnelCommand(
        { provider: 'cloudflared', executable: 'cloudflared && calc.exe' },
        { localUrl: 'http://127.0.0.1:8787' },
      ),
    ).toThrow();
    expect(() =>
      buildTunnelCommand(
        { provider: 'cloudflared', extraArgs: ['--url\nhttp://evil'] },
        { localUrl: 'http://127.0.0.1:8787' },
      ),
    ).toThrow();
    expect(() =>
      buildTunnelCommand(
        { provider: 'cloudflared', token: 'secret-without-public-url' },
        { localUrl: 'http://127.0.0.1:8787' },
      ),
    ).toThrow();
  });

  it('stops only owned tunnel process, skips kill when PID already exited, and escalates only when hung', async () => {
    const timers = new FakeTimers();
    const killedTreeCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const children: FakeChildProcess[] = [];
    let nextPid = 52001;

    const adapter = createTunnelAdapter({
      provider: 'cloudflared',
      stopGraceMs: 1_500,
      timers,
      killProcessTree: (pid, signal) => {
        killedTreeCalls.push({ pid, signal });
        const target = children.find((c) => c.pid === pid);
        target?.simulateClose(null, signal);
      },
      spawn: () => {
        // autoCloseOnKill = false so we can test escalation on hung process
        const child = new FakeChildProcess(nextPid++, false);
        children.push(child);
        return child;
      },
    });

    // Run 1: child hangs on SIGTERM, escalates via killProcessTree(52001, 'SIGKILL')
    const start1 = adapter.start({ localUrl: 'http://127.0.0.1:8787' });
    await flushMicrotasks();
    children[0]!.stderr.pushText('INF |  https://owned-one.trycloudflare.com  |\n');
    await start1;

    const stop1 = adapter.stop();
    await flushMicrotasks();
    expect(children[0]!.killSignals).toEqual(['SIGTERM']);
    expect(killedTreeCalls).toHaveLength(0);

    await timers.advance(1_500);
    await stop1;
    expect(killedTreeCalls).toEqual([{ pid: 52001, signal: 'SIGKILL' }]);
    expect(adapter.status().state).toBe('stopped');
    expect(adapter.status().publicUrl).toBeNull();

    // Calling stop() again must NOT kill PID 52001 again (guards against PID reuse).
    await adapter.stop();
    expect(killedTreeCalls).toHaveLength(1);

    // Run 2: child already exited naturally before stop() -> stop() must NOT send any kill signal.
    const start2 = adapter.start({ localUrl: 'http://127.0.0.1:8787' });
    await flushMicrotasks();
    children[1]!.stderr.pushText('INF |  https://owned-two.trycloudflare.com  |\n');
    await start2;

    children[1]!.simulateClose(0, null);
    await flushMicrotasks();
    await adapter.stop();
    expect(children[1]!.killSignals).toEqual([]);
    expect(killedTreeCalls).toHaveLength(1);
  });
});
