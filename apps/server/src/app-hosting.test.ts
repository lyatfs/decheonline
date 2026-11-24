import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { PACK_VERSION, type PackManifest } from '@aoe/assets-import/manifest';
import {
  DEFAULT_COMPATIBILITY_VERSIONS,
  isCompatibilityVersions,
  type CompatibilityVersions,
  type ServerMessage,
} from '@aoe/protocol';
import { buildVersionStamp } from '../../client/vite.config';
import { createApp } from './app';
import { auditAssetsPack, type OwnerAtlasAuditReport } from './assets';
import { resolveServerConfig } from './main';
import { RoomRegistry } from './rooms';
import { computeCompatibilityVersions, normalizePublicUrl, verifyClientBuild } from './versions';

async function writeValidClientBuild(clientDir: string, bundleScript = 'console.log("aoe-prod");'): Promise<void> {
  await mkdir(join(clientDir, 'bundle'), { recursive: true });
  await writeFile(
    join(clientDir, 'index.html'),
    '<!doctype html><html><head><script type="module" src="/bundle/index-abc123.js"></script></head><body></body></html>',
  );
  await writeFile(join(clientDir, 'bundle', 'index-abc123.js'), bundleScript);
  await writeFile(join(clientDir, 'bundle', 'index-abc123.css'), 'body{margin:0}');
}

async function writeValidAssetsPack(packDir: string, datContent = 'VER 3.7-fixture'): Promise<void> {
  await mkdir(join(packDir, 'sprites', 'graphics'), { recursive: true });
  await mkdir(join(packDir, 'sprites', 'terrain'), { recursive: true });
  await writeFile(join(packDir, 'palette.json'), JSON.stringify({ rgb: new Array(768).fill(0) }));
  await writeFile(join(packDir, 'empires.dat'), datContent);

  const pngStub = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeFile(join(packDir, 'sprites', 'graphics', '0.png'), pngStub);
  for (const owner of [1, 2, 3, 4]) {
    await writeFile(join(packDir, 'sprites', 'graphics', `10.o${owner}.png`), pngStub);
  }
  await writeFile(join(packDir, 'sprites', 'terrain', '15000.png'), pngStub);

  const frame = [{ x: 0, y: 0, w: 8, h: 8, hotspotX: 4, hotspotY: 4 }];
  const manifest: PackManifest = {
    version: PACK_VERSION,
    palette: 'palette.json',
    dat: 'empires.dat',
    slps: {
      'graphics/0': { source: 'graphics', id: 0, atlasWidth: 8, atlasHeight: 8, frames: frame, playerColour: false },
      'graphics/10': { source: 'graphics', id: 10, atlasWidth: 8, atlasHeight: 8, frames: frame, playerColour: true },
      'graphics/999': { source: 'graphics', id: 999, atlasWidth: 8, atlasHeight: 8, frames: frame, playerColour: false },
      'terrain/15000': { source: 'terrain', id: 15000, atlasWidth: 64, atlasHeight: 32, frames: frame, playerColour: false },
    },
    graphics: {
      '0': {
        name: 'Stand',
        slp: 'graphics/0',
        frameCount: 1,
        angleCount: 1,
        mirroringMode: 0,
        frameDuration: 0,
        layer: 10,
        deltas: [],
        sound: -1,
        frameSounds: null,
      },
      '10': {
        name: 'Villager',
        slp: 'graphics/10',
        frameCount: 1,
        angleCount: 1,
        mirroringMode: 0,
        frameDuration: 0,
        layer: 20,
        deltas: [],
        sound: -1,
        frameSounds: null,
      },
      '11': {
        name: 'NullEntry',
        slp: null,
        frameCount: 0,
        angleCount: 1,
        mirroringMode: 0,
        frameDuration: 0,
        layer: 0,
        deltas: [],
        sound: -1,
        frameSounds: null,
      },
      '12': {
        name: 'FallbackComposite',
        slp: null,
        frameCount: 1,
        angleCount: 1,
        mirroringMode: 0,
        frameDuration: 0,
        layer: 20,
        deltas: [[10, 0, 0, -1]],
        sound: -1,
        frameSounds: null,
      },
    },
    terrains: {
      '0': {
        name: 'Grass',
        slp: 'terrain/15000',
        rows: 1,
        cols: 1,
        tiles: [[1, 1, 0]],
        draw: -1,
        borders: [0],
        minimap: [1, 2, 3],
        sound: -1,
      },
      '1': {
        name: 'DesertRedirect',
        slp: null,
        rows: 1,
        cols: 1,
        tiles: [[1, 1, 0]],
        draw: 0,
        borders: [0],
        minimap: [1, 2, 3],
        sound: -1,
      },
    },
    borders: {},
    units: {},
    techs: {},
    cultures: [0, 0],
    playerColours: [16, 32, 48, 64],
    minimap: null,
    tileEdges: null,
    strings: {},
    sounds: {},
    unitSounds: {},
    wavs: [],
    screens: {},
    taunts: [],
    soundFiles: [],
    music: null,
  };
  await writeFile(join(packDir, 'manifest.json'), JSON.stringify(manifest));
}

async function openWs(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

function nextWsMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise<ServerMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for ws message')), 5000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as ServerMessage);
    });
  });
}

describe('M11 server hosting integration & readiness (O06, V02)', () => {
  const tempDirs: string[] = [];
  const servers: Server[] = [];

  async function makeTempDir(prefix = 'aoe-m11-'): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function listenApp(app: Server): Promise<{ base: string; wsUrl: string }> {
    servers.push(app);
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    const { port } = app.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws` };
  }

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  test('V01: stamped production HTML retains the same build identity as the unstamped build', async () => {
    const root = await makeTempDir();
    const clientDir = join(root, 'client');
    await writeValidClientBuild(clientDir);
    const before = verifyClientBuild(clientDir);
    const stamp = buildVersionStamp(clientDir).closeBundle;
    if (typeof stamp !== 'function') throw new Error('Missing production stamp hook');
    await stamp.call({} as never);
    const stamped = await readFile(join(clientDir, 'index.html'), 'utf8');
    expect(stamped).toContain(`content="${before.buildId}"`);
    expect(verifyClientBuild(clientDir).buildId).toBe(before.buildId);
    await stamp.call({} as never);
    expect(await readFile(join(clientDir, 'index.html'), 'utf8')).toBe(stamped);
  });

  test('O06: serves /health, /api/versions, /api/health, static client/assets, and enforces identical versions on /ws', async () => {
    const root = await makeTempDir();
    const clientDir = join(root, 'client');
    const assetsDir = join(root, 'pack');
    await writeValidClientBuild(clientDir);
    await writeValidAssetsPack(assetsDir);

    const app = createApp({ clientDir, assetsDir });
    const { base, wsUrl } = await listenApp(app);

    const legacyHealth = await fetch(`${base}/health`);
    expect(legacyHealth.status).toBe(200);
    expect(await legacyHealth.json()).toEqual({ status: 'ok' });

    const versionsRes = await fetch(`${base}/api/versions`);
    expect(versionsRes.status).toBe(200);
    const versions = (await versionsRes.json()) as CompatibilityVersions;
    expect(isCompatibilityVersions(versions)).toBe(true);
    expect(versions.protocol).toBe('mp4-v1');
    expect(versions.rules).toBe('sim-v1');
    expect(versions.build).toMatch(/^build-[0-9a-f]{16}$/);
    expect(versions.assets).toMatch(/^pack-16-[0-9a-f]{16}$/);

    const apiHealthRes = await fetch(`${base}/api/health`);
    expect(apiHealthRes.status).toBe(200);
    expect(await apiHealthRes.json()).toEqual({ status: 'ready', versions });

    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/bundle/index-abc123.js`)).status).toBe(200);
    expect((await fetch(`${base}/assets/sprites/graphics/10.o4.png`)).status).toBe(200);

    expect((await fetch(`${base}/api/versions`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/api/health`, { method: 'HEAD' })).status).toBe(200);

    const ws = await openWs(wsUrl);
    try {
      ws.send(JSON.stringify({ t: 'create', name: 'BadPeer', capacity: 4, versions: DEFAULT_COMPATIBILITY_VERSIONS }));
      const rejected = await nextWsMessage(ws);
      expect(rejected).toMatchObject({ t: 'error', code: 'version-mismatch' });

      ws.send(JSON.stringify({ t: 'create', name: 'HostPeer', capacity: 4, versions }));
      const lobby = await nextWsMessage(ws);
      expect(lobby).toMatchObject({ t: 'lobby', capacity: 4, hostSlot: 0, versions });
    } finally {
      ws.close();
    }
  });

  test('O06: explicit versions option shares authority across /api/versions and RoomRegistry', async () => {
    const root = await makeTempDir();
    const clientDir = join(root, 'client');
    const assetsDir = join(root, 'pack');
    await writeValidClientBuild(clientDir);
    await writeValidAssetsPack(assetsDir);

    const custom: CompatibilityVersions = {
      protocol: 'mp4-v1',
      rules: 'sim-v1',
      build: 'dev-override',
      assets: 'pack-override',
    };
    const app = createApp({ clientDir, assetsDir, versions: custom });
    const { base, wsUrl } = await listenApp(app);

    expect(await (await fetch(`${base}/api/versions`)).json()).toEqual(custom);
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ status: 'ready', versions: custom });

    const ws = await openWs(wsUrl);
    try {
      ws.send(JSON.stringify({ t: 'create', name: 'OverrideHost', capacity: 4, versions: custom }));
      const lobby = await nextWsMessage(ws);
      expect(lobby).toMatchObject({ t: 'lobby', versions: custom });
    } finally {
      ws.close();
    }
  });

  test('V01: injected registry shares its authority with HTTP and rejects a conflicting override', async () => {
    const versions = { ...DEFAULT_COMPATIBILITY_VERSIONS, build: 'injected-build' };
    const rooms = new RoomRegistry({ versions });
    const app = createApp({ rooms });
    const { base, wsUrl } = await listenApp(app);
    expect(await (await fetch(`${base}/api/versions`)).json()).toEqual(versions);
    const ws = await openWs(wsUrl);
    try {
      ws.send(JSON.stringify({ t: 'create', name: 'InjectedHost', capacity: 4, versions }));
      expect(await nextWsMessage(ws)).toMatchObject({ t: 'lobby', versions });
    } finally {
      ws.close();
    }
    expect(() => createApp({ rooms, versions: DEFAULT_COMPATIBILITY_VERSIONS })).toThrow('conflicting compatibility versions');
  });

  test('V02: /api/health returns 503 not-ready when client build or asset pack or owner1..4 variants are missing', async () => {
    const root = await makeTempDir();
    const missingClient = join(root, 'no-client');
    const missingPack = join(root, 'no-pack');

    const appMissing = createApp({ clientDir: missingClient, assetsDir: missingPack });
    const { base: baseMissing } = await listenApp(appMissing);

    expect(await (await fetch(`${baseMissing}/api/versions`)).json()).toEqual(DEFAULT_COMPATIBILITY_VERSIONS);
    const missingHealthRes = await fetch(`${baseMissing}/api/health`);
    expect(missingHealthRes.status).toBe(503);
    const missingHealth = (await missingHealthRes.json()) as {
      status: string;
      versions: CompatibilityVersions;
      reasons: string[];
    };
    expect(missingHealth.status).toBe('not-ready');
    expect(missingHealth.versions).toEqual(DEFAULT_COMPATIBILITY_VERSIONS);
    expect(missingHealth.reasons.length).toBeGreaterThan(0);
    expect(JSON.stringify(missingHealth)).not.toContain(root);

    // Valid client, pack missing owner3 variant -> 503 with owner1..4 reason and no leaked path.
    const clientDir = join(root, 'client');
    const assetsDir = join(root, 'pack');
    await writeValidClientBuild(clientDir);
    await writeValidAssetsPack(assetsDir);
    await unlink(join(assetsDir, 'sprites', 'graphics', '10.o3.png'));

    const appBrokenOwner = createApp({ clientDir, assetsDir });
    const { base: baseBroken } = await listenApp(appBrokenOwner);
    const brokenRes = await fetch(`${baseBroken}/api/health`);
    expect(brokenRes.status).toBe(503);
    const brokenBody = (await brokenRes.json()) as { status: string; reasons: string[]; versions: CompatibilityVersions };
    expect(brokenBody.status).toBe('not-ready');
    expect(brokenBody.reasons.some((r) => r.includes('owner1..4') || r.includes('10.o3.png'))).toBe(true);
    expect(JSON.stringify(brokenBody)).not.toContain(root);
  });

  test('V02: auditAssetsPack classifies null, fallback, terrain-draw, and unused SLPs without false positives', async () => {
    const root = await makeTempDir();
    const assetsDir = join(root, 'pack');
    await writeValidAssetsPack(assetsDir);

    const report = auditAssetsPack(assetsDir);
    expect(report.ok).toBe(true);
    expect(report.missingFiles).toEqual([]);
    expect(report.missingOwnerVariants).toEqual([]);
    expect(report.classifiedRedirects).toEqual(
      expect.arrayContaining([
        { kind: 'null', ref: 'graphic:11' },
        { kind: 'fallback', ref: 'graphic:12' },
        { kind: 'terrain-draw', ref: 'terrain:1->0' },
        { kind: 'unused', ref: 'slp:graphics/999' },
      ]),
    );
  });

  test('V02: supports injected M08-compatible auditPack hook and unbuilt dev index.html rejection', async () => {
    const root = await makeTempDir();
    const clientDir = join(root, 'client');
    const assetsDir = join(root, 'pack');
    await writeValidClientBuild(clientDir);
    await writeValidAssetsPack(assetsDir);

    const devClientDir = join(root, 'dev-client');
    await mkdir(join(devClientDir, 'bundle'), { recursive: true });
    await writeFile(join(devClientDir, 'index.html'), '<script type="module" src="/src/main.ts"></script>');
    await writeFile(join(devClientDir, 'bundle', 'index-dev.js'), 'export {};');
    expect(verifyClientBuild(devClientDir).ok).toBe(false);

    const fakeAudit = (): OwnerAtlasAuditReport => ({
      ok: false,
      assetsDir,
      packVersion: '16',
      manifestHash: 'deadbeef',
      checkedGraphics: 1,
      missingFiles: ['sprites/graphics/42.o2.png'],
      missingOwnerVariants: [{ graphicId: 42, owner: 2, path: 'sprites/graphics/42.o2.png' }],
      invalidFrames: [],
      classifiedRedirects: [],
      errors: [`missing file inside ${assetsDir}`],
    });

    const app = createApp({ clientDir, assetsDir, auditPack: fakeAudit });
    const { base } = await listenApp(app);
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; reasons: string[] };
    expect(body.status).toBe('not-ready');
    expect(JSON.stringify(body)).not.toContain(root);
    expect(body.reasons.some((r) => r.includes('owner1..4'))).toBe(true);
  });

  test('V02: computed versions are deterministic across directories and sensitive to client/dat edits', async () => {
    const rootA = await makeTempDir('aoe-det-a-');
    const rootB = await makeTempDir('aoe-det-b-');
    await writeValidClientBuild(join(rootA, 'client'));
    await writeValidAssetsPack(join(rootA, 'pack'));
    await writeValidClientBuild(join(rootB, 'client'));
    await writeValidAssetsPack(join(rootB, 'pack'));

    const vA = computeCompatibilityVersions({ clientDir: join(rootA, 'client'), assetsDir: join(rootA, 'pack') });
    const vB = computeCompatibilityVersions({ clientDir: join(rootB, 'client'), assetsDir: join(rootB, 'pack') });
    expect(vA).toEqual(vB);

    await writeValidAssetsPack(join(rootB, 'pack'), 'VER 3.7-modified');
    const vModifiedDat = computeCompatibilityVersions({ clientDir: join(rootB, 'client'), assetsDir: join(rootB, 'pack') });
    expect(vModifiedDat.assets).not.toBe(vA.assets);
    expect(vModifiedDat.build).toBe(vA.build);

    await writeValidClientBuild(join(rootB, 'client'), 'console.log("aoe-prod-v2");');
    const vModifiedClient = computeCompatibilityVersions({ clientDir: join(rootB, 'client'), assetsDir: join(rootB, 'pack') });
    expect(vModifiedClient.build).not.toBe(vA.build);
  });

  test('O06: resolveServerConfig and normalizePublicUrl handle Unicode/space paths and avoid credential leaks', async () => {
    const root = await makeTempDir('Máy chủ Test ');
    const cfg = resolveServerConfig({
      HOST: '127.0.0.1',
      PORT: '9090',
      ASSETS_DIR: join(root, 'pack có dấu'),
      CLIENT_DIR: join(root, 'client dist'),
      PUBLIC_URL: 'https://play.example.com/some/path?token=secret',
    });
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(9090);
    expect(cfg.assetsDir).toBe(join(root, 'pack có dấu'));
    expect(cfg.clientDir).toBe(join(root, 'client dist'));

    const normalized = normalizePublicUrl(cfg.publicUrl);
    expect(normalized).toEqual({ ok: true, origin: 'https://play.example.com' });

    expect(normalizePublicUrl('https://user:pass@play.example.com')).toEqual({
      ok: false,
      reason: 'PUBLIC_URL must not contain credentials',
    });
    expect(normalizePublicUrl('ftp://play.example.com')).toEqual({
      ok: false,
      reason: 'invalid PUBLIC_URL protocol',
    });
    expect(() => resolveServerConfig({ PORT: '70000' })).toThrow('Invalid PORT configuration');
    expect(resolveServerConfig({}).host).toBe('0.0.0.0');
    expect(resolveServerConfig({}).port).toBe(8787);
  });
});
