import {
  DEFAULT_COMPATIBILITY_VERSIONS,
  isCompatibilityVersions,
  sameCompatibilityVersions,
  type CompatibilityVersions,
} from '@aoe/protocol';

export type CompatibilityField = keyof CompatibilityVersions;

export const COMPATIBILITY_FIELDS: readonly CompatibilityField[] = ['protocol', 'rules', 'build', 'assets'];

export interface FieldCompatibility {
  match: boolean;
  client: string;
  server: string;
}

export interface CompatibilityMismatch {
  field: CompatibilityField;
  client: string;
  server: string;
}

export interface CompatibilityDiagnostics {
  ok: boolean;
  protocol: FieldCompatibility;
  rules: FieldCompatibility;
  build: FieldCompatibility;
  assets: FieldCompatibility;
  mismatches: CompatibilityMismatch[];
  message: string | null;
}

export interface FetchServerVersionsOptions {
  fetchImpl?: typeof fetch;
  /**
   * Allow falling back to `DEFAULT_COMPATIBILITY_VERSIONS` when `/api/versions` is unreachable or returns 404
   * (e.g. offline/legacy test harnesses). Never bypasses an explicit version payload from the server.
   */
  fallbackToDefault?: boolean;
}

export type VersionFetchResult =
  | {
      ok: true;
      versions: CompatibilityVersions;
      source: 'server' | 'fallback';
    }
  | {
      ok: false;
      kind: 'network' | 'http' | 'invalid-payload';
      error: string;
      status?: number;
      retryable: boolean;
    };

export interface VersionGateOptions extends FetchServerVersionsOptions {
  baseUrl?: string;
  clientVersions?: CompatibilityVersions;
}

export type VersionGateResult =
  | {
      ok: true;
      clientVersions: CompatibilityVersions;
      serverVersions: CompatibilityVersions;
      source: 'server' | 'fallback';
      diagnostics: CompatibilityDiagnostics;
    }
  | {
      ok: false;
      kind: 'fetch-error';
      fetchKind: 'network' | 'http' | 'invalid-payload';
      message: string;
      status?: number;
      retryable: boolean;
    }
  | {
      ok: false;
      kind: 'mismatch';
      message: string;
      retryable: boolean;
      clientVersions: CompatibilityVersions;
      serverVersions: CompatibilityVersions;
      diagnostics: CompatibilityDiagnostics;
    };

function pickEnvVersion(env: Record<string, unknown> | undefined, key: string, fallback: string): string {
  const raw = env?.[key];
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : fallback;
}

function readMetaVersion(name: string): string | undefined {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return undefined;
  const el = document.querySelector(`meta[name="${name}"]`);
  const content = el?.getAttribute?.('content')?.trim();
  return content && content.length > 0 && content.length <= 128 ? content : undefined;
}

/**
 * Resolves the client's compatibility versions from build-time environment variables or stamped HTML metadata
 * when present, falling back per-field to `DEFAULT_COMPATIBILITY_VERSIONS`.
 */
export function getClientVersions(envOverride?: Record<string, unknown>): CompatibilityVersions {
  const env = envOverride ?? (import.meta as { env?: Record<string, unknown> }).env;
  const buildFallback =
    envOverride === undefined
      ? (readMetaVersion('aoe-build-version') ?? DEFAULT_COMPATIBILITY_VERSIONS.build)
      : DEFAULT_COMPATIBILITY_VERSIONS.build;
  return {
    protocol: pickEnvVersion(env, 'VITE_PROTOCOL_VERSION', DEFAULT_COMPATIBILITY_VERSIONS.protocol),
    rules: pickEnvVersion(env, 'VITE_RULES_VERSION', DEFAULT_COMPATIBILITY_VERSIONS.rules),
    build: pickEnvVersion(env, 'VITE_BUILD_VERSION', buildFallback),
    assets: pickEnvVersion(env, 'VITE_ASSETS_VERSION', DEFAULT_COMPATIBILITY_VERSIONS.assets),
  };
}

export function formatVersionMismatchMessage(diagnostics: CompatibilityDiagnostics): string {
  if (diagnostics.ok || diagnostics.mismatches.length === 0) return '';
  const summary = diagnostics.mismatches
    .map((m) => `${m.field}: client "${m.client}" vs server "${m.server}"`)
    .join('; ');
  return `Version mismatch (${summary}). Reload the page or update the client to match the host server.`;
}

/** Compares client and server compatibility versions and returns per-field diagnostics. */
export function checkCompatibility(
  clientVersions: CompatibilityVersions,
  serverVersions: CompatibilityVersions,
): CompatibilityDiagnostics {
  const fieldStatus = (field: CompatibilityField): FieldCompatibility => {
    const client = clientVersions[field];
    const server = serverVersions[field];
    return { match: client === server, client, server };
  };

  const protocol = fieldStatus('protocol');
  const rules = fieldStatus('rules');
  const build = fieldStatus('build');
  const assets = fieldStatus('assets');
  const byField: Record<CompatibilityField, FieldCompatibility> = { protocol, rules, build, assets };

  const mismatches: CompatibilityMismatch[] = [];
  for (const field of COMPATIBILITY_FIELDS) {
    const entry = byField[field];
    if (!entry.match) {
      mismatches.push({ field, client: entry.client, server: entry.server });
    }
  }

  const ok =
    isCompatibilityVersions(clientVersions) &&
    isCompatibilityVersions(serverVersions) &&
    sameCompatibilityVersions(clientVersions, serverVersions) &&
    mismatches.length === 0;

  const diagnostics: CompatibilityDiagnostics = {
    ok,
    protocol,
    rules,
    build,
    assets,
    mismatches,
    message: null,
  };
  if (!ok) {
    diagnostics.message =
      mismatches.length > 0
        ? formatVersionMismatchMessage(diagnostics)
        : 'Invalid compatibility version metadata.';
  }
  return diagnostics;
}

function versionsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed ? `${trimmed}/api/versions` : '/api/versions';
}

async function readHttpErrorDetail(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as { reasons?: unknown; message?: unknown; error?: unknown };
    if (Array.isArray(payload.reasons)) {
      const reasons = payload.reasons.filter((r): r is string => typeof r === 'string' && r.length > 0);
      if (reasons.length > 0) return reasons.join('; ');
    }
    if (typeof payload.message === 'string' && payload.message.trim().length > 0) return payload.message.trim();
    if (typeof payload.error === 'string' && payload.error.trim().length > 0) return payload.error.trim();
  } catch {
    // Response body is not JSON; fall back to status text.
  }
  return null;
}

/**
 * Fetches authoritative `CompatibilityVersions` from `GET /api/versions`.
 * Only falls back to `DEFAULT_COMPATIBILITY_VERSIONS` when `fallbackToDefault` is enabled
 * for offline/legacy test harnesses and the endpoint is unreachable or returns 404.
 */
export async function fetchServerVersions(
  baseUrl = '',
  options: FetchServerVersionsOptions = {},
): Promise<VersionFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const fallbackToDefault = options.fallbackToDefault === true;
  const url = versionsEndpoint(baseUrl);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
  } catch {
    if (fallbackToDefault) {
      return {
        ok: true,
        versions: { ...DEFAULT_COMPATIBILITY_VERSIONS },
        source: 'fallback',
      };
    }
    return {
      ok: false,
      kind: 'network',
      error: 'Cannot reach the game server to verify compatibility versions. Check that the server is running and retry.',
      retryable: true,
    };
  }

  if (!response.ok) {
    if (fallbackToDefault && response.status === 404) {
      return {
        ok: true,
        versions: { ...DEFAULT_COMPATIBILITY_VERSIONS },
        source: 'fallback',
      };
    }
    const detail = await readHttpErrorDetail(response);
    return {
      ok: false,
      kind: 'http',
      status: response.status,
      error: detail
        ? `Server version check failed (HTTP ${response.status}): ${detail}`
        : `Server version check failed (HTTP ${response.status}).`,
      retryable: true,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      kind: 'invalid-payload',
      error: 'Server returned invalid version metadata.',
      retryable: true,
    };
  }

  if (!isCompatibilityVersions(payload)) {
    return {
      ok: false,
      kind: 'invalid-payload',
      error: 'Server version metadata is malformed or incomplete.',
      retryable: true,
    };
  }

  return {
    ok: true,
    versions: {
      protocol: payload.protocol,
      rules: payload.rules,
      build: payload.build,
      assets: payload.assets,
    },
    source: 'server',
  };
}

/** Queries `/api/versions` and checks full compatibility against the client's versions. */
export async function verifyVersionGate(options: VersionGateOptions = {}): Promise<VersionGateResult> {
  const clientVersions = options.clientVersions ?? getClientVersions();
  const fetched = await fetchServerVersions(options.baseUrl, {
    fetchImpl: options.fetchImpl,
    fallbackToDefault: options.fallbackToDefault,
  });
  if (!fetched.ok) {
    return {
      ok: false,
      kind: 'fetch-error',
      fetchKind: fetched.kind,
      message: fetched.error,
      ...(fetched.status !== undefined ? { status: fetched.status } : {}),
      retryable: fetched.retryable,
    };
  }

  const diagnostics = checkCompatibility(clientVersions, fetched.versions);
  if (!diagnostics.ok) {
    return {
      ok: false,
      kind: 'mismatch',
      message: diagnostics.message ?? 'Game versions do not match the host server.',
      retryable: true,
      clientVersions,
      serverVersions: fetched.versions,
      diagnostics,
    };
  }

  return {
    ok: true,
    clientVersions,
    serverVersions: fetched.versions,
    source: fetched.source,
    diagnostics,
  };
}
