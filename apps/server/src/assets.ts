import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACK_VERSION, slpImagePath, type PackManifest, type PackSlp } from '@aoe/assets-import/manifest';
import { auditMultiplayerAssets, type OwnerAtlasAuditReport } from '@aoe/assets-import/multiplayer-audit';

export type { OwnerAtlasAuditReport };

/** `assets-local/pack` at the repo root: the same depth from `src/` and from the bundled `dist/`. */
export const DEFAULT_ASSETS_DIR = fileURLToPath(new URL('../../../assets-local/pack', import.meta.url));
/** `apps/client/dist`, the built client (`npm run build`): the same depth from `src/` and from the bundled `dist/`. */
export const DEFAULT_CLIENT_DIR = fileURLToPath(new URL('../../client/dist', import.meta.url));

const PACK_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.json': 'application/json',
  '.dat': 'application/octet-stream',
  // The sounds and the music with its sound bank (docs/spec/sounds.md).
  '.wav': 'audio/wav',
  '.mid': 'audio/midi',
  '.dls': 'application/octet-stream',
  '.sf2': 'application/octet-stream',
};

const CLIENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** The client's files under `/bundle/` carry a content hash in their name (vite `assetsDir`), so they never change. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Everything else may change under the same URL (the page, the pack): the browser revalidates, a 304 costs no body. */
const REVALIDATE = 'no-cache';

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

/** A path under `root`, or null for a missing file, a missing folder, a malformed escape or a path that leaves `root`. */
async function resolveFile(root: string, relPath: string) {
  try {
    const base = resolve(root);
    const candidate = resolve(join(base, decodeURIComponent(relPath)));
    if (!candidate.startsWith(base + sep)) return null;
    const info = await stat(candidate);
    return info.isFile() ? { file: candidate, info } : null;
  } catch {
    return null;
  }
}

/** True when the request's validators (`If-None-Match`, else `If-Modified-Since`) say the client's copy is current. */
function notModified(req: IncomingMessage, etag: string, mtimeMs: number): boolean {
  const none = req.headers['if-none-match'];
  if (none !== undefined) return none.split(',').some((tag) => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''));
  const since = Date.parse(req.headers['if-modified-since'] ?? '');
  return !Number.isNaN(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
}

/** Answers a GET or HEAD with `file`'s bytes, its `ETag` and `Last-Modified`, or 304 when the request's copy is current. */
async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  { file, info }: NonNullable<Awaited<ReturnType<typeof resolveFile>>>,
  types: Record<string, string>,
  cacheControl: string,
): Promise<void> {
  const type = types[extname(file).toLowerCase()];
  if (!type) return notFound(res);
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = { etag, 'last-modified': info.mtime.toUTCString(), 'cache-control': cacheControl };
  if (notModified(req, etag, info.mtimeMs)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, 'content-type': type, 'content-length': info.size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}

/**
 * Answers `GET /assets/<path>` from the pack folder. Returns false when the URL is not under
 * /assets; 404s cleanly for a missing pack, a missing file or a path that leaves the folder.
 */
export async function serveAsset(req: IncomingMessage, rawUrl: string, assetsDir: string, res: ServerResponse): Promise<boolean> {
  const url = new URL(rawUrl, 'http://localhost');
  if (!url.pathname.startsWith('/assets/')) return false;
  const found = await resolveFile(assetsDir, url.pathname.slice('/assets/'.length));
  if (found) await sendFile(req, res, found, PACK_TYPES, REVALIDATE);
  else notFound(res);
  return true;
}

/**
 * Answers `GET /` and `GET /<path>` from the built client folder (`/` is `index.html`; the client has no routes of its
 * own, so no other URL falls back to the page). 404s for a missing file or folder.
 */
export async function serveClient(req: IncomingMessage, rawUrl: string, clientDir: string, res: ServerResponse): Promise<void> {
  const { pathname } = new URL(rawUrl, 'http://localhost');
  const relPath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const found = await resolveFile(clientDir, relPath);
  if (found) await sendFile(req, res, found, CLIENT_TYPES, pathname.startsWith('/bundle/') ? IMMUTABLE : REVALIDATE);
  else notFound(res);
}

const REQUIRED_MULTIPLAYER_OWNERS = [1, 2, 3, 4] as const;

export type PackAuditFn = (assetsDir: string) => OwnerAtlasAuditReport;

export interface AssetsPackVerification {
  ok: boolean;
  assetsId: string | null;
  manifestHash: string | null;
  packVersion: string | null;
  reasons: string[];
  report: OwnerAtlasAuditReport;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolvePackFileSync(root: string, relPath: string): string | null {
  if (!relPath || isAbsolute(relPath)) return null;
  try {
    const base = resolve(root);
    const candidate = resolve(base, relPath);
    if (!candidate.startsWith(base + sep)) return null;
    const info = statSync(candidate);
    return info.isFile() && info.size > 0 ? candidate : null;
  } catch {
    return null;
  }
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sanitizeMessage(message: string, sensitiveRoot: string): string {
  const resolved = resolve(sensitiveRoot);
  return message
    .split(resolved).join('<assets>')
    .split(sensitiveRoot).join('<assets>')
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>')
    .replace(/\/(?:Users|home|tmp|var|etc|opt|srv|root)\/[^\s'"]+/g, '<path>');
}

/**
 * Audits an asset pack directory for manifest validity, required metadata files, and `owner1..4` sprite readiness.
 * Classifies null SLPs, unused SLPs, delta-only fallback graphics, and `terrain.draw` redirects without false errors.
 */
export function auditAssetsPack(assetsDir: string): OwnerAtlasAuditReport {
  const missingFiles: string[] = [];
  const missingOwnerVariants: Array<{ graphicId: number; owner: number; path: string }> = [];
  const invalidFrames: Array<{ graphicId: number; frameCount: number; limit: number }> = [];
  const classifiedRedirects: Array<{ kind: 'null' | 'unused' | 'fallback' | 'terrain-draw'; ref: string }> = [];
  const errors: string[] = [];

  const root = resolve(assetsDir);
  let dirValid: boolean;
  try {
    dirValid = statSync(root).isDirectory();
  } catch {
    dirValid = false;
  }
  if (!dirValid) {
    errors.push('assets pack directory does not exist');
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

  const manifestFile = resolvePackFileSync(root, 'manifest.json');
  if (!manifestFile) {
    missingFiles.push('manifest.json');
    errors.push('missing pack manifest.json');
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

  let manifestBytes: Buffer;
  let manifest: PackManifest;
  try {
    manifestBytes = readFileSync(manifestFile);
    const parsed: unknown = JSON.parse(manifestBytes.toString('utf8'));
    if (!isPlainRecord(parsed)) throw new Error('manifest root must be an object');
    manifest = parsed as unknown as PackManifest;
  } catch {
    errors.push('invalid pack manifest.json');
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

  const manifestHash = sha256Bytes(manifestBytes);
  const packVersion = typeof manifest.version === 'number' && Number.isFinite(manifest.version) ? String(manifest.version) : '';
  if (manifest.version !== PACK_VERSION) {
    errors.push(`unsupported pack version ${packVersion || 'unknown'} (expected ${PACK_VERSION})`);
  }

  if (typeof manifest.palette !== 'string' || !resolvePackFileSync(root, manifest.palette)) {
    const rel = typeof manifest.palette === 'string' && manifest.palette ? manifest.palette : 'palette.json';
    missingFiles.push(rel);
    errors.push(`missing pack palette ${rel}`);
  }
  if (typeof manifest.dat !== 'string' || !resolvePackFileSync(root, manifest.dat)) {
    const rel = typeof manifest.dat === 'string' && manifest.dat ? manifest.dat : 'empires.dat';
    missingFiles.push(rel);
    errors.push(`missing pack dat ${rel}`);
  }

  if (!isPlainRecord(manifest.slps) || !isPlainRecord(manifest.graphics) || !isPlainRecord(manifest.terrains) || !isPlainRecord(manifest.units)) {
    errors.push('manifest missing required tables (slps, graphics, terrains, units)');
    return {
      ok: false,
      assetsDir,
      packVersion,
      manifestHash,
      checkedGraphics: 0,
      missingFiles,
      missingOwnerVariants,
      invalidFrames,
      classifiedRedirects,
      errors,
    };
  }

  const slps = manifest.slps;
  const verifiedSlps = new Map<string, boolean>();
  const usedSlpKeys = new Set<string>();

  const verifySlpFiles = (slpKeyName: string, slp: PackSlp, graphicId: number | null): void => {
    usedSlpKeys.add(slpKeyName);
    if (!Array.isArray(slp.frames) || slp.frames.length === 0 || slp.atlasWidth <= 0 || slp.atlasHeight <= 0) {
      if (graphicId !== null) {
        invalidFrames.push({ graphicId, frameCount: slp.frames?.length ?? 0, limit: 1 });
      } else {
        errors.push(`slp ${slpKeyName} has invalid atlas or empty frames`);
      }
    }
    const cached = verifiedSlps.get(slpKeyName);
    if (cached !== undefined) {
      if (!cached && graphicId !== null && slp.playerColour) {
        for (const owner of REQUIRED_MULTIPLAYER_OWNERS) {
          const rel = slpImagePath(slp, owner);
          if (!resolvePackFileSync(root, rel)) missingOwnerVariants.push({ graphicId, owner, path: rel });
        }
      }
      return;
    }

    let ok = true;
    if (slp.playerColour) {
      for (const owner of REQUIRED_MULTIPLAYER_OWNERS) {
        const rel = slpImagePath(slp, owner);
        if (!resolvePackFileSync(root, rel)) {
          ok = false;
          if (!missingFiles.includes(rel)) missingFiles.push(rel);
          if (graphicId !== null) missingOwnerVariants.push({ graphicId, owner, path: rel });
        }
      }
    } else {
      const rel = slpImagePath(slp, 1);
      if (!resolvePackFileSync(root, rel)) {
        ok = false;
        if (!missingFiles.includes(rel)) missingFiles.push(rel);
      }
    }
    verifiedSlps.set(slpKeyName, ok);
  };

  let checkedGraphics = 0;
  for (const [gidStr, graphic] of Object.entries(manifest.graphics)) {
    if (!graphic) continue;
    checkedGraphics++;
    const numericId = Number(gidStr);
    const graphicId = Number.isInteger(numericId) ? numericId : -1;
    if (graphic.slp === null) {
      const kind = Array.isArray(graphic.deltas) && graphic.deltas.length > 0 ? 'fallback' : 'null';
      classifiedRedirects.push({ kind, ref: `graphic:${gidStr}` });
      continue;
    }
    const slp = slps[graphic.slp];
    if (!slp) {
      if (!missingFiles.includes(graphic.slp)) missingFiles.push(graphic.slp);
      errors.push(`graphic ${gidStr} references missing slp ${graphic.slp}`);
      continue;
    }
    if (typeof graphic.frameCount !== 'number' || graphic.frameCount < 0) {
      invalidFrames.push({ graphicId, frameCount: Number(graphic.frameCount), limit: slp.frames.length });
    }
    verifySlpFiles(graphic.slp, slp, graphicId);
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
      if (!missingFiles.includes(terrain.slp)) missingFiles.push(terrain.slp);
      errors.push(`terrain ${tidStr} references missing slp ${terrain.slp}`);
      continue;
    }
    verifySlpFiles(terrain.slp, slp, null);
  }

  for (const [bidStr, border] of Object.entries(manifest.borders ?? {})) {
    if (!border) continue;
    if (border.slp === null) {
      classifiedRedirects.push({ kind: 'null', ref: `border:${bidStr}` });
      continue;
    }
    const slp = slps[border.slp];
    if (!slp) {
      if (!missingFiles.includes(border.slp)) missingFiles.push(border.slp);
      errors.push(`border ${bidStr} references missing slp ${border.slp}`);
      continue;
    }
    verifySlpFiles(border.slp, slp, null);
  }

  for (const [sidStr, screen] of Object.entries(manifest.screens ?? {})) {
    if (!screen || !Array.isArray(screen.backgrounds)) continue;
    for (const bg of screen.backgrounds) {
      if (typeof bg !== 'number' || bg < 0) continue;
      const key = `interface/${bg}`;
      const slp = slps[key];
      if (!slp) {
        if (!missingFiles.includes(key)) missingFiles.push(key);
        errors.push(`screen ${sidStr} references missing slp ${key}`);
        continue;
      }
      verifySlpFiles(key, slp, null);
    }
  }

  for (const key of Object.keys(slps)) {
    if (!usedSlpKeys.has(key)) {
      classifiedRedirects.push({ kind: 'unused', ref: `slp:${key}` });
    }
  }

  const ok = errors.length === 0 && missingFiles.length === 0 && missingOwnerVariants.length === 0 && invalidFrames.length === 0;
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

/**
 * Verifies an asset pack (via injected M08 `auditPack` or built-in `auditAssetsPack`) and derives a deterministic
 * pack content identifier that covers `manifest.json`, `palette`, and `empires.dat`.
 */
export function verifyAssetsPack(assetsDir: string, auditPack: PackAuditFn = auditMultiplayerAssets): AssetsPackVerification {
  const report = auditPack(assetsDir);
  const reasons: string[] = [];

  for (const err of report.errors) {
    const clean = sanitizeMessage(err, assetsDir);
    if (clean && !reasons.includes(clean)) reasons.push(clean);
  }
  if (report.missingOwnerVariants.length > 0) {
    const first = report.missingOwnerVariants[0]!;
    const cleanPath = sanitizeMessage(first.path, assetsDir);
    reasons.push(`missing owner1..4 sprite variants (${report.missingOwnerVariants.length}, e.g. ${cleanPath})`);
  }
  if (report.missingFiles.length > 0) {
    const first = sanitizeMessage(report.missingFiles[0]!, assetsDir);
    const msg = `missing pack files (${report.missingFiles.length}, e.g. ${first})`;
    if (!reasons.some((r) => r.includes(first))) reasons.push(msg);
  }
  if (report.invalidFrames.length > 0) {
    const first = report.invalidFrames[0]!;
    reasons.push(`invalid sprite frame bounds (${report.invalidFrames.length}, e.g. graphic ${first.graphicId})`);
  }

  const ok = report.ok && reasons.length === 0;
  if (!ok) {
    if (reasons.length === 0) reasons.push('asset pack verification failed');
    return {
      ok: false,
      assetsId: null,
      manifestHash: report.manifestHash || null,
      packVersion: report.packVersion || null,
      reasons,
      report,
    };
  }

  const root = resolve(assetsDir);
  const hash = createHash('sha256').update(report.manifestHash || 'empty');
  try {
    const manifestFile = resolvePackFileSync(root, 'manifest.json');
    if (manifestFile) {
      const parsed = JSON.parse(readFileSync(manifestFile, 'utf8')) as Partial<PackManifest>;
      if (typeof parsed.palette === 'string') {
        const paletteFile = resolvePackFileSync(root, parsed.palette);
        if (paletteFile) hash.update('\0palette\0').update(readFileSync(paletteFile));
      }
      if (typeof parsed.dat === 'string') {
        const datFile = resolvePackFileSync(root, parsed.dat);
        if (datFile) hash.update('\0dat\0').update(readFileSync(datFile));
      }
    }
  } catch {
    // Custom injected audits in tests may not provide full files on disk; manifestHash still anchors the ID.
  }

  const digest = hash.digest('hex').slice(0, 16);
  const versionTag = (report.packVersion || String(PACK_VERSION)).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 16) || '0';
  const assetsId = `pack-${versionTag}-${digest}`.slice(0, 128);
  return {
    ok: true,
    assetsId,
    manifestHash: report.manifestHash,
    packVersion: report.packVersion || String(PACK_VERSION),
    reasons: [],
    report,
  };
}
