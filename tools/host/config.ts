import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostConfig, HostConfigOverrides } from './types.ts';

export const DEFAULT_HOST = '0.0.0.0';
export const DEFAULT_PORT = 8787;
export const DEFAULT_HEALTH_TIMEOUT_MS = 15_000;
export const DEFAULT_HEALTH_INTERVAL_MS = 200;
export const DEFAULT_STOP_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_LOG_FILES = 3;

export function resolveRepoRoot(fromMetaUrl: string = import.meta.url): string {
  return resolve(fileURLToPath(new URL('../..', fromMetaUrl)));
}

export function resolvePathFrom(baseDir: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    throw new Error('Path value must not be empty.');
  }
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(baseDir, trimmed);
}

export function parsePort(rawPort: number | string | undefined, defaultPort: number = DEFAULT_PORT): number {
  if (rawPort === undefined || rawPort === '') return defaultPort;
  if (typeof rawPort === 'number') {
    if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
      throw new Error(`Invalid PORT "${String(rawPort)}": must be an integer between 1 and 65535.`);
    }
    return rawPort;
  }
  const trimmed = rawPort.trim();
  if (trimmed.length === 0) return defaultPort;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid PORT "${rawPort}": must be an integer between 1 and 65535.`);
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid PORT "${rawPort}": must be an integer between 1 and 65535.`);
  }
  return parsed;
}

export function normalizePublicUrl(rawUrl: string | null | undefined): string | null {
  if (rawUrl === undefined || rawUrl === null) return null;
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid PUBLIC_URL "${rawUrl}": must be a valid http:// or https:// URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid PUBLIC_URL "${rawUrl}": protocol must be http: or https:.`);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error('Invalid PUBLIC_URL: URL must not contain embedded credentials.');
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error('Invalid PUBLIC_URL: URL must not contain query parameters or hash fragments.');
  }
  const cleanPath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${cleanPath}`;
}

function parsePositiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name} "${String(value)}": must be a positive integer.`);
  }
  return value;
}

export function resolveHostConfig(
  overrides: HostConfigOverrides = {},
  env: Record<string, string | undefined> = process.env,
): HostConfig {
  const repoRoot = overrides.repoRoot ? resolve(overrides.repoRoot) : resolveRepoRoot();
  const cwd = overrides.cwd ? resolve(overrides.cwd) : process.cwd();

  const rawHost = overrides.host ?? env.HOST;
  const host = rawHost && rawHost.trim().length > 0 ? rawHost.trim() : DEFAULT_HOST;
  const port = parsePort(overrides.port ?? env.PORT, DEFAULT_PORT);

  const rawServerEntry = overrides.serverEntry ?? env.SERVER_ENTRY;
  const serverEntry =
    rawServerEntry && rawServerEntry.trim().length > 0
      ? resolvePathFrom(cwd, rawServerEntry)
      : resolve(repoRoot, 'apps', 'server', 'dist', 'main.js');

  const rawClientDir = overrides.clientDir ?? env.CLIENT_DIR;
  const clientDir =
    rawClientDir && rawClientDir.trim().length > 0
      ? resolvePathFrom(cwd, rawClientDir)
      : resolve(repoRoot, 'apps', 'client', 'dist');

  const rawAssetsDir = overrides.assetsDir ?? env.ASSETS_DIR;
  const assetsDir =
    rawAssetsDir && rawAssetsDir.trim().length > 0
      ? resolvePathFrom(cwd, rawAssetsDir)
      : resolve(repoRoot, 'assets-local', 'pack');

  const rawStateDir = overrides.stateDir ?? env.HOST_STATE_DIR;
  const stateDir =
    rawStateDir && rawStateDir.trim().length > 0
      ? resolvePathFrom(cwd, rawStateDir)
      : resolve(repoRoot, 'assets-local', 'host-runtime');

  const rawLogPath = overrides.logPath ?? env.HOST_LOG_PATH;
  const logPath =
    rawLogPath && rawLogPath.trim().length > 0
      ? resolvePathFrom(cwd, rawLogPath)
      : join(stateDir, 'host-server.log');

  const pidFilePath = overrides.pidFilePath ? resolvePathFrom(cwd, overrides.pidFilePath) : join(stateDir, 'host-server.pid.json');
  const lockFilePath = overrides.lockFilePath ? resolvePathFrom(cwd, overrides.lockFilePath) : join(stateDir, 'host-server.lock');

  const publicUrl = normalizePublicUrl(overrides.publicUrl !== undefined ? overrides.publicUrl : env.PUBLIC_URL);

  const rawIface = overrides.preferredInterface !== undefined ? overrides.preferredInterface : env.HOST_INTERFACE;
  const preferredInterface = rawIface && rawIface.trim().length > 0 ? rawIface.trim() : null;

  const nodeExecutable =
    overrides.nodeExecutable && overrides.nodeExecutable.trim().length > 0
      ? overrides.nodeExecutable.trim()
      : process.execPath;

  return {
    repoRoot,
    cwd,
    nodeExecutable,
    host,
    port,
    serverEntry,
    clientDir,
    assetsDir,
    stateDir,
    logPath,
    pidFilePath,
    lockFilePath,
    publicUrl,
    preferredInterface,
    healthTimeoutMs: parsePositiveInt(overrides.healthTimeoutMs, DEFAULT_HEALTH_TIMEOUT_MS, 'healthTimeoutMs'),
    healthIntervalMs: parsePositiveInt(overrides.healthIntervalMs, DEFAULT_HEALTH_INTERVAL_MS, 'healthIntervalMs'),
    stopTimeoutMs: parsePositiveInt(overrides.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS, 'stopTimeoutMs'),
    maxLogBytes: parsePositiveInt(overrides.maxLogBytes, DEFAULT_MAX_LOG_BYTES, 'maxLogBytes'),
    maxLogFiles: parsePositiveInt(overrides.maxLogFiles, DEFAULT_MAX_LOG_FILES, 'maxLogFiles'),
  };
}
