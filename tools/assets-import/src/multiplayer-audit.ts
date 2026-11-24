import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { PackManifest, PackSlp } from './manifest';

const EXPECTED_PACK_VERSION = 16;
const REQUIRED_MULTIPLAYER_OWNERS = [1, 2, 3, 4] as const;
const MAX_GRAPHIC_FRAMES = 4096;

export interface OwnerAtlasAuditReport {
  ok: boolean;
  assetsDir: string;
  packVersion: string;
  manifestHash: string;
  checkedGraphics: number;
  missingFiles: string[];
  missingOwnerVariants: Array<{ graphicId: number; owner: number; path: string }>;
  invalidFrames: Array<{ graphicId: number; frameCount: number; limit: number }>;
  classifiedRedirects: Array<{ kind: 'null' | 'unused' | 'fallback' | 'terrain-draw'; ref: string }>;
  errors: string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function slpImageRelPath(slp: Pick<PackSlp, 'source' | 'id' | 'playerColour'>, owner = 1): string {
  return slp.playerColour
    ? `sprites/${slp.source}/${slp.id}.o${owner}.png`
    : `sprites/${slp.source}/${slp.id}.png`;
}

function resolvePackFile(root: string, relPath: string): { path: string; size: number } | null {
  if (!relPath || isAbsolute(relPath)) return null;
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.split('/').some((part) => part === '..')) return null;
  try {
    const candidate = resolve(root, normalized);
    if (!candidate.startsWith(root + sep)) return null;
    const info = statSync(candidate);
    if (!info.isFile() || info.size <= 0) return null;
    return { path: candidate, size: info.size };
  } catch {
    return null;
  }
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(record[k])}`).join(',')}}`;
}

function computeManifestHash(manifest: unknown, assetSizes: Map<string, number>): string {
  const hash = createHash('sha256');
  hash.update(canonicalStringify(manifest));
  const sortedEntries = [...assetSizes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [rel, size] of sortedEntries) {
    hash.update(`\0${rel}:${size}`);
  }
  return hash.digest('hex');
}

function collectUsedGraphics(manifest: PackManifest): Set<number> {
  const used = new Set<number>();
  const queue: number[] = [];
  for (const unit of Object.values(manifest.units ?? {})) {
    if (!unit || typeof unit.standingGraphic !== 'number') continue;
    if (unit.standingGraphic >= 0 && !used.has(unit.standingGraphic)) {
      used.add(unit.standingGraphic);
      queue.push(unit.standingGraphic);
    }
  }
  while (queue.length > 0) {
    const gid = queue.shift()!;
    const graphic = manifest.graphics?.[String(gid)];
    if (!graphic || !Array.isArray(graphic.deltas)) continue;
    for (const delta of graphic.deltas) {
      const target = Array.isArray(delta) ? delta[0] : -1;
      if (typeof target === 'number' && target >= 0 && !used.has(target)) {
        used.add(target);
        queue.push(target);
      }
    }
  }
  return used;
}

function validSlpFrameRects(slp: PackSlp): boolean {
  if (!Array.isArray(slp.frames) || slp.frames.length === 0) return false;
  if (typeof slp.atlasWidth !== 'number' || typeof slp.atlasHeight !== 'number') return false;
  if (!Number.isFinite(slp.atlasWidth) || !Number.isFinite(slp.atlasHeight)) return false;
  if (slp.atlasWidth <= 0 || slp.atlasHeight <= 0) return false;
  for (const f of slp.frames) {
    if (!f || typeof f.x !== 'number' || typeof f.y !== 'number' || typeof f.w !== 'number' || typeof f.h !== 'number') return false;
    if (!Number.isFinite(f.x) || !Number.isFinite(f.y) || !Number.isFinite(f.w) || !Number.isFinite(f.h)) return false;
    if (f.x < 0 || f.y < 0 || f.w < 0 || f.h < 0) return false;
    if (f.x + f.w > slp.atlasWidth || f.y + f.h > slp.atlasHeight) return false;
  }
  return true;
}

/**
 * Audits an asset pack directory without mutating any files:
 * - Verifies `manifest.json`, `palette`, `dat`, audio/music, terrains, borders, screens, and graphic SLPs on disk.
 * - Verifies `owner 1..4` atlases for player-colored graphics.
 * - Validates graphic frame limits and atlas frame bounds.
 * - Classifies `null`, `unused`, `fallback` (delta-only), and `terrain-draw` redirects without false positives.
 * - Computes a deterministic SHA-256 `manifestHash` over canonical manifest + referenced asset metadata.
 */
export function auditMultiplayerAssets(assetsDir: string): OwnerAtlasAuditReport {
  const missingFiles: string[] = [];
  const missingFileSet = new Set<string>();
  const missingOwnerVariants: Array<{ graphicId: number; owner: number; path: string }> = [];
  const invalidFrames: Array<{ graphicId: number; frameCount: number; limit: number }> = [];
  const classifiedRedirects: Array<{ kind: 'null' | 'unused' | 'fallback' | 'terrain-draw'; ref: string }> = [];
  const errors: string[] = [];
  const assetSizes = new Map<string, number>();

  const addMissingFile = (rel: string): void => {
    if (!missingFileSet.has(rel)) {
      missingFileSet.add(rel);
      missingFiles.push(rel);
    }
  };

  const root = resolve(assetsDir);
  let dirValid = false;
  try {
    dirValid = statSync(root).isDirectory();
  } catch {
    dirValid = false;
  }
  if (!dirValid) {
    errors.push(`assets directory does not exist: ${assetsDir}`);
    return {
      ok: false,
      assetsDir,
      packVersion: '',
      manifestHash: '',
      checkedGraphics: 0,
      missingFiles,
      missingOwnerVariants,
      invalidFrames,
      classifiedRedirects,
      errors,
    };
  }

  const manifestFile = resolvePackFile(root, 'manifest.json');
  if (!manifestFile) {
    addMissingFile('manifest.json');
    errors.push('missing manifest.json');
    return {
      ok: false,
      assetsDir,
      packVersion: '',
      manifestHash: '',
      checkedGraphics: 0,
      missingFiles,
      missingOwnerVariants,
      invalidFrames,
      classifiedRedirects,
      errors,
    };
  }

  let manifest: PackManifest;
  try {
    const raw = readFileSync(join(root, 'manifest.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainRecord(parsed)) throw new Error('manifest root must be an object');
    manifest = parsed as unknown as PackManifest;
  } catch (err) {
    errors.push(`invalid manifest.json: ${err instanceof Error ? err.message : String(err)}`);
    return {
      ok: false,
      assetsDir,
      packVersion: '',
      manifestHash: '',
      checkedGraphics: 0,
      missingFiles,
      missingOwnerVariants,
      invalidFrames,
      classifiedRedirects,
      errors,
    };
  }

  const packVersion = typeof manifest.version === 'number' && Number.isFinite(manifest.version) ? String(manifest.version) : '';
  if (manifest.version !== EXPECTED_PACK_VERSION) {
    errors.push(`unsupported pack version ${packVersion || 'unknown'} (expected ${EXPECTED_PACK_VERSION})`);
  }

  const checkReferencedFile = (rel: string, requiredLabel?: string): boolean => {
    const resolved = resolvePackFile(root, rel);
    if (!resolved) {
      addMissingFile(rel);
      if (requiredLabel) errors.push(`missing ${requiredLabel}: ${rel}`);
      return false;
    }
    assetSizes.set(rel, resolved.size);
    return true;
  };

  if (typeof manifest.palette === 'string' && manifest.palette) {
    checkReferencedFile(manifest.palette, 'palette');
  } else {
    addMissingFile('palette.json');
    errors.push('manifest missing palette path');
  }

  if (typeof manifest.dat === 'string' && manifest.dat) {
    checkReferencedFile(manifest.dat, 'dat');
  } else {
    addMissingFile('empires.dat');
    errors.push('manifest missing dat path');
  }

  if (!isPlainRecord(manifest.slps) || !isPlainRecord(manifest.graphics) || !isPlainRecord(manifest.terrains) || !isPlainRecord(manifest.units)) {
    errors.push('manifest missing required tables (slps, graphics, terrains, units)');
    return {
      ok: false,
      assetsDir,
      packVersion,
      manifestHash: computeManifestHash(manifest, assetSizes),
      checkedGraphics: 0,
      missingFiles,
      missingOwnerVariants,
      invalidFrames,
      classifiedRedirects,
      errors,
    };
  }

  if (Array.isArray(manifest.wavs)) {
    for (const id of manifest.wavs) {
      if (typeof id === 'number' && Number.isFinite(id)) checkReferencedFile(`sounds/${id}.wav`);
    }
  }
  if (Array.isArray(manifest.taunts)) {
    for (const n of manifest.taunts) {
      if (typeof n === 'number' && Number.isFinite(n)) checkReferencedFile(`sounds/taunt${n}.wav`);
    }
  }
  if (Array.isArray(manifest.soundFiles)) {
    for (const name of manifest.soundFiles) {
      if (typeof name === 'string' && name) checkReferencedFile(`sounds/file/${name}`);
    }
  }
  if (manifest.music) {
    const { tracks, files, bank } = manifest.music;
    if (typeof tracks === 'number' && Number.isInteger(tracks)) {
      for (let i = 1; i <= tracks; i++) checkReferencedFile(`music/music${i}.mid`);
    }
    if (Array.isArray(files)) {
      for (const name of files) {
        if (typeof name === 'string' && name) checkReferencedFile(`music/${name}`);
      }
    }
    if (typeof bank === 'string' && bank) checkReferencedFile(bank);
  }

  const slps = manifest.slps;
  const usedSlpKeys = new Set<string>();
  const verifiedSlps = new Map<string, { missingOwners: number[] }>();
  const usedGraphics = collectUsedGraphics(manifest);

  const verifySlp = (slpKeyName: string, slp: PackSlp, graphicId: number | null): void => {
    usedSlpKeys.add(slpKeyName);
    const cached = verifiedSlps.get(slpKeyName);
    if (cached) {
      if (graphicId !== null && slp.playerColour) {
        for (const owner of cached.missingOwners) {
          missingOwnerVariants.push({ graphicId, owner, path: slpImageRelPath(slp, owner) });
        }
      }
      return;
    }

    const missingOwners: number[] = [];
    if (slp.playerColour) {
      for (const owner of REQUIRED_MULTIPLAYER_OWNERS) {
        const rel = slpImageRelPath(slp, owner);
        if (!checkReferencedFile(rel)) {
          missingOwners.push(owner);
          if (graphicId !== null) missingOwnerVariants.push({ graphicId, owner, path: rel });
        }
      }
    } else {
      const rel = slpImageRelPath(slp, 1);
      checkReferencedFile(rel);
    }
    verifiedSlps.set(slpKeyName, { missingOwners });
  };

  let checkedGraphics = 0;
  const graphicEntries = Object.entries(manifest.graphics).sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [gidStr, graphic] of graphicEntries) {
    if (!graphic) continue;
    checkedGraphics++;
    const numericId = Number(gidStr);
    const graphicId = Number.isInteger(numericId) ? numericId : -1;

    if (graphic.slp === null) {
      if (Array.isArray(graphic.deltas) && graphic.deltas.length > 0) {
        classifiedRedirects.push({ kind: 'fallback', ref: `graphic:${gidStr}` });
        for (const delta of graphic.deltas) {
          const target = Array.isArray(delta) ? delta[0] : -1;
          if (typeof target === 'number' && target >= 0 && !manifest.graphics[String(target)]) {
            errors.push(`graphic ${gidStr} fallback delta references missing graphic ${target}`);
          }
        }
      } else {
        classifiedRedirects.push({ kind: 'null', ref: `graphic:${gidStr}` });
      }
      continue;
    }

    const slp = slps[graphic.slp];
    if (!slp) {
      addMissingFile(graphic.slp);
      errors.push(`graphic ${gidStr} references missing slp ${graphic.slp}`);
      continue;
    }

    const slpValid = validSlpFrameRects(slp);
    if (!slpValid) {
      invalidFrames.push({
        graphicId,
        frameCount: Array.isArray(slp.frames) ? slp.frames.length : 0,
        limit: Array.isArray(slp.frames) && slp.frames.length > 0 ? slp.frames.length : 1,
      });
    } else {
      const fc = graphic.frameCount;
      const ac = graphic.angleCount;
      const isUsed = usedGraphics.has(graphicId);
      if (
        typeof fc !== 'number' ||
        !Number.isInteger(fc) ||
        fc < 0 ||
        fc > MAX_GRAPHIC_FRAMES ||
        (isUsed && fc === 0) ||
        typeof ac !== 'number' ||
        !Number.isInteger(ac) ||
        ac < 0 ||
        (isUsed && ac === 0)
      ) {
        invalidFrames.push({
          graphicId,
          frameCount: typeof fc === 'number' && Number.isFinite(fc) ? fc : -1,
          limit: MAX_GRAPHIC_FRAMES,
        });
      }
    }

    verifySlp(graphic.slp, slp, graphicId);
  }

  for (const [tidStr, terrain] of Object.entries(manifest.terrains)) {
    if (!terrain) continue;
    if (typeof terrain.draw === 'number' && terrain.draw >= 0) {
      classifiedRedirects.push({ kind: 'terrain-draw', ref: `terrain:${tidStr}->${terrain.draw}` });
      if (!manifest.terrains[String(terrain.draw)]) {
        errors.push(`terrain ${tidStr} redirects to missing terrain ${terrain.draw}`);
      }
      continue;
    }
    if (terrain.slp === null) {
      classifiedRedirects.push({ kind: 'null', ref: `terrain:${tidStr}` });
      continue;
    }
    const slp = slps[terrain.slp];
    if (!slp) {
      addMissingFile(terrain.slp);
      errors.push(`terrain ${tidStr} references missing slp ${terrain.slp}`);
      continue;
    }
    if (!validSlpFrameRects(slp)) {
      errors.push(`terrain ${tidStr} slp ${terrain.slp} has invalid atlas dimensions or frames`);
    }
    verifySlp(terrain.slp, slp, null);
  }

  for (const [bidStr, border] of Object.entries(manifest.borders ?? {})) {
    if (!border) continue;
    if (border.slp === null) {
      classifiedRedirects.push({ kind: 'null', ref: `border:${bidStr}` });
      continue;
    }
    const slp = slps[border.slp];
    if (!slp) {
      addMissingFile(border.slp);
      errors.push(`border ${bidStr} references missing slp ${border.slp}`);
      continue;
    }
    if (!validSlpFrameRects(slp)) {
      errors.push(`border ${bidStr} slp ${border.slp} has invalid atlas dimensions or frames`);
    }
    verifySlp(border.slp, slp, null);
  }

  for (const [sidStr, screen] of Object.entries(manifest.screens ?? {})) {
    if (!screen || !Array.isArray(screen.backgrounds)) continue;
    for (const bg of screen.backgrounds) {
      if (typeof bg !== 'number' || bg < 0) continue;
      const key = `interface/${bg}`;
      const slp = slps[key];
      if (!slp) {
        addMissingFile(key);
        errors.push(`screen ${sidStr} references missing slp ${key}`);
        continue;
      }
      if (!validSlpFrameRects(slp)) {
        errors.push(`screen ${sidStr} slp ${key} has invalid atlas dimensions or frames`);
      }
      verifySlp(key, slp, null);
    }
  }

  for (const key of Object.keys(slps).sort()) {
    if (!usedSlpKeys.has(key)) {
      classifiedRedirects.push({ kind: 'unused', ref: `slp:${key}` });
    }
  }

  const manifestHash = computeManifestHash(manifest, assetSizes);
  const ok =
    errors.length === 0 &&
    missingFiles.length === 0 &&
    missingOwnerVariants.length === 0 &&
    invalidFrames.length === 0;

  return {
    ok,
    assetsDir,
    packVersion,
    manifestHash,
    checkedGraphics,
    missingFiles,
    missingOwnerVariants,
    invalidFrames,
    classifiedRedirects,
    errors,
  };
}
