export type HostState = 'stopped' | 'starting' | 'ready' | 'failed';

export type PublicUrlKind = 'temporary' | 'fixed' | null;

export interface HostStatus {
  state: HostState;
  pid: number | null;
  lanUrls: string[];
  publicUrl: string | null;
  logPath: string;
  error?: string;
  publicUrlKind?: PublicUrlKind;
}

export interface TunnelStatus {
  state: 'stopped' | 'starting' | 'ready' | 'failed';
  pid: number | null;
  publicUrl: string | null;
  kind: 'temporary' | 'fixed';
  error?: string;
}

export interface TunnelStartOptions {
  localUrl: string;
  logPath?: string;
  publicUrl?: string;
  timeoutMs?: number;
}

export interface TunnelAdapter {
  start(options: TunnelStartOptions): Promise<TunnelStatus>;
  stop(): Promise<void>;
  status(): TunnelStatus;
}

export interface HostConfig {
  repoRoot: string;
  cwd: string;
  nodeExecutable: string;
  host: string;
  port: number;
  serverEntry: string;
  clientDir: string;
  assetsDir: string;
  stateDir: string;
  logPath: string;
  pidFilePath: string;
  lockFilePath: string;
  publicUrl: string | null;
  preferredInterface: string | null;
  healthTimeoutMs: number;
  healthIntervalMs: number;
  stopTimeoutMs: number;
  maxLogBytes: number;
  maxLogFiles: number;
}

export interface HostConfigOverrides {
  repoRoot?: string;
  cwd?: string;
  nodeExecutable?: string;
  host?: string;
  port?: number | string;
  serverEntry?: string;
  clientDir?: string;
  assetsDir?: string;
  stateDir?: string;
  logPath?: string;
  pidFilePath?: string;
  lockFilePath?: string;
  publicUrl?: string | null;
  preferredInterface?: string | null;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  stopTimeoutMs?: number;
  maxLogBytes?: number;
  maxLogFiles?: number;
}

export interface LanInterfaceInfo {
  name: string;
  address: string;
  netmask: string;
  cidr: string | null;
  family: 'IPv4';
  internal: boolean;
}

export interface PreflightDetails {
  nodeVersion: string;
  serverEntry: string;
  clientIndex: string;
  assetsDir: string;
  assetsManifest: string;
  host: string;
  port: number;
}

export interface PreflightCheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  details: PreflightDetails;
}

export interface PreflightHooks {
  checkNodeVersion?: () => Promise<string | null> | string | null;
  checkServerBuild?: (serverEntry: string) => Promise<string | null> | string | null;
  checkClientBuild?: (clientDir: string) => Promise<string | null> | string | null;
  checkAssets?: (assetsDir: string) => Promise<string[] | string | null> | string[] | string | null;
  checkPortAvailable?: (host: string, port: number) => Promise<string | null> | string | null;
}

export interface ProcessRecord {
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  startedAt: string;
  port: number;
  host: string;
  nonce: string;
  serverEntry: string;
}

export interface ProcessIdentity {
  pid: number;
  commandLine: string;
  startedAtMs: number | null;
}
