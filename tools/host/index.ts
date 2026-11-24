export type {
  HostConfig,
  HostConfigOverrides,
  HostState,
  HostStatus,
  LanInterfaceInfo,
  PreflightCheckResult,
  PreflightDetails,
  PreflightHooks,
  ProcessIdentity,
  ProcessRecord,
  PublicUrlKind,
  TunnelAdapter,
  TunnelStartOptions,
  TunnelStatus,
} from './types.ts';

export {
  DEFAULT_HEALTH_INTERVAL_MS,
  DEFAULT_HEALTH_TIMEOUT_MS,
  DEFAULT_HOST,
  DEFAULT_MAX_LOG_BYTES,
  DEFAULT_MAX_LOG_FILES,
  DEFAULT_PORT,
  DEFAULT_STOP_TIMEOUT_MS,
  normalizePublicUrl,
  parsePort,
  resolveHostConfig,
  resolvePathFrom,
  resolveRepoRoot,
} from './config.ts';

export {
  buildLanUrls,
  enumerateLanInterfaces,
  isLinkLocalIPv4,
  isLoopbackAddress,
  isVirtualAdapterName,
  isWildcardHost,
  selectLanAddresses,
  type EnumerateLanOptions,
  type NetworkInterfacesMap,
  type SelectLanOptions,
  type SelectLanResult,
} from './network.ts';

export {
  MIN_NODE_MAJOR,
  defaultCheckAssets,
  defaultCheckClientBuild,
  defaultCheckMultiplayerAssets,
  defaultCheckNodeVersion,
  defaultCheckPortAvailable,
  defaultCheckServerBuild,
  parseNodeMajorVersion,
  runPreflight,
} from './preflight.ts';

export {
  ProcessManager,
  appendRedactedLog,
  defaultInspectProcess,
  defaultIsPidAlive,
  redactSecrets,
  rotateLogIfNeeded,
  verifyProcessIdentity,
  type ManagedProcessStatus,
  type ProcessManagerDeps,
  type ProcessVerification,
  type SpawnServerOptions,
  type SpawnServerResult,
  type StopServerResult,
} from './process-manager.ts';

export {
  HostLauncher,
  buildLocalProbeUrl,
  createHostLauncher,
  type HostLauncherOptions,
  type HostStartOptions,
} from './launcher.ts';

export {
  buildTunnelCommand,
  createTunnelAdapter,
  extractPublicUrlFromLine,
  redactSecrets as redactTunnelSecrets,
  validatePublicUrl,
  type TunnelAdapterConfig,
  type TunnelCommandSpec,
  type TunnelLogEntry,
  type TunnelProcessLike,
  type TunnelProvider,
  type TunnelReadableStreamLike,
  type TunnelSpawnFn,
  type TunnelState,
  type TunnelTimerApi,
  type TunnelUrlKind,
  type ValidationResult,
} from './tunnel.ts';
