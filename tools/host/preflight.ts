import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { auditMultiplayerAssets } from '../assets-import/src/multiplayer-audit.ts';
import type { HostConfig, PreflightCheckResult, PreflightHooks } from './types.ts';

export const MIN_NODE_MAJOR = 24;

export function parseNodeMajorVersion(versionString: string): number | null {
  const cleaned = versionString.trim().replace(/^v/i, '');
  const majorStr = cleaned.split('.')[0];
  if (!majorStr || !/^\d+$/.test(majorStr)) return null;
  return Number(majorStr);
}

export async function defaultCheckNodeVersion(nodeVersion: string = process.versions.node): Promise<string | null> {
  const major = parseNodeMajorVersion(nodeVersion);
  if (major === null || major < MIN_NODE_MAJOR) {
    return `Node.js >= ${MIN_NODE_MAJOR} is required (detected ${nodeVersion}). Install Node.js ${MIN_NODE_MAJOR}+ and restart the launcher.`;
  }
  return null;
}

export async function defaultCheckServerBuild(serverEntry: string): Promise<string | null> {
  try {
    const info = await stat(serverEntry);
    if (!info.isFile() || info.size === 0) {
      return `Built server entry at "${serverEntry}" is empty or not a file. Run "npm run build" from the repository root first.`;
    }
    return null;
  } catch {
    return `Built server entry not found at "${serverEntry}". Run "npm run build" from the repository root first.`;
  }
}

export async function defaultCheckClientBuild(clientDir: string): Promise<string | null> {
  try {
    const dirInfo = await stat(clientDir);
    if (!dirInfo.isDirectory()) {
      return `Built client folder "${clientDir}" is not a directory. Run "npm run build" from the repository root first.`;
    }
  } catch {
    return `Built client folder not found at "${clientDir}". Run "npm run build" from the repository root first.`;
  }

  const indexPath = join(clientDir, 'index.html');
  try {
    const indexInfo = await stat(indexPath);
    if (!indexInfo.isFile() || indexInfo.size === 0) {
      return `Built client entry "${indexPath}" is empty or not a file. Run "npm run build" from the repository root first.`;
    }
    const html = await readFile(indexPath, 'utf8');
    if (html.includes('/src/main.ts')) {
      return `Built client entry "${indexPath}" points to unbuilt dev entrypoint (/src/main.ts). Run "npm run build" from the repository root first.`;
    }
  } catch {
    return `Built client entry not found at "${indexPath}". Run "npm run build" from the repository root first.`;
  }

  const bundleDir = join(clientDir, 'bundle');
  try {
    const bundleEntries = await readdir(bundleDir);
    if (!bundleEntries.some((entry) => entry.endsWith('.js'))) {
      return `Built client bundle missing JavaScript chunks in "${bundleDir}". Run "npm run build" from the repository root first.`;
    }
    return null;
  } catch {
    return `Built client bundle directory not found at "${bundleDir}". Run "npm run build" from the repository root first.`;
  }
}

export function defaultCheckMultiplayerAssets(assetsDir: string): string[] {
  const report = auditMultiplayerAssets(assetsDir);
  if (report.ok) return [];
  const errors = [...report.errors];
  if (report.missingOwnerVariants.length > 0) {
    const first = report.missingOwnerVariants[0]!;
    errors.push(
      `Missing owner1..4 sprite variants (${report.missingOwnerVariants.length}, e.g. graphic ${first.graphicId} owner ${first.owner}: ${first.path}).`,
    );
  }
  if (report.missingFiles.length > 0) {
    const first = report.missingFiles[0]!;
    if (!errors.some((e) => e.includes(first))) {
      errors.push(`Missing asset pack files (${report.missingFiles.length}, e.g. ${first}).`);
    }
  }
  if (report.invalidFrames.length > 0) {
    const first = report.invalidFrames[0]!;
    errors.push(
      `Invalid sprite frame bounds (${report.invalidFrames.length}, e.g. graphic ${first.graphicId}: ${first.frameCount}/${first.limit}).`,
    );
  }
  if (errors.length === 0) {
    errors.push(`Asset pack audit failed for "${assetsDir}".`);
  }
  return errors;
}

export async function defaultCheckAssets(assetsDir: string): Promise<string[]> {
  const errors: string[] = [];
  try {
    const dirInfo = await stat(assetsDir);
    if (!dirInfo.isDirectory()) {
      return [`Assets folder "${assetsDir}" is not a directory. Set ASSETS_DIR or build assets-local/pack.`];
    }
  } catch {
    return [
      `Assets folder not found at "${assetsDir}". Ensure assets-local/pack exists, run "AOE1_DIR=<install> npm run assets:import", or set ASSETS_DIR.`,
    ];
  }

  const manifestPath = join(assetsDir, 'manifest.json');
  let rawManifest: string;
  try {
    rawManifest = await readFile(manifestPath, 'utf8');
  } catch {
    return [
      `Asset manifest not found at "${manifestPath}". Run "AOE1_DIR=<install> npm run assets:import" or point ASSETS_DIR to a valid pack.`,
    ];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawManifest);
  } catch {
    return [`Asset manifest "${manifestPath}" contains invalid JSON. Re-import the asset pack.`];
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return [`Asset manifest "${manifestPath}" must be a JSON object.`];
  }

  const manifest = parsed as Record<string, unknown>;
  if (typeof manifest.version !== 'number' || !Number.isFinite(manifest.version)) {
    errors.push(`Asset manifest "${manifestPath}" is missing a valid numeric "version" field.`);
  }

  if (typeof manifest.palette === 'string' && manifest.palette.length > 0) {
    const palettePath = join(assetsDir, manifest.palette);
    try {
      const paletteStat = await stat(palettePath);
      if (!paletteStat.isFile()) {
        errors.push(`Asset palette file "${palettePath}" referenced by manifest is not a file.`);
      }
    } catch {
      errors.push(`Asset palette file missing at "${palettePath}" (referenced by manifest.json).`);
    }
  }

  if (typeof manifest.dat === 'string' && manifest.dat.length > 0) {
    const datPath = join(assetsDir, manifest.dat);
    try {
      const datStat = await stat(datPath);
      if (!datStat.isFile()) {
        errors.push(`Asset data file "${datPath}" referenced by manifest is not a file.`);
      }
    } catch {
      errors.push(`Asset data file missing at "${datPath}" (referenced by manifest.json).`);
    }
  }

  if (errors.length === 0) {
    errors.push(...defaultCheckMultiplayerAssets(assetsDir));
  }

  return errors;
}

function probeBind(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const probe = createServer();
    let settled = false;
    const finish = (errMsg: string | null) => {
      if (settled) return;
      settled = true;
      resolve(errMsg);
    };

    probe.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        finish(
          `Port ${port} on ${host} is already in use by another process. Stop the conflicting server or set a different PORT (e.g. PORT=8788 or --port 8788).`,
        );
      } else if (err.code === 'EACCES') {
        finish(`Permission denied binding ${host}:${port}. Choose an unprivileged port >= 1024 with PORT=<port>.`);
      } else if (err.code === 'EADDRNOTAVAIL') {
        finish(`Address ${host}:${port} is not available on this machine. Check HOST configuration.`);
      } else {
        finish(`Cannot bind ${host}:${port} (${err.code ?? err.message}).`);
      }
    });

    probe.once('listening', () => {
      probe.close(() => finish(null));
    });

    probe.listen({ port, host, exclusive: true });
  });
}

export async function defaultCheckPortAvailable(host: string, port: number): Promise<string | null> {
  const primaryError = await probeBind(host, port);
  if (primaryError !== null) return primaryError;

  if (host === '0.0.0.0') {
    const loopbackError = await probeBind('127.0.0.1', port);
    if (loopbackError !== null) {
      return `Port ${port} is already in use on 127.0.0.1. Stop the conflicting server or set a different PORT (e.g. PORT=8788 or --port 8788).`;
    }
  }
  return null;
}

function pushErrors(target: string[], result: string[] | string | null | undefined): void {
  if (!result) return;
  if (Array.isArray(result)) {
    for (const entry of result) {
      if (entry && entry.trim().length > 0) target.push(entry);
    }
  } else if (result.trim().length > 0) {
    target.push(result);
  }
}

export async function runPreflight(
  config: HostConfig,
  hooks: PreflightHooks = {},
): Promise<PreflightCheckResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const [nodeErr, serverErr, clientErr, assetsErr, portErr] = await Promise.all([
    hooks.checkNodeVersion ? hooks.checkNodeVersion() : defaultCheckNodeVersion(),
    hooks.checkServerBuild ? hooks.checkServerBuild(config.serverEntry) : defaultCheckServerBuild(config.serverEntry),
    hooks.checkClientBuild ? hooks.checkClientBuild(config.clientDir) : defaultCheckClientBuild(config.clientDir),
    defaultCheckAssets(config.assetsDir),
    hooks.checkPortAvailable ? hooks.checkPortAvailable(config.host, config.port) : defaultCheckPortAvailable(config.host, config.port),
  ]);

  pushErrors(errors, nodeErr);
  pushErrors(errors, serverErr);
  pushErrors(errors, clientErr);
  pushErrors(errors, assetsErr);
  if (hooks.checkAssets && assetsErr.length === 0) {
    const extraAssetErr = await hooks.checkAssets(config.assetsDir);
    pushErrors(errors, extraAssetErr);
  }
  pushErrors(errors, portErr);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    details: {
      nodeVersion: process.versions.node,
      serverEntry: config.serverEntry,
      clientIndex: join(config.clientDir, 'index.html'),
      assetsDir: config.assetsDir,
      assetsManifest: join(config.assetsDir, 'manifest.json'),
      host: config.host,
      port: config.port,
    },
  };
}
