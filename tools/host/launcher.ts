import { resolveHostConfig } from './config.ts';
import { buildLanUrls, isWildcardHost, selectLanAddresses, type NetworkInterfacesMap } from './network.ts';
import { runPreflight } from './preflight.ts';
import { appendRedactedLog, ProcessManager, type ProcessManagerDeps } from './process-manager.ts';
import { createTunnelAdapter, type TunnelAdapterConfig } from './tunnel.ts';
import type {
  HostConfig,
  HostConfigOverrides,
  HostState,
  HostStatus,
  PreflightCheckResult,
  PreflightHooks,
  PublicUrlKind,
  TunnelAdapter,
} from './types.ts';

export interface HostStartOptions {
  detach?: boolean;
  publicUrl?: string;
  timeoutMs?: number;
}

export interface HostLauncherOptions {
  config?: HostConfig | HostConfigOverrides;
  env?: Record<string, string | undefined>;
  preflightHooks?: PreflightHooks;
  tunnelAdapter?: TunnelAdapter | null;
  tunnelConfig?: TunnelAdapterConfig;
  processManager?: ProcessManager;
  processManagerDeps?: ProcessManagerDeps;
  interfacesProvider?: () => NetworkInterfacesMap;
  fetchFn?: typeof fetch;
}

function isFullHostConfig(value: HostConfig | HostConfigOverrides | undefined): value is HostConfig {
  return Boolean(
    value &&
      typeof (value as HostConfig).pidFilePath === 'string' &&
      typeof (value as HostConfig).lockFilePath === 'string' &&
      typeof (value as HostConfig).stateDir === 'string',
  );
}

export function buildLocalProbeUrl(host: string, port: number): string {
  if (isWildcardHost(host)) return `http://127.0.0.1:${port}`;
  if (host === '::1') return `http://[::1]:${port}`;
  return `http://${host}:${port}`;
}

interface HealthProbeResult {
  ready: boolean;
  reason?: string;
}

async function probeHealthOnce(
  baseUrl: string,
  fetchFn: typeof fetch,
  timeoutMs: number = 1_500,
): Promise<HealthProbeResult> {
  const fetchWithTimeout = async (url: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchFn(url, { method: 'GET', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const apiRes = await fetchWithTimeout(`${baseUrl}/api/health`);
    if (apiRes.status === 200) {
      try {
        const body = (await apiRes.json()) as { status?: string; reasons?: string[] };
        if (body?.status === 'not-ready') {
          return {
            ready: false,
            reason: body.reasons?.join('; ') || 'Server reported status=not-ready on /api/health.',
          };
        }
      } catch {
        // Accept plain 200 if body isn't JSON
      }
      return { ready: true };
    }
    if (apiRes.status === 503) {
      try {
        const body = (await apiRes.json()) as { status?: string; reasons?: string[] };
        return {
          ready: false,
          reason: body.reasons?.join('; ') || 'Server /api/health returned 503 not-ready.',
        };
      } catch {
        return { ready: false, reason: 'Server /api/health returned 503 not-ready.' };
      }
    }
    if (apiRes.status !== 404) {
      return { ready: false, reason: `Server /api/health returned HTTP ${apiRes.status}.` };
    }
  } catch (err) {
    return { ready: false, reason: err instanceof Error ? err.message : String(err) };
  }

  try {
    const legacyRes = await fetchWithTimeout(`${baseUrl}/health`);
    if (legacyRes.status === 200) {
      return { ready: true };
    }
    return { ready: false, reason: `Server /health returned HTTP ${legacyRes.status}.` };
  } catch (err) {
    return { ready: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function isValidCompatibilityVersions(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ['protocol', 'rules', 'build', 'assets'].every(
    (key) => typeof record[key] === 'string' && record[key].length > 0 && record[key].length <= 128,
  );
}

async function probeVersionsOnce(
  baseUrl: string,
  fetchFn: typeof fetch,
  timeoutMs: number = 1_500,
): Promise<{ ok: boolean; reason?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${baseUrl}/api/versions`, { method: 'GET', signal: controller.signal });
    if (res.status === 404) {
      return { ok: true };
    }
    if (!res.ok) {
      return { ok: false, reason: `Server /api/versions returned HTTP ${res.status}.` };
    }
    const payload: unknown = await res.json();
    if (!isValidCompatibilityVersions(payload)) {
      return { ok: false, reason: 'Server /api/versions returned malformed compatibility metadata.' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HostLauncher {
  readonly config: HostConfig;
  private readonly preflightHooks: PreflightHooks;
  private readonly tunnelAdapter: TunnelAdapter | null;
  private readonly processManager: ProcessManager;
  private readonly interfacesProvider: (() => NetworkInterfacesMap) | undefined;
  private readonly fetchFn: typeof fetch;
  private lastState: HostState = 'stopped';
  private lastError: string | undefined = undefined;

  constructor(options: HostLauncherOptions = {}) {
    this.config = isFullHostConfig(options.config)
      ? options.config
      : resolveHostConfig(options.config, options.env);
    this.preflightHooks = options.preflightHooks ?? {};
    this.tunnelAdapter =
      options.tunnelAdapter !== undefined
        ? options.tunnelAdapter
        : options.tunnelConfig !== undefined
          ? createTunnelAdapter(options.tunnelConfig)
          : null;
    this.processManager =
      options.processManager ?? new ProcessManager(this.config, options.processManagerDeps);
    this.interfacesProvider = options.interfacesProvider;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async preflight(): Promise<PreflightCheckResult> {
    return runPreflight(this.config, this.preflightHooks);
  }

  private resolveLanUrls(host: string = this.config.host, port: number = this.config.port): {
    lanUrls: string[];
    warning?: string;
  } {
    const selection = selectLanAddresses({
      interfaces: this.interfacesProvider?.(),
      preferredInterface: this.config.preferredInterface,
      host,
    });
    return {
      lanUrls: buildLanUrls(selection.selected, port),
      ...(selection.warning ? { warning: selection.warning } : {}),
    };
  }

  private resolvePublicInfo(overridePublicUrl?: string): {
    publicUrl: string | null;
    publicUrlKind: PublicUrlKind;
  } {
    if (this.tunnelAdapter) {
      const tStatus = this.tunnelAdapter.status();
      if (tStatus.state === 'ready' && tStatus.publicUrl) {
        return { publicUrl: tStatus.publicUrl, publicUrlKind: tStatus.kind };
      }
    }
    const configured = overridePublicUrl ?? this.config.publicUrl;
    if (configured) {
      return { publicUrl: configured, publicUrlKind: 'fixed' };
    }
    return { publicUrl: null, publicUrlKind: null };
  }

  async start(options: HostStartOptions = {}): Promise<HostStatus> {
    const existing = await this.processManager.inspectManagedProcess();
    if (existing.running && existing.record) {
      const probeUrl = buildLocalProbeUrl(existing.record.host, existing.record.port);
      const health = await probeHealthOnce(probeUrl, this.fetchFn);
      const { lanUrls } = this.resolveLanUrls(existing.record.host, existing.record.port);
      const { publicUrl, publicUrlKind } = this.resolvePublicInfo(options.publicUrl);
      this.lastState = health.ready ? 'ready' : 'starting';
      this.lastError = health.ready ? undefined : health.reason;
      return {
        state: this.lastState,
        pid: existing.record.pid,
        lanUrls,
        publicUrl,
        publicUrlKind,
        logPath: this.config.logPath,
        ...(this.lastError ? { error: this.lastError } : {}),
      };
    }

    const preflight = await this.preflight();
    if (!preflight.ok) {
      this.lastState = 'failed';
      this.lastError = preflight.errors.join(' ');
      return {
        state: 'failed',
        pid: null,
        lanUrls: [],
        publicUrl: null,
        publicUrlKind: null,
        logPath: this.config.logPath,
        error: this.lastError,
      };
    }

    const { lanUrls, warning: lanWarning } = this.resolveLanUrls();
    this.lastState = 'starting';
    this.lastError = undefined;

    let spawnResult;
    try {
      spawnResult = await this.processManager.spawnServer({ detach: options.detach });
    } catch (err) {
      this.lastState = 'failed';
      this.lastError = err instanceof Error ? err.message : String(err);
      return {
        state: 'failed',
        pid: null,
        lanUrls: [],
        publicUrl: null,
        publicUrlKind: null,
        logPath: this.config.logPath,
        error: this.lastError,
      };
    }

    if (lanWarning) {
      try {
        appendRedactedLog(this.config.logPath, `[${new Date().toISOString()}] [launcher] warning: ${lanWarning}`);
      } catch {
        // Ignore log error
      }
    }

    const probeUrl = buildLocalProbeUrl(this.config.host, this.config.port);
    const timeoutMs = options.timeoutMs ?? this.config.healthTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    let lastHealthReason: string | undefined;

    let ready = false;
    while (Date.now() < deadline) {
      const managed = await this.processManager.inspectManagedProcess();
      if (!managed.running) {
        this.lastState = 'failed';
        this.lastError = `Game server exited before becoming ready (code=${String(managed.exitCode)}, signal=${String(managed.exitSignal)}). Inspect logs at "${this.config.logPath}".`;
        return {
          state: 'failed',
          pid: null,
          lanUrls: [],
          publicUrl: null,
          publicUrlKind: null,
          logPath: this.config.logPath,
          error: this.lastError,
        };
      }

      const health = await probeHealthOnce(probeUrl, this.fetchFn);
      if (health.ready) {
        ready = true;
        break;
      }
      lastHealthReason = health.reason;
      await sleep(this.config.healthIntervalMs);
    }

    if (!ready) {
      await this.processManager.stopServer();
      this.lastState = 'failed';
      this.lastError = `Timed out after ${timeoutMs}ms waiting for server health check at "${probeUrl}"${lastHealthReason ? ` (${lastHealthReason})` : ''}. Inspect logs at "${this.config.logPath}".`;
      return {
        state: 'failed',
        pid: null,
        lanUrls: [],
        publicUrl: null,
        publicUrlKind: null,
        logPath: this.config.logPath,
        error: this.lastError,
      };
    }

    const versionCheck = await probeVersionsOnce(probeUrl, this.fetchFn);
    if (!versionCheck.ok) {
      await this.processManager.stopServer();
      this.lastState = 'failed';
      this.lastError = versionCheck.reason ?? 'Server /api/versions check failed.';
      return {
        state: 'failed',
        pid: null,
        lanUrls: [],
        publicUrl: null,
        publicUrlKind: null,
        logPath: this.config.logPath,
        error: this.lastError,
      };
    }

    let publicUrl: string | null = options.publicUrl ?? this.config.publicUrl ?? null;
    let publicUrlKind: PublicUrlKind = publicUrl ? 'fixed' : null;

    if (this.tunnelAdapter) {
      try {
        const tunnelStatus = await this.tunnelAdapter.start({
          localUrl: probeUrl,
          logPath: this.config.logPath,
          ...(publicUrl ? { publicUrl } : {}),
          timeoutMs,
        });
        if (tunnelStatus.state === 'failed') {
          await this.processManager.stopServer();
          this.lastState = 'failed';
          this.lastError = tunnelStatus.error ?? 'Opt-in tunnel failed to start.';
          return {
            state: 'failed',
            pid: null,
            lanUrls: [],
            publicUrl: null,
            publicUrlKind: null,
            logPath: this.config.logPath,
            error: this.lastError,
          };
        }
        publicUrl = tunnelStatus.publicUrl;
        publicUrlKind = tunnelStatus.publicUrl ? tunnelStatus.kind : null;
      } catch (err) {
        await this.processManager.stopServer();
        this.lastState = 'failed';
        this.lastError = err instanceof Error ? err.message : String(err);
        return {
          state: 'failed',
          pid: null,
          lanUrls: [],
          publicUrl: null,
          publicUrlKind: null,
          logPath: this.config.logPath,
          error: this.lastError,
        };
      }
    }

    this.lastState = 'ready';
    this.lastError = undefined;
    return {
      state: 'ready',
      pid: spawnResult.record.pid,
      lanUrls,
      publicUrl,
      publicUrlKind,
      logPath: this.config.logPath,
    };
  }

  async status(): Promise<HostStatus> {
    const managed = await this.processManager.inspectManagedProcess();
    if (!managed.running || !managed.record) {
      if (this.lastState === 'failed' && this.lastError) {
        return {
          state: 'failed',
          pid: null,
          lanUrls: [],
          publicUrl: null,
          publicUrlKind: null,
          logPath: this.config.logPath,
          error: this.lastError,
        };
      }
      return {
        state: 'stopped',
        pid: null,
        lanUrls: [],
        publicUrl: null,
        publicUrlKind: null,
        logPath: this.config.logPath,
      };
    }

    const probeUrl = buildLocalProbeUrl(managed.record.host, managed.record.port);
    const health = await probeHealthOnce(probeUrl, this.fetchFn);
    const { lanUrls } = this.resolveLanUrls(managed.record.host, managed.record.port);
    const { publicUrl, publicUrlKind } = this.resolvePublicInfo();
    const tunnelStatus = this.tunnelAdapter?.status();
    const tunnelError = tunnelStatus?.state === 'failed' ? tunnelStatus.error : undefined;
    const error = !health.ready && health.reason ? health.reason : tunnelError;

    return {
      state: health.ready ? 'ready' : 'starting',
      pid: managed.record.pid,
      lanUrls,
      publicUrl,
      publicUrlKind,
      logPath: this.config.logPath,
      ...(error ? { error } : {}),
    };
  }

  async stop(): Promise<HostStatus> {
    if (this.tunnelAdapter) {
      try {
        await this.tunnelAdapter.stop();
      } catch {
        // Always continue stopping the game server process
      }
    }

    const stopResult = await this.processManager.stopServer();
    if (!stopResult.stopped) {
      this.lastState = 'failed';
      this.lastError = `Refused to terminate PID ${String(stopResult.pid)} (${stopResult.reason ?? 'identity mismatch'}).`;
      return {
        state: 'failed',
        pid: stopResult.pid,
        lanUrls: [],
        publicUrl: null,
        publicUrlKind: null,
        logPath: this.config.logPath,
        error: this.lastError,
      };
    }

    this.lastState = 'stopped';
    this.lastError = undefined;
    return {
      state: 'stopped',
      pid: null,
      lanUrls: [],
      publicUrl: null,
      publicUrlKind: null,
      logPath: this.config.logPath,
    };
  }
}

export function createHostLauncher(options: HostLauncherOptions = {}): HostLauncher {
  return new HostLauncher(options);
}
