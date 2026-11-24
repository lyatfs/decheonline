import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { PackManifest } from './manifest';
import { auditMultiplayerAssets } from './multiplayer-audit';

const tempDirs: string[] = [];

function createTempPackDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aoe-mp-audit-'));
  tempDirs.push(dir);
  return dir;
}

function writePackFile(root: string, rel: string, content: string | Uint8Array = 'stub'): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function buildValidFixturePack(root: string): PackManifest {
  const manifest: PackManifest = {
    version: 16,
    palette: 'palette.json',
    dat: 'empires.dat',
    slps: {
      'graphics/100': {
        source: 'graphics',
        id: 100,
        atlasWidth: 32,
        atlasHeight: 32,
        frames: [
          { x: 0, y: 0, w: 16, h: 16, hotspotX: 8, hotspotY: 15 },
          { x: 16, y: 0, w: 16, h: 16, hotspotX: 8, hotspotY: 15 },
        ],
        playerColour: true,
      },
      'graphics/101': {
        source: 'graphics',
        id: 101,
        atlasWidth: 16,
        atlasHeight: 16,
        frames: [{ x: 0, y: 0, w: 16, h: 16, hotspotX: 8, hotspotY: 8 }],
        playerColour: false,
      },
      'terrain/15000': {
        source: 'terrain',
        id: 15000,
        atlasWidth: 64,
        atlasHeight: 32,
        frames: [{ x: 0, y: 0, w: 64, h: 32, hotspotX: 0, hotspotY: 0 }],
        playerColour: false,
      },
      'border/20000': {
        source: 'border',
        id: 20000,
        atlasWidth: 64,
        atlasHeight: 32,
        frames: [{ x: 0, y: 0, w: 64, h: 32, hotspotX: 0, hotspotY: 0 }],
        playerColour: false,
      },
      'interface/50100': {
        source: 'interface',
        id: 50100,
        atlasWidth: 64,
        atlasHeight: 64,
        frames: [{ x: 0, y: 0, w: 64, h: 64, hotspotX: 0, hotspotY: 0 }],
        playerColour: false,
      },
    },
    graphics: {
      '0': {
        name: 'Villager_Stand',
        slp: 'graphics/100',
        frameCount: 2,
        angleCount: 1,
        mirroringMode: 0,
        frameDuration: 0.1,
        layer: 20,
        deltas: [],
        sound: -1,
        frameSounds: null,
      },
      '1': {
        name: 'Shared_Prop',
        slp: 'graphics/101',
        frameCount: 1,
        angleCount: 1,
        mirroringMode: 0,
        frameDuration: 0,
        layer: 20,
        deltas: [],
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
        minimap: [10, 20, 30],
        sound: -1,
      },
    },
    borders: {
      '0': {
        name: 'Grass_Border',
        slp: 'border/20000',
        style: 0,
        drawTile: 0,
        frames: [[[1, 1, 0]]],
      },
    },
    units: {
      '83': {
        name: 'Villager',
        standingGraphic: 0,
        icon: 0,
        hitPoints: 25,
        button: 1,
        outline: [0.2, 0.2, 1.7],
        nameId: 5131,
        creationId: 6131,
        hotkeyId: 16132,
        level: 3,
        displayed: [3, 0, 0, 0],
        selectLevel: 4,
        minimap: [2, 0],
        doppelganger: 0,
      },
    },
    techs: {},
    cultures: [0, 0],
    playerColours: [24, 223, 30, 71],
    minimap: null,
    tileEdges: null,
    strings: {},
    sounds: {},
    unitSounds: {},
    wavs: [50301],
    screens: {
      '50057': {
        backgrounds: [50100, -1, -1],
        position: 0,
        shade: 50,
        background: 0,
        bevels: [0, 0, 0, 0, 0, 0],
        text: [0xffffff, 0],
        focus: [0xffff00, 0],
        state: [0xffffff, 0],
      },
    },
    taunts: [1],
    soundFiles: ['wind.wav'],
    music: {
      tracks: 1,
      files: ['open.mid'],
      bank: 'music/bank.dls',
    },
  };

  writePackFile(root, 'manifest.json', JSON.stringify(manifest));
  writePackFile(root, 'palette.json', JSON.stringify({ rgb: new Array(768).fill(0) }));
  writePackFile(root, 'empires.dat', new Uint8Array([1, 2, 3, 4]));
  for (const owner of [1, 2, 3, 4]) {
    writePackFile(root, `sprites/graphics/100.o${owner}.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  }
  writePackFile(root, 'sprites/graphics/101.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  writePackFile(root, 'sprites/terrain/15000.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  writePackFile(root, 'sprites/border/20000.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  writePackFile(root, 'sprites/interface/50100.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  writePackFile(root, 'sounds/50301.wav', 'RIFF');
  writePackFile(root, 'sounds/taunt1.wav', 'RIFF');
  writePackFile(root, 'sounds/file/wind.wav', 'RIFF');
  writePackFile(root, 'music/music1.mid', 'MThd');
  writePackFile(root, 'music/open.mid', 'MThd');
  writePackFile(root, 'music/bank.dls', 'RIFF');
  return manifest;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('M08 multiplayer asset audit (H04, V02)', () => {
  test('H04: passes when owner 1..4 atlases and referenced files exist (even without o5..o8)', () => {
    const dir = createTempPackDir();
    buildValidFixturePack(dir);

    const report = auditMultiplayerAssets(dir);
    expect(report.ok).toBe(true);
    expect(report.assetsDir).toBe(dir);
    expect(report.packVersion).toBe('16');
    expect(report.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.checkedGraphics).toBe(2);
    expect(report.missingFiles).toEqual([]);
    expect(report.missingOwnerVariants).toEqual([]);
    expect(report.invalidFrames).toEqual([]);
    expect(report.classifiedRedirects).toEqual([]);
    expect(report.errors).toEqual([]);
  });

  test('H04: classifies null, unused, fallback, and terrain-draw redirects accurately without false missing errors', () => {
    const dir = createTempPackDir();
    const manifest = buildValidFixturePack(dir);

    // Add an unused SLP with NO png files on disk (must be classified as unused, NOT missing)
    manifest.slps['graphics/999'] = {
      source: 'graphics',
      id: 999,
      atlasWidth: 16,
      atlasHeight: 16,
      frames: [{ x: 0, y: 0, w: 16, h: 16, hotspotX: 0, hotspotY: 0 }],
      playerColour: true,
    };
    // Null graphic (Blank)
    manifest.graphics['2'] = {
      name: 'Blank',
      slp: null,
      frameCount: 1,
      angleCount: 1,
      mirroringMode: 0,
      frameDuration: 0,
      layer: 20,
      deltas: [],
      sound: -1,
      frameSounds: null,
    };
    // Fallback graphic (delta-only composite without its own SLP)
    manifest.graphics['3'] = {
      name: 'Composite_Building',
      slp: null,
      frameCount: 1,
      angleCount: 1,
      mirroringMode: 0,
      frameDuration: 0,
      layer: 20,
      deltas: [[1, 0, 0, -1]],
      sound: -1,
      frameSounds: null,
    };
    // Terrain-draw redirect & null terrain & null border
    manifest.terrains['1'] = {
      name: 'Forest',
      slp: null,
      rows: 1,
      cols: 1,
      tiles: [[1, 1, 0]],
      draw: 0,
      borders: [0, 0],
      minimap: [10, 20, 30],
      sound: -1,
    };
    manifest.terrains['2'] = {
      name: 'Fog_Null',
      slp: null,
      rows: 1,
      cols: 1,
      tiles: [[1, 1, 0]],
      draw: -1,
      borders: [0, 0, 0],
      minimap: [0, 0, 0],
      sound: -1,
    };
    manifest.borders['1'] = {
      name: 'Non-visible',
      slp: null,
      style: 0,
      drawTile: 0,
      frames: [],
    };
    writePackFile(dir, 'manifest.json', JSON.stringify(manifest));

    const report = auditMultiplayerAssets(dir);
    expect(report.ok).toBe(true);
    expect(report.missingFiles).toEqual([]);
    expect(report.missingOwnerVariants).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.classifiedRedirects).toEqual(
      expect.arrayContaining([
        { kind: 'null', ref: 'graphic:2' },
        { kind: 'fallback', ref: 'graphic:3' },
        { kind: 'terrain-draw', ref: 'terrain:1->0' },
        { kind: 'null', ref: 'terrain:2' },
        { kind: 'null', ref: 'border:1' },
        { kind: 'unused', ref: 'slp:graphics/999' },
      ]),
    );
  });

  test('V02: detects missing owner 1..4 variants explicitly and marks ok=false', () => {
    const dir = createTempPackDir();
    buildValidFixturePack(dir);
    rmSync(join(dir, 'sprites', 'graphics', '100.o3.png'));
    rmSync(join(dir, 'sprites', 'graphics', '100.o4.png'));

    const report = auditMultiplayerAssets(dir);
    expect(report.ok).toBe(false);
    expect(report.missingOwnerVariants).toEqual([
      { graphicId: 0, owner: 3, path: 'sprites/graphics/100.o3.png' },
      { graphicId: 0, owner: 4, path: 'sprites/graphics/100.o4.png' },
    ]);
    expect(report.missingFiles).toEqual(
      expect.arrayContaining(['sprites/graphics/100.o3.png', 'sprites/graphics/100.o4.png']),
    );
  });

  test('V02: detects missing manifest/pack files, version mismatch, broken terrain-draw, and invalid frame limits/bounds', () => {
    // 1) Missing directory
    const missingDir = join(createTempPackDir(), 'non-existent');
    const rMissingDir = auditMultiplayerAssets(missingDir);
    expect(rMissingDir.ok).toBe(false);
    expect(rMissingDir.errors.length).toBeGreaterThan(0);

    // 2) Missing manifest.json
    const noManifest = createTempPackDir();
    const rNoManifest = auditMultiplayerAssets(noManifest);
    expect(rNoManifest.ok).toBe(false);
    expect(rNoManifest.missingFiles).toContain('manifest.json');

    // 3) Bad version, missing sound/dat, broken terrain.draw, and invalid frames
    const broken = createTempPackDir();
    const manifest = buildValidFixturePack(broken);
    manifest.version = 15;
    manifest.graphics['0']!.frameCount = 5000;
    manifest.slps['graphics/101']!.frames = [{ x: 0, y: 0, w: 32, h: 16, hotspotX: 0, hotspotY: 0 }]; // exceeds atlasWidth 16
    manifest.terrains['5'] = {
      name: 'Broken_Redirect',
      slp: null,
      rows: 1,
      cols: 1,
      tiles: [[1, 1, 0]],
      draw: 99,
      borders: [],
      minimap: [0, 0, 0],
      sound: -1,
    };
    writePackFile(broken, 'manifest.json', JSON.stringify(manifest));
    rmSync(join(broken, 'empires.dat'));
    rmSync(join(broken, 'sounds', '50301.wav'));

    const rBroken = auditMultiplayerAssets(broken);
    expect(rBroken.ok).toBe(false);
    expect(rBroken.packVersion).toBe('15');
    expect(rBroken.missingFiles).toEqual(expect.arrayContaining(['empires.dat', 'sounds/50301.wav']));
    expect(rBroken.invalidFrames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ graphicId: 0, frameCount: 5000 }),
        expect.objectContaining({ graphicId: 1 }),
      ]),
    );
    expect(rBroken.errors.some((e) => e.includes('unsupported pack version'))).toBe(true);
    expect(rBroken.errors.some((e) => e.includes('missing terrain 99'))).toBe(true);
  });

  test('manifestHash is deterministic across key reordering and changes when asset bytes/sizes or manifest change', () => {
    const dirA = createTempPackDir();
    const manifestA = buildValidFixturePack(dirA);
    const reportA1 = auditMultiplayerAssets(dirA);
    const reportA2 = auditMultiplayerAssets(dirA);
    expect(reportA1.manifestHash).toBe(reportA2.manifestHash);

    // Reorder keys in manifest.json -> hash must stay identical
    const reordered = {
      music: manifestA.music,
      units: manifestA.units,
      terrains: manifestA.terrains,
      graphics: manifestA.graphics,
      slps: manifestA.slps,
      dat: manifestA.dat,
      palette: manifestA.palette,
      version: manifestA.version,
      borders: manifestA.borders,
      techs: manifestA.techs,
      cultures: manifestA.cultures,
      playerColours: manifestA.playerColours,
      minimap: manifestA.minimap,
      tileEdges: manifestA.tileEdges,
      strings: manifestA.strings,
      sounds: manifestA.sounds,
      unitSounds: manifestA.unitSounds,
      wavs: manifestA.wavs,
      screens: manifestA.screens,
      taunts: manifestA.taunts,
      soundFiles: manifestA.soundFiles,
    };
    writePackFile(dirA, 'manifest.json', JSON.stringify(reordered));
    const reportReordered = auditMultiplayerAssets(dirA);
    expect(reportReordered.manifestHash).toBe(reportA1.manifestHash);

    // Mutate an asset file size -> hash must change
    writePackFile(dirA, 'sprites/graphics/100.o2.png', new Uint8Array(64));
    const reportMutatedAsset = auditMultiplayerAssets(dirA);
    expect(reportMutatedAsset.manifestHash).not.toBe(reportA1.manifestHash);
  });
});
