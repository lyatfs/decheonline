import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  normalizePublicUrl,
  parsePort,
  resolveHostConfig,
  resolveRepoRoot,
} from './config.ts';
import { HostLauncher } from './launcher.ts';
import {
  buildLanUrls,
  enumerateLanInterfaces,
  selectLanAddresses,
  type NetworkInterfacesMap,
} from './network.ts';
import { runPreflight } from './preflight.ts';
import {
  ProcessManager,
  appendRedactedLog,
  redactSecrets,
  rotateLogIfNeeded,
  verifyProcessIdentity,
} from './process-manager.ts';
import type { HostConfig, ProcessRecord, TunnelAdapter, TunnelStatus } from './types.ts';

const tempDirs: string[] = [];
const activeServers: Array<NetServer | HttpServer> = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createValidFixtureTree(rootDir: string): Promise<{
  repoRoot: string;
  serverEntry: string;
  clientDir: string;
  assetsDir: string;
  stateDir: string;
}> {
  const repoRoot = join(rootDir, 'Dự Án Game Với Dấu Cách');
  const serverDir = join(repoRoot, 'apps', 'server', 'dist');
  const clientDir = join(repoRoot, 'apps', 'client', 'dist');
  const assetsDir = join(repoRoot, 'assets-local', 'pack');
  const stateDir = join(repoRoot, 'assets-local', 'host-runtime');

  await mkdir(serverDir, { recursive: true });
  await mkdir(clientDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const serverEntry = join(serverDir, 'main.js');
  await writeFile(serverEntry, 'console.log("stub");\n', 'utf8');
  await mkdir(join(clientDir, 'bundle'), { recursive: true });
  await writeFile(
    join(clientDir, 'index.html'),
    '<!doctype html><head><script type="module" src="/bundle/index-abc123.js"></script></head><title>AoE1</title>\n',
    'utf8',
  );
  await writeFile(join(clientDir, 'bundle', 'index-abc123.js'), 'console.log("aoe1");\n', 'utf8');

  await mkdir(join(assetsDir, 'sprites', 'graphics'), { recursive: true });
  const pngStub = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeFile(join(assetsDir, 'sprites', 'graphics', '0.png'), pngStub);
  for (const owner of [1, 2, 3, 4]) {
    await writeFile(join(assetsDir, 'sprites', 'graphics', `10.o${owner}.png`), pngStub);
  }
  await writeFile(join(assetsDir, 'palette.json'), '[]', 'utf8');
  await writeFile(join(assetsDir, 'empires.dat'), 'VER 3.7-test', 'utf8');
  const frame = [{ x: 0, y: 0, w: 8, h: 8, hotspotX: 4, hotspotY: 4 }];
  await writeFile(
    join(assetsDir, 'manifest.json'),
    JSON.stringify({
      version: 16,
      palette: 'palette.json',
      dat: 'empires.dat',
      slps: {
        'graphics/0': { source: 'graphics', id: 0, atlasWidth: 8, atlasHeight: 8, frames: frame, playerColour: false },
        'graphics/10': { source: 'graphics', id: 10, atlasWidth: 8, atlasHeight: 8, frames: frame, playerColour: true },
      },
      graphics: {
        '0': { name: 'Stand', slp: 'graphics/0', frameCount: 1, angleCount: 1, deltas: [] },
        '10': { name: 'Villager', slp: 'graphics/10', frameCount: 1, angleCount: 1, deltas: [] },
      },
      terrains: {},
      units: {},
    }),
    'utf8',
  );

  return { repoRoot, serverEntry, clientDir, assetsDir, stateDir };
}

async function allocateEphemeralPort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    srv.once('error', rejectListen);
    srv.listen(0, '127.0.0.1', () => resolveListen());
  });
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolveClose) => srv.close(() => resolveClose()));
  return port;
}

function makeFakeIface(
  address: string,
  opts: Partial<NetworkInterfaceInfo> = {},
): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:11:22:33:44:55',
    internal: false,
    cidr: `${address}/24`,
    ...opts,
  } as NetworkInterfaceInfo;
}

class FakeChildProcess extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  killed = false;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killSignals: Array<NodeJS.Signals | number | undefined> = [];
  unrefCalled = false;
  private readonly onKill?: (signal?: NodeJS.Signals | number) => void;

  constructor(pid: number, onKill?: (signal?: NodeJS.Signals | number) => void) {
    super();
    this.pid = pid;
    this.onKill = onKill;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    this.killed = true;
    this.onKill?.(signal);
    return true;
  }

  unref(): this {
    this.unrefCalled = true;
    return this;
  }

  simulateExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.emit('exit', code, signal);
  }
}

afterEach(async () => {
  while (activeServers.length > 0) {
    const srv = activeServers.pop();
    if (srv) {
      await new Promise<void>((resolveClose) => srv.close(() => resolveClose()));
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('O01 — arbitrary cwd and paths with spaces and Unicode', () => {
  test('resolves repoRoot via import.meta.url independent of cwd', async () => {
    const base = await makeTempDir('aoe-o01-');
    const unicodeCwd = join(base, 'Thư Mục Khác Có Dấu Cách');
    await mkdir(unicodeCwd, { recursive: true });

    const expectedRepoRoot = resolveRepoRoot();
    const cfg = resolveHostConfig({ cwd: unicodeCwd }, {});

    expect(cfg.repoRoot).toBe(expectedRepoRoot);
    expect(cfg.cwd).toBe(resolve(unicodeCwd));
    expect(cfg.serverEntry).toBe(join(expectedRepoRoot, 'apps', 'server', 'dist', 'main.js'));
    expect(cfg.clientDir).toBe(join(expectedRepoRoot, 'apps', 'client', 'dist'));
    expect(cfg.assetsDir).toBe(join(expectedRepoRoot, 'assets-local', 'pack'));
    expect(cfg.port).toBe(8787);
  });

  test('resolves relative env overrides from cwd with spaces and Unicode', async () => {
    const base = await makeTempDir('aoe-o01-env-');
    const unicodeCwd = join(base, 'Người Dùng Đế Chế');
    await mkdir(unicodeCwd, { recursive: true });

    const cfg = resolveHostConfig(
      { cwd: unicodeCwd },
      {
        HOST: '192.168.1.50',
        PORT: '9001',
        ASSETS_DIR: './Gói Tài Nguyên',
        CLIENT_DIR: './Bản Dựng Client',
        PUBLIC_URL: 'https://aoe.example.com/',
      },
    );

    expect(cfg.host).toBe('192.168.1.50');
    expect(cfg.port).toBe(9001);
    expect(cfg.assetsDir).toBe(resolve(unicodeCwd, 'Gói Tài Nguyên'));
    expect(cfg.clientDir).toBe(resolve(unicodeCwd, 'Bản Dựng Client'));
    expect(cfg.publicUrl).toBe('https://aoe.example.com');
  });

  test('validates PORT and PUBLIC_URL safely', () => {
    expect(() => parsePort('abc')).toThrow(/Invalid PORT/);
    expect(() => parsePort('0')).toThrow(/Invalid PORT/);
    expect(() => parsePort('65536')).toThrow(/Invalid PORT/);
    expect(() => parsePort('8787.5')).toThrow(/Invalid PORT/);
    expect(parsePort('8787')).toBe(8787);

    expect(() => normalizePublicUrl('ftp://example.com')).toThrow(/protocol/);
    expect(() => normalizePublicUrl('https://user:secret@example.com')).toThrow(/credentials/);
    expect(() => normalizePublicUrl('https://example.com/?room=ABC')).toThrow(/query/);
    expect(normalizePublicUrl('https://example.com/')).toBe('https://example.com');
  });

  test('Chay-May-Chu.cmd quotes %~dp0 safely for spaces and Unicode', async () => {
    const cmdPath = join(resolveRepoRoot(), 'Chay-May-Chu.cmd');
    const content = await readFile(cmdPath, 'utf8');
    expect(content).toContain('chcp 65001');
    expect(content).toContain('%~dp0');
    expect(content).toContain('tools\\host\\cli.ts');
    expect(content).toContain('"%CLI_ENTRY%" %*');
  });
});

describe('O02 — preflight validation and occupied port protection', () => {
  test('reports actionable errors when Node < 24, server build, client build, or assets are missing', async () => {
    const base = await makeTempDir('aoe-o02-missing-');
    const cfg = resolveHostConfig({
      repoRoot: base,
      cwd: base,
      port: await allocateEphemeralPort(),
      stateDir: join(base, 'state'),
    });

    const result = await runPreflight(cfg, {
      checkNodeVersion: () => 'Node.js >= 24 is required (detected 20.11.0).',
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('Node.js >= 24'))).toBe(true);
    expect(result.errors.some((e) => e.includes('Built server entry not found') && e.includes('npm run build'))).toBe(true);
    expect(result.errors.some((e) => e.includes('Built client folder not found') && e.includes('npm run build'))).toBe(true);
    expect(result.errors.some((e) => e.includes('Assets folder not found'))).toBe(true);
  });

  test('validates manifest JSON and referenced palette file, plus M11 checkAssets hook', async () => {
    const base = await makeTempDir('aoe-o02-assets-');
    const tree = await createValidFixtureTree(base);
    await rm(join(tree.assetsDir, 'palette.json'));

    const cfg = resolveHostConfig({
      repoRoot: tree.repoRoot,
      cwd: tree.repoRoot,
      serverEntry: tree.serverEntry,
      clientDir: tree.clientDir,
      assetsDir: tree.assetsDir,
      stateDir: tree.stateDir,
      port: await allocateEphemeralPort(),
    });

    const missingPalette = await runPreflight(cfg);
    expect(missingPalette.ok).toBe(false);
    expect(missingPalette.errors.some((e) => e.includes('palette file missing'))).toBe(true);

    await writeFile(join(tree.assetsDir, 'palette.json'), '[]', 'utf8');
    const hookFailure = await runPreflight(cfg, {
      checkAssets: () => ['Missing owner4 variant for graphic 12'],
    });
    expect(hookFailure.ok).toBe(false);
    expect(hookFailure.errors).toEqual(['Missing owner4 variant for graphic 12']);
  });

  test('fails cleanly when port is already occupied without killing the existing listener', async () => {
    const base = await makeTempDir('aoe-o02-port-');
    const tree = await createValidFixtureTree(base);

    const occupiedServer = createNetServer();
    await new Promise<void>((resolveListen) => occupiedServer.listen(0, '127.0.0.1', () => resolveListen()));
    activeServers.push(occupiedServer);
    const occupiedPort = (occupiedServer.address() as AddressInfo).port;

    const spawnSpy = vi.fn();
    const launcher = new HostLauncher({
      config: {
        repoRoot: tree.repoRoot,
        cwd: tree.repoRoot,
        serverEntry: tree.serverEntry,
        clientDir: tree.clientDir,
        assetsDir: tree.assetsDir,
        stateDir: tree.stateDir,
        host: '127.0.0.1',
        port: occupiedPort,
      },
      processManagerDeps: {
        spawn: spawnSpy as unknown as typeof import('node:child_process').spawn,
      },
    });

    const status = await launcher.start();
    expect(status.state).toBe('failed');
    expect(status.pid).toBeNull();
    expect(status.error).toMatch(/already in use/i);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(occupiedServer.listening).toBe(true);
  });
});

describe('O03 — LAN interface filtering, selection override, and no localhost share URLs', () => {
  const sampleInterfaces: NetworkInterfacesMap = {
    Loopback: [makeFakeIface('127.0.0.1', { internal: true })],
    'vEthernet (WSL)': [makeFakeIface('172.24.16.1')],
    DockerNAT: [makeFakeIface('172.17.0.1')],
    Tailscale: [makeFakeIface('100.88.12.34')],
    'ZeroTier One': [makeFakeIface('10.147.20.5')],
    Hamachi: [makeFakeIface('25.10.20.30')],
    'VirtualBox Host-Only Network': [makeFakeIface('192.168.56.1')],
    'VMware Network Adapter VMnet8': [makeFakeIface('192.168.184.1')],
    APIPA: [makeFakeIface('169.254.12.34')],
    Ethernet: [
      makeFakeIface('10.0.0.42'),
      { ...makeFakeIface('fe80::1'), family: 'IPv6' } as unknown as NetworkInterfaceInfo,
    ],
    'Wi-Fi': [makeFakeIface('192.168.1.25')],
  };

  test('filters loopback, link-local, IPv6, and virtual/VPN adapters', () => {
    const { candidates, filteredVirtual } = enumerateLanInterfaces({ interfaces: sampleInterfaces });

    expect(candidates.map((c) => `${c.name}:${c.address}`)).toEqual([
      'Wi-Fi:192.168.1.25',
      'Ethernet:10.0.0.42',
    ]);
    expect(filteredVirtual.length).toBe(7);

    const urls = buildLanUrls(candidates, 8787);
    expect(urls).toEqual(['http://192.168.1.25:8787', 'http://10.0.0.42:8787']);
    expect(urls.some((u) => u.includes('localhost') || u.includes('127.'))).toBe(false);
  });

  test('supports preferredInterface override by adapter name or IP', () => {
    const byName = selectLanAddresses({
      interfaces: sampleInterfaces,
      preferredInterface: 'ethernet',
      host: '0.0.0.0',
    });
    expect(buildLanUrls(byName.selected, 8787)).toEqual(['http://10.0.0.42:8787']);

    const missing = selectLanAddresses({
      interfaces: sampleInterfaces,
      preferredInterface: 'NonExistentAdapter',
      host: '0.0.0.0',
    });
    expect(missing.selected).toEqual([]);
    expect(missing.warning).toContain('NonExistentAdapter');
  });

  test('never emits localhost or 127.0.0.1 as a LAN share URL when bound to loopback', () => {
    const res = selectLanAddresses({
      interfaces: sampleInterfaces,
      host: '127.0.0.1',
    });
    expect(res.selected).toEqual([]);
    expect(res.warning).toContain('LAN sharing is disabled');
    expect(buildLanUrls(res.selected, 8787)).toEqual([]);
    expect(buildLanUrls([{ address: '127.0.0.1' }, { address: '169.254.1.2' }], 8787)).toEqual([]);
  });
});

describe('O04 — process lifecycle, duplicate-start guard, PID reuse safety, logs, health & tunnel', () => {
  test('prevents duplicate server spawns, polls /api/health -> /health fallback, and stops cleanly', async () => {
    const base = await makeTempDir('aoe-o04-lifecycle-');
    const tree = await createValidFixtureTree(base);

    let healthHitCount = 0;
    const httpServer = createHttpServer((req, res) => {
      if (req.url === '/api/health') {
        healthHitCount += 1;
        res.writeHead(404);
        res.end('not found');
        return;
      }
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolveListen) => httpServer.listen(0, '127.0.0.1', () => resolveListen()));
    activeServers.push(httpServer);
    const port = (httpServer.address() as AddressInfo).port;

    let fakeAlive = false;
    let fakeChild: FakeChildProcess | null = null;
    const execCalls: Array<{ file: string; args: string[] }> = [];
    const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

    const launcher = new HostLauncher({
      config: {
        repoRoot: tree.repoRoot,
        cwd: tree.repoRoot,
        serverEntry: tree.serverEntry,
        clientDir: tree.clientDir,
        assetsDir: tree.assetsDir,
        stateDir: tree.stateDir,
        host: '0.0.0.0',
        port,
        healthIntervalMs: 10,
        healthTimeoutMs: 2_000,
        stopTimeoutMs: 1_000,
      },
      interfacesProvider: () => ({
        'Wi-Fi': [makeFakeIface('192.168.1.44')],
      }),
      preflightHooks: {
        // Test HTTP health polling against our local stub HTTP server while keeping port preflight clear
        checkPortAvailable: () => null,
      },
      processManagerDeps: {
        platform: 'win32',
        spawn: ((cmd: string, args: string[]) => {
          spawnCalls.push({ cmd, args });
          fakeAlive = true;
          fakeChild = new FakeChildProcess(42424);
          return fakeChild as unknown as ChildProcess;
        }) as unknown as typeof import('node:child_process').spawn,
        isPidAlive: (pid) => fakeAlive && pid === 42424,
        inspectProcess: async (pid) =>
          fakeAlive && pid === 42424
            ? { pid, commandLine: `node "${tree.serverEntry}"`, startedAtMs: Date.now() }
            : null,
        execFile: async (file, args) => {
          execCalls.push({ file, args });
          if (file === 'taskkill') {
            fakeAlive = false;
            fakeChild?.simulateExit(0, null);
          }
          return { stdout: '', stderr: '' };
        },
      },
    });

    const first = await launcher.start();
    expect(first.state).toBe('ready');
    expect(first.pid).toBe(42424);
    expect(first.lanUrls).toEqual([`http://192.168.1.44:${port}`]);
    expect(healthHitCount).toBeGreaterThanOrEqual(1);
    expect(spawnCalls).toHaveLength(1);

    // Duplicate start must NOT spawn a second server
    const second = await launcher.start();
    expect(second.state).toBe('ready');
    expect(second.pid).toBe(42424);
    expect(spawnCalls).toHaveLength(1);

    const stopped = await launcher.stop();
    expect(stopped.state).toBe('stopped');
    expect(stopped.pid).toBeNull();
    expect(execCalls).toEqual([{ file: 'taskkill', args: ['/PID', '42424', '/T', '/F'] }]);

    const afterStop = await launcher.status();
    expect(afterStop.state).toBe('stopped');
  });

  test('prefers /api/health ready over /health and handles 503 not-ready', async () => {
    const base = await makeTempDir('aoe-o04-apihealth-');
    const tree = await createValidFixtureTree(base);

    let ready = false;
    const httpServer = createHttpServer((req, res) => {
      if (req.url === '/api/health') {
        if (!ready) {
          ready = true;
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'not-ready', reasons: ['warming up'] }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ready' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolveListen) => httpServer.listen(0, '127.0.0.1', () => resolveListen()));
    activeServers.push(httpServer);
    const port = (httpServer.address() as AddressInfo).port;

    let fakeAlive = false;
    let fakeChild: FakeChildProcess | null = null;
    const launcher = new HostLauncher({
      config: {
        repoRoot: tree.repoRoot,
        cwd: tree.repoRoot,
        serverEntry: tree.serverEntry,
        clientDir: tree.clientDir,
        assetsDir: tree.assetsDir,
        stateDir: tree.stateDir,
        host: '0.0.0.0',
        port,
        healthIntervalMs: 10,
        healthTimeoutMs: 2_000,
      },
      preflightHooks: { checkPortAvailable: () => null },
      processManagerDeps: {
        platform: 'linux',
        spawn: (() => {
          fakeAlive = true;
          fakeChild = new FakeChildProcess(51515, () => {
            fakeAlive = false;
            fakeChild?.simulateExit(0, 'SIGTERM');
          });
          return fakeChild as unknown as ChildProcess;
        }) as unknown as typeof import('node:child_process').spawn,
        isPidAlive: (pid) => fakeAlive && pid === 51515,
        inspectProcess: async (pid) =>
          fakeAlive && pid === 51515
            ? { pid, commandLine: `node ${tree.serverEntry}`, startedAtMs: Date.now() }
            : null,
        killProcess: () => {
          fakeAlive = false;
          fakeChild?.simulateExit(0, 'SIGTERM');
        },
      },
    });

    const status = await launcher.start();
    expect(status.state).toBe('ready');
    expect(status.pid).toBe(51515);
    await launcher.stop();
  });

  test('aborts startup cleanly if child exits prematurely before becoming ready', async () => {
    const base = await makeTempDir('aoe-o04-crash-');
    const tree = await createValidFixtureTree(base);
    const port = await allocateEphemeralPort();

    let fakeAlive = false;
    const launcher = new HostLauncher({
      config: {
        repoRoot: tree.repoRoot,
        cwd: tree.repoRoot,
        serverEntry: tree.serverEntry,
        clientDir: tree.clientDir,
        assetsDir: tree.assetsDir,
        stateDir: tree.stateDir,
        host: '127.0.0.1',
        port,
        healthIntervalMs: 10,
        healthTimeoutMs: 1_000,
      },
      processManagerDeps: {
        spawn: (() => {
          fakeAlive = true;
          const child = new FakeChildProcess(61616);
          setTimeout(() => {
            fakeAlive = false;
            child.simulateExit(1, null);
          }, 15);
          return child as unknown as ChildProcess;
        }) as unknown as typeof import('node:child_process').spawn,
        isPidAlive: (pid) => fakeAlive && pid === 61616,
      },
    });

    const status = await launcher.start();
    expect(status.state).toBe('failed');
    expect(status.error).toMatch(/exited before becoming ready/i);
  });

  test('PID-reuse guard refuses to kill an unrelated process sharing the recorded PID', async () => {
    const base = await makeTempDir('aoe-o04-pidreuse-');
    const tree = await createValidFixtureTree(base);
    const cfg: HostConfig = resolveHostConfig({
      repoRoot: tree.repoRoot,
      cwd: tree.repoRoot,
      serverEntry: tree.serverEntry,
      clientDir: tree.clientDir,
      assetsDir: tree.assetsDir,
      stateDir: tree.stateDir,
      port: await allocateEphemeralPort(),
    });

    const staleRecord: ProcessRecord = {
      pid: 77777,
      command: process.execPath,
      args: [tree.serverEntry],
      cwd: tree.repoRoot,
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      port: cfg.port,
      host: cfg.host,
      nonce: 'old-nonce',
      serverEntry: tree.serverEntry,
    };
    await writeFile(cfg.pidFilePath, JSON.stringify(staleRecord), 'utf8');

    const killSpy = vi.fn();
    const execSpy = vi.fn();

    const verification = await verifyProcessIdentity(staleRecord, {
      isPidAlive: () => true,
      inspectProcess: async (pid) => ({
        pid,
        commandLine: 'C:\\Windows\\System32\\notepad.exe',
        startedAtMs: Date.now(),
      }),
    });
    expect(verification.alive).toBe(true);
    expect(verification.matches).toBe(false);
    expect(verification.reason).toBe('pid-reused-command-mismatch');

    const pm = new ProcessManager(cfg, {
      platform: 'win32',
      isPidAlive: () => true,
      inspectProcess: async (pid) => ({
        pid,
        commandLine: 'C:\\Windows\\System32\\notepad.exe',
        startedAtMs: Date.now(),
      }),
      killProcess: killSpy,
      execFile: execSpy,
    });

    const stopResult = await pm.stopServer();
    expect(stopResult.stopped).toBe(false);
    expect(stopResult.reason).toBe('pid-reused-command-mismatch');
    expect(killSpy).not.toHaveBeenCalled();
    expect(execSpy).not.toHaveBeenCalled();

    // Stale PID file should have been cleaned up
    await expect(stat(cfg.pidFilePath)).rejects.toThrow();
  });

  test('redacts sensitive tokens in logs and rotates oversized log files', async () => {
    const base = await makeTempDir('aoe-o04-logs-');
    const logPath = join(base, 'host-server.log');

    const raw =
      'connecting https://user:myPass@example.com?token=secret123 Authorization: Bearer abc.def.ghi eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.sig';
    const safe = redactSecrets(raw);
    expect(safe).not.toContain('myPass');
    expect(safe).not.toContain('secret123');
    expect(safe).not.toContain('abc.def.ghi');
    expect(safe).not.toContain('eyJhbGci');
    expect(safe).toContain('[REDACTED]');

    appendRedactedLog(logPath, raw);
    const written = await readFile(logPath, 'utf8');
    expect(written).not.toContain('secret123');

    await writeFile(logPath, 'x'.repeat(200), 'utf8');
    await rotateLogIfNeeded(logPath, 100, 2);
    const rotated = await readFile(`${logPath}.1`, 'utf8');
    expect(rotated.length).toBe(200);
  });

  test('integrates optional TunnelAdapter on start and stop', async () => {
    const base = await makeTempDir('aoe-o04-tunnel-');
    const tree = await createValidFixtureTree(base);

    const httpServer = createHttpServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ready' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolveListen) => httpServer.listen(0, '127.0.0.1', () => resolveListen()));
    activeServers.push(httpServer);
    const port = (httpServer.address() as AddressInfo).port;

    let tunnelState: TunnelStatus = {
      state: 'stopped',
      pid: null,
      publicUrl: null,
      kind: 'temporary',
    };
    const tunnelAdapter: TunnelAdapter = {
      async start(opts) {
        tunnelState = {
          state: 'ready',
          pid: 99999,
          publicUrl: 'https://quick-demo.trycloudflare.com',
          kind: 'temporary',
        };
        expect(opts.localUrl).toBe(`http://127.0.0.1:${port}`);
        return tunnelState;
      },
      async stop() {
        tunnelState = { state: 'stopped', pid: null, publicUrl: null, kind: 'temporary' };
      },
      status() {
        return tunnelState;
      },
    };

    let fakeAlive = false;
    let fakeChild: FakeChildProcess | null = null;
    const launcher = new HostLauncher({
      config: {
        repoRoot: tree.repoRoot,
        cwd: tree.repoRoot,
        serverEntry: tree.serverEntry,
        clientDir: tree.clientDir,
        assetsDir: tree.assetsDir,
        stateDir: tree.stateDir,
        host: '0.0.0.0',
        port,
        healthIntervalMs: 10,
        healthTimeoutMs: 2_000,
      },
      preflightHooks: { checkPortAvailable: () => null },
      tunnelAdapter,
      processManagerDeps: {
        platform: 'linux',
        spawn: (() => {
          fakeAlive = true;
          fakeChild = new FakeChildProcess(81818, () => {
            fakeAlive = false;
            fakeChild?.simulateExit(0, 'SIGTERM');
          });
          return fakeChild as unknown as ChildProcess;
        }) as unknown as typeof import('node:child_process').spawn,
        isPidAlive: (pid) => fakeAlive && pid === 81818,
        inspectProcess: async (pid) =>
          fakeAlive && pid === 81818
            ? { pid, commandLine: `node ${tree.serverEntry}`, startedAtMs: Date.now() }
            : null,
        killProcess: () => {
          fakeAlive = false;
          fakeChild?.simulateExit(0, 'SIGTERM');
        },
      },
    });

    const started = await launcher.start();
    expect(started.state).toBe('ready');
    expect(started.publicUrl).toBe('https://quick-demo.trycloudflare.com');
    expect(started.publicUrlKind).toBe('temporary');

    const stopped = await launcher.stop();
    expect(stopped.state).toBe('stopped');
    expect(tunnelAdapter.status().state).toBe('stopped');
  });

  test('preflight rejects unbuilt client and missing owner1..4 variants via auditMultiplayerAssets', async () => {
    const base = await makeTempDir('aoe-o02-audit-');
    const tree = await createValidFixtureTree(base);
    const port = await allocateEphemeralPort();

    await writeFile(join(tree.clientDir, 'index.html'), '<script type="module" src="/src/main.ts"></script>', 'utf8');
    await rm(join(tree.assetsDir, 'sprites', 'graphics', '10.o4.png'));

    const cfg = resolveHostConfig({
      repoRoot: tree.repoRoot,
      cwd: tree.repoRoot,
      serverEntry: tree.serverEntry,
      clientDir: tree.clientDir,
      assetsDir: tree.assetsDir,
      stateDir: tree.stateDir,
      port,
    });
    const res = await runPreflight(cfg);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('/src/main.ts'))).toBe(true);
    expect(res.errors.some((e) => e.includes('owner1..4') && e.includes('10.o4.png'))).toBe(true);
  });

  test('wires tunnelConfig into createTunnelAdapter and validates /api/versions on startup', async () => {
    const base = await makeTempDir('aoe-o07-wired-');
    const tree = await createValidFixtureTree(base);

    const httpServer = createHttpServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ready' }));
        return;
      }
      if (req.url === '/api/versions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ protocol: 'mp4-v1', rules: 'sim-v1', build: 'build-1', assets: 'pack-1' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolveListen) => httpServer.listen(0, '127.0.0.1', () => resolveListen()));
    activeServers.push(httpServer);
    const port = (httpServer.address() as AddressInfo).port;

    let serverAlive = false;
    let fakeServerChild: FakeChildProcess | null = null;
    const launcher = new HostLauncher({
      config: {
        repoRoot: tree.repoRoot,
        cwd: tree.repoRoot,
        serverEntry: tree.serverEntry,
        clientDir: tree.clientDir,
        assetsDir: tree.assetsDir,
        stateDir: tree.stateDir,
        host: '0.0.0.0',
        port,
        healthIntervalMs: 10,
        healthTimeoutMs: 2_000,
      },
      preflightHooks: { checkPortAvailable: () => null },
      tunnelConfig: {
        provider: 'cloudflared',
        executable: 'cloudflared',
        spawn: () => {
          const proc = new FakeChildProcess(91919);
          setTimeout(() => {
            proc.stderr.write('https://wired-demo.trycloudflare.com\n');
          }, 10);
          const originalKill = proc.kill.bind(proc);
          proc.kill = (sig) => {
            const r = originalKill(sig);
            proc.simulateExit(0, typeof sig === 'string' ? sig : null);
            proc.emit('close', 0, typeof sig === 'string' ? sig : null);
            return r;
          };
          return proc;
        },
      },
      processManagerDeps: {
        platform: 'linux',
        spawn: (() => {
          serverAlive = true;
          fakeServerChild = new FakeChildProcess(82828, () => {
            serverAlive = false;
            fakeServerChild?.simulateExit(0, 'SIGTERM');
          });
          return fakeServerChild as unknown as ChildProcess;
        }) as unknown as typeof import('node:child_process').spawn,
        isPidAlive: (pid) => serverAlive && pid === 82828,
        inspectProcess: async (pid) =>
          serverAlive && pid === 82828
            ? { pid, commandLine: `node ${tree.serverEntry}`, startedAtMs: Date.now() }
            : null,
        killProcess: () => {
          serverAlive = false;
          fakeServerChild?.simulateExit(0, 'SIGTERM');
        },
      },
    });

    const started = await launcher.start();
    expect(started.state).toBe('ready');
    expect(started.publicUrl).toBe('https://wired-demo.trycloudflare.com');
    expect(started.publicUrlKind).toBe('temporary');

    const stopped = await launcher.stop();
    expect(stopped.state).toBe('stopped');
    expect(stopped.publicUrl).toBeNull();
  });
});
