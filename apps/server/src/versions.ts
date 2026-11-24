import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import {
  DEFAULT_COMPATIBILITY_VERSIONS,
  isCompatibilityVersions,
  sameCompatibilityVersions,
  type CompatibilityVersions,
} from '@aoe/protocol';
import { verifyAssetsPack, type AssetsPackVerification, type PackAuditFn } from './assets';

export interface ClientBuildCheck {
  ok: boolean;
  buildId: string | null;
  hash: string | null;
  fileCount: number;
  reasons: string[];
}

export interface ServerReadinessOptions {
  clientDir: string;
  assetsDir: string;
  versions?: CompatibilityVersions;
  expectedVersions?: CompatibilityVersions;
  publicUrl?: string;
  auditPack?: PackAuditFn;
}

export interface ServerReadinessReport {
  ready: boolean;
  versions: Readonly<CompatibilityVersions>;
  reasons: string[];
  client: ClientBuildCheck;
  assets: AssetsPackVerification;
  publicOrigin: string | null;
}

const BUILD_VERSION_META_RE = /<meta\s+name="aoe-build-version"\s+content="[^"]*">/gi;

function collectFilesSorted(rootDir: string, prefix = ''): string[] {
  const entries = readdirSync(rootDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFilesSorted(full, rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

/**
 * Verifies the production client build (`index.html` + `bundle/*.js`) and computes a deterministic content hash
 * from sorted relative file paths and bytes.
 */
export function verifyClientBuild(clientDir: string): ClientBuildCheck {
  const root = resolve(clientDir);
  let dirValid: boolean;
  try {
    dirValid = statSync(root).isDirectory();
  } catch {
    dirValid = false;
  }
  if (!dirValid) {
    return { ok: false, buildId: null, hash: null, fileCount: 0, reasons: ['client build directory does not exist'] };
  }

  let files: string[];
  try {
    files = collectFilesSorted(root);
  } catch {
    return { ok: false, buildId: null, hash: null, fileCount: 0, reasons: ['client build directory cannot be read'] };
  }

  const reasons: string[] = [];
  if (!files.includes('index.html')) {
    reasons.push('client build missing index.html');
  } else {
    try {
      const htmlBytes = readFileSync(join(root, 'index.html'));
      if (htmlBytes.length === 0) {
        reasons.push('client build index.html is empty');
      } else {
        const html = htmlBytes.toString('utf8');
        if (html.includes('/src/main.ts')) {
          reasons.push('client build index.html points to unbuilt dev entrypoint');
        }
      }
    } catch {
      reasons.push('client build index.html cannot be read');
    }
  }

  const bundleScripts = files.filter((rel) => rel.startsWith('bundle/') && rel.endsWith('.js'));
  if (bundleScripts.length === 0) {
    reasons.push('client build missing bundle/*.js');
  }

  if (reasons.length > 0) {
    return { ok: false, buildId: null, hash: null, fileCount: files.length, reasons };
  }

  const digest = createHash('sha256');
  for (const rel of files) {
    const raw = readFileSync(join(root, ...rel.split('/')));
    const bytes =
      rel === 'index.html'
        ? Buffer.from(raw.toString('utf8').replace(BUILD_VERSION_META_RE, ''), 'utf8')
        : raw;
    digest.update(rel).update('\0').update(bytes);
  }
  const hash = digest.digest('hex');
  return {
    ok: true,
    buildId: `build-${hash.slice(0, 16)}`,
    hash,
    fileCount: files.length,
    reasons: [],
  };
}

/**
 * Validates and normalizes `PUBLIC_URL` to a safe `http:` or `https:` origin without credentials, queries, or tokens.
 */
export function normalizePublicUrl(raw?: string): { ok: true; origin: string | null } | { ok: false; reason: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true, origin: null };
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: 'invalid PUBLIC_URL protocol' };
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return { ok: false, reason: 'PUBLIC_URL must not contain credentials' };
    }
    return { ok: true, origin: parsed.origin };
  } catch {
    return { ok: false, reason: 'invalid PUBLIC_URL configuration' };
  }
}

export function freezeVersions(versions: CompatibilityVersions): Readonly<CompatibilityVersions> {
  return Object.freeze({
    protocol: versions.protocol,
    rules: versions.rules,
    build: versions.build,
    assets: versions.assets,
  });
}

/**
 * Computes deterministic `CompatibilityVersions` from the built client and asset pack, falling back to
 * `DEFAULT_COMPATIBILITY_VERSIONS` components when development/test environments omit production artifacts.
 */
export function computeCompatibilityVersions(options: {
  clientDir: string;
  assetsDir: string;
  versions?: CompatibilityVersions;
  auditPack?: PackAuditFn;
}): Readonly<CompatibilityVersions> {
  if (options.versions !== undefined && isCompatibilityVersions(options.versions)) {
    return freezeVersions(options.versions);
  }
  const client = verifyClientBuild(options.clientDir);
  const assets = verifyAssetsPack(options.assetsDir, options.auditPack);
  return freezeVersions({
    protocol: DEFAULT_COMPATIBILITY_VERSIONS.protocol,
    rules: DEFAULT_COMPATIBILITY_VERSIONS.rules,
    build: client.ok && client.buildId ? client.buildId : DEFAULT_COMPATIBILITY_VERSIONS.build,
    assets: assets.ok && assets.assetsId ? assets.assetsId : DEFAULT_COMPATIBILITY_VERSIONS.assets,
  });
}

/**
 * Evaluates full server readiness (client build, asset pack + owner1..4 variants, `PUBLIC_URL`, and `CompatibilityVersions`).
 */
export function evaluateServerReadiness(options: ServerReadinessOptions): ServerReadinessReport {
  const client = verifyClientBuild(options.clientDir);
  const assets = verifyAssetsPack(options.assetsDir, options.auditPack);
  const publicCheck = normalizePublicUrl(options.publicUrl);

  const computedVersions = freezeVersions({
    protocol: DEFAULT_COMPATIBILITY_VERSIONS.protocol,
    rules: DEFAULT_COMPATIBILITY_VERSIONS.rules,
    build: client.ok && client.buildId ? client.buildId : DEFAULT_COMPATIBILITY_VERSIONS.build,
    assets: assets.ok && assets.assetsId ? assets.assetsId : DEFAULT_COMPATIBILITY_VERSIONS.assets,
  });

  const versionReasons: string[] = [];
  let versions: Readonly<CompatibilityVersions>;
  if (options.versions !== undefined) {
    if (isCompatibilityVersions(options.versions)) {
      versions = freezeVersions(options.versions);
    } else {
      versionReasons.push('invalid compatibility versions configuration');
      versions = freezeVersions(DEFAULT_COMPATIBILITY_VERSIONS);
    }
  } else if (options.expectedVersions !== undefined) {
    versions = freezeVersions(options.expectedVersions);
    if (!isCompatibilityVersions(versions)) {
      versionReasons.push('invalid compatibility versions configuration');
    } else if (client.ok && assets.ok && !sameCompatibilityVersions(computedVersions, versions)) {
      versionReasons.push('runtime compatibility versions changed since server startup');
    }
  } else {
    versions = computedVersions;
  }

  const reasons = [
    ...client.reasons,
    ...assets.reasons,
    ...(publicCheck.ok ? [] : [publicCheck.reason]),
    ...versionReasons,
  ];
  const ready = reasons.length === 0 && client.ok && assets.ok && isCompatibilityVersions(versions);

  return {
    ready,
    versions,
    reasons,
    client,
    assets,
    publicOrigin: publicCheck.ok ? publicCheck.origin : null,
  };
}
