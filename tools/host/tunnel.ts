import { execFile, spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname } from 'node:path';

export type TunnelState = 'stopped' | 'starting' | 'ready' | 'failed';
export type TunnelUrlKind = 'temporary' | 'fixed';
export type TunnelProvider = 'cloudflared' | 'ngrok' | 'custom';

export interface TunnelStatus {
  state: TunnelState;
  pid: number | null;
  publicUrl: string | null;
  kind: TunnelUrlKind;
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

export interface TunnelReadableStreamLike {
  on(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
}

export interface TunnelProcessLike {
  readonly pid?: number | undefined;
  readonly exitCode?: number | null | undefined;
  readonly signalCode?: NodeJS.Signals | null | undefined;
  readonly stdout?: TunnelReadableStreamLike | null | undefined;
  readonly stderr?: TunnelReadableStreamLike | null | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export type TunnelSpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => TunnelProcessLike;

export interface TunnelTimerApi {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TunnelLogEntry {
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
}

export interface TunnelAdapterConfig {
  provider?: TunnelProvider;
  executable?: string;
  args?: readonly string[];
  extraArgs?: readonly string[];
  token?: string;
  tokenFile?: string;
  tunnelName?: string;
  noAutoupdate?: boolean;
  readyPattern?: RegExp;
  defaultTimeoutMs?: number;
  stopGraceMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
  spawn?: TunnelSpawnFn;
  killProcessTree?: (pid: number, signal: NodeJS.Signals) => Promise<void> | void;
  logWriter?: (logPath: string, line: string) => Promise<void> | void;
  onLog?: (entry: TunnelLogEntry) => void;
  onStatusChange?: (status: TunnelStatus) => void;
  timers?: TunnelTimerApi;
}

export interface TunnelCommandSpec {
  executable: string;
  args: string[];
  kind: TunnelUrlKind;
  envOverrides: Record<string, string>;
}

export type ValidationResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 2_000;
const MAX_STDERR_SUMMARY_LINES = 6;

const IGNORED_TUNNEL_HOSTS = new Set([
  'api.trycloudflare.com',
  'www.trycloudflare.com',
  'developers.cloudflare.com',
  'www.cloudflare.com',
  'dash.cloudflare.com',
  'update.argotunnel.com',
  'pkg.cloudflare.com',
  'github.com',
  'raw.githubusercontent.com',
  'ngrok.com',
  'www.ngrok.com',
  'dashboard.ngrok.com',
  'bin.equinox.io',
  'dl.equinox.io',
]);

const INTERNAL_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.home',
  '.arpa',
];

const NAMED_TUNNEL_READY_PATTERNS = [
  /registered tunnel connection/i,
  /started tunnel/i,
  /tunnel ready/i,
];

function hasControlChars(value: string): boolean {
  return value.includes('\0') || value.includes('\r') || value.includes('\n');
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): TunnelProcessLike {
  return spawn(command, [...args], options) as unknown as ChildProcess;
}

async function defaultKillProcessTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  if (process.platform === 'win32') {
    const args = signal === 'SIGKILL'
      ? ['/PID', String(pid), '/T', '/F']
      : ['/PID', String(pid), '/T'];
    await new Promise<void>((resolve) => {
      execFile('taskkill', args, { windowsHide: true }, () => {
        resolve();
      });
    });
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Ignore ESRCH / already exited.
  }
}

async function defaultLogWriter(logPath: string, line: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${line}\n`, 'utf8');
}

export function redactSecrets(text: string, extraSecrets: readonly string[] = []): string {
  let result = text;

  const uniqueSecrets = [...new Set(extraSecrets)]
    .filter((secret) => secret.length >= 4)
    .sort((a, b) => b.length - a.length);

  for (const secret of uniqueSecrets) {
    if (result.includes(secret)) {
      result = result.split(secret).join('[REDACTED]');
    }
  }

  // Authorization Bearer tokens
  result = result.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[REDACTED]');

  // URL userinfo credentials
  result = result.replace(/(https?:\/\/)([^:@\s/]+):([^@\s/]+)@/gi, '$1[REDACTED]:[REDACTED]@');

  // Environment / key-value secret assignments (including JSON-quoted keys)
  result = result.replace(
    /(\b(?:TUNNEL_TOKEN|NGROK_AUTHTOKEN|NGROK_API_KEY|CF_API_TOKEN|CLOUDFLARE_API_TOKEN|AUTH_TOKEN|ACCESS_TOKEN|API_TOKEN|BOT_TOKEN|REJOIN_TOKEN|SECRET_KEY|PASSWORD)['"]?\s*[:=]\s*['"]?)([^\s'"`]+)(['"]?)/gi,
    '$1[REDACTED]$3',
  );

  // Structured/JSON quoted secret fields like {"token":"secret"}
  result = result.replace(
    /(\b(?:token|secret|password|authtoken|api_key|apikey)['"]?\s*[:=]\s*['"])([^'"]{4,})(['"])/gi,
    '$1[REDACTED]$3',
  );

  // CLI flags carrying tokens or secrets
  result = result.replace(
    /((?:--(?:token|authtoken|api-key|secret|password)|-t)(?:\s+['"]?|=))([^\s'"]+)/gi,
    '$1[REDACTED]',
  );

  // URL query parameters carrying tokens or secrets
  result = result.replace(
    /([?&](?:token|access_token|auth|authtoken|api_key|apikey|secret|password|rejoin|key)=)([^&\s#'"]+)/gi,
    '$1[REDACTED]',
  );

  // JWT tokens
  result = result.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    '[REDACTED]',
  );

  // Cloudflare base64-encoded tunnel tokens (eyJ...)
  result = result.replace(/\beyJ[A-Za-z0-9+/=_-]{28,}\b/g, '[REDACTED]');

  return result;
}

function isPrivateOrReservedIpv4Octets(a: number, b: number, c: number, d: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8 unspecified
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast & reserved (incl. 255.255.255.255)
  void d;
  return false;
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return true;
  const nums = parts.map((part) => Number(part));
  const [a, b, c, d] = nums;
  if (
    a === undefined || b === undefined || c === undefined || d === undefined
    || !Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c) || !Number.isInteger(d)
    || a < 0 || a > 255 || b < 0 || b > 255 || c < 0 || c > 255 || d < 0 || d > 255
  ) {
    return true;
  }
  return isPrivateOrReservedIpv4Octets(a, b, c, d);
}

function parseIpv6Groups(rawIp: string): number[] | null {
  const zoneIdx = rawIp.indexOf('%');
  const ip = zoneIdx >= 0 ? rawIp.slice(0, zoneIdx) : rawIp;
  const halves = ip.split('::');
  if (halves.length > 2) return null;

  const parseSegmentList = (segmentText: string): number[] | null => {
    if (segmentText === '') return [];
    const tokens = segmentText.split(':');
    const out: number[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === undefined || token === '') return null;
      if (token.includes('.')) {
        if (i !== tokens.length - 1) return null;
        const octets = token.split('.').map((part) => Number(part));
        const [o0, o1, o2, o3] = octets;
        if (
          octets.length !== 4
          || o0 === undefined || o1 === undefined || o2 === undefined || o3 === undefined
          || !Number.isInteger(o0) || !Number.isInteger(o1) || !Number.isInteger(o2) || !Number.isInteger(o3)
          || o0 < 0 || o0 > 255 || o1 < 0 || o1 > 255 || o2 < 0 || o2 > 255 || o3 < 0 || o3 > 255
        ) {
          return null;
        }
        out.push((o0 << 8) | o1, (o2 << 8) | o3);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return null;
        out.push(Number.parseInt(token, 16));
      }
    }
    return out;
  };

  const leftText = halves[0] ?? '';
  const left = parseSegmentList(leftText);
  if (left === null) return null;

  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }

  const rightText = halves[1] ?? '';
  const right = parseSegmentList(rightText);
  if (right === null) return null;

  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const groups = parseIpv6Groups(ip);
  if (!groups || groups.length !== 8) return true;
  const g0 = groups[0] ?? 0;
  const g1 = groups[1] ?? 0;
  const g2 = groups[2] ?? 0;
  const g3 = groups[3] ?? 0;
  const g4 = groups[4] ?? 0;
  const g5 = groups[5] ?? 0;
  const g6 = groups[6] ?? 0;
  const g7 = groups[7] ?? 0;

  const allZeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
  if (allZeroPrefix && g6 === 0 && (g7 === 0 || g7 === 1)) {
    return true; // :: and ::1
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    // ::ffff:0:0/96 IPv4-mapped
    return isPrivateOrReservedIpv4Octets((g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff);
  }
  if (allZeroPrefix) {
    // ::/96 IPv4-compatible
    return isPrivateOrReservedIpv4Octets((g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff);
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
  return false;
}

function isInternalHostname(hostname: string): boolean {
  const unbracketed = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  const lower = unbracketed.toLowerCase().replace(/\.+$/, '');
  if (lower.length === 0) return true;

  const ipVersion = isIP(lower);
  if (ipVersion === 4) {
    return isPrivateOrReservedIpv4(lower);
  }
  if (ipVersion === 6) {
    return isPrivateOrReservedIpv6(lower);
  }

  if (lower === 'localhost' || lower === 'localhost.localdomain') {
    return true;
  }
  if (INTERNAL_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return true;
  }
  if (!lower.includes('.')) {
    return true;
  }
  return false;
}

export function validateLocalUrl(rawUrl: string): ValidationResult {
  if (typeof rawUrl !== 'string' || hasControlChars(rawUrl)) {
    return { ok: false, reason: 'Local server URL contains invalid control characters.' };
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'Local server URL is required.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'Local server URL is malformed.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Local server URL must use http:// or https://.' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'Local server URL must not contain credentials.' };
  }
  if (parsed.hostname === '') {
    return { ok: false, reason: 'Local server URL must include a hostname.' };
  }
  if (parsed.search !== '' || parsed.hash !== '' || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    return { ok: false, reason: 'Local server URL must be an origin without path, query, or hash.' };
  }
  return { ok: true, url: parsed.origin };
}

export function validatePublicUrl(rawUrl: string): ValidationResult {
  if (typeof rawUrl !== 'string' || hasControlChars(rawUrl)) {
    return { ok: false, reason: 'Public tunnel URL contains invalid control characters.' };
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'Public tunnel URL is empty.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'Public tunnel URL is malformed.' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Public tunnel URL must use https://.' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'Public tunnel URL must not contain credentials.' };
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return { ok: false, reason: 'Public tunnel URL must not include query parameters or fragments.' };
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    return { ok: false, reason: 'Public tunnel URL must be an origin without a subpath.' };
  }
  if (isInternalHostname(parsed.hostname)) {
    return { ok: false, reason: 'Public tunnel URL must not point to an internal or loopback address.' };
  }
  return { ok: true, url: parsed.origin };
}

export function extractPublicUrlFromLine(
  rawLine: string,
  provider: TunnelProvider = 'cloudflared',
): string | null {
  const cleanLine = stripAnsi(rawLine);
  const matches = cleanLine.match(/https:\/\/[^\s"'`<>|{}\[\]\\]+/gi);
  if (!matches) return null;

  for (const rawMatch of matches) {
    const candidate = rawMatch.replace(/[.,;:!?)}\]]+$/, '');
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }

    const host = parsed.hostname.toLowerCase();
    if (IGNORED_TUNNEL_HOSTS.has(host)) {
      continue;
    }

    const validation = validatePublicUrl(candidate);
    if (!validation.ok) {
      continue;
    }

    if (provider === 'cloudflared' && host.endsWith('.trycloudflare.com')) {
      return validation.url;
    }
    return validation.url;
  }

  return null;
}

function validateExecutable(executable: string): string {
  if (typeof executable !== 'string' || hasControlChars(executable)) {
    throw new Error('Tunnel executable contains invalid control characters.');
  }
  const trimmed = executable.trim();
  if (trimmed.length === 0) {
    throw new Error('Tunnel executable path must not be empty.');
  }
  const hasSeparator = trimmed.includes('/') || trimmed.includes('\\');
  if (!hasSeparator && /[;&|`$<>]/.test(trimmed)) {
    throw new Error('Tunnel executable command name contains disallowed characters.');
  }
  return trimmed;
}

function validateArgList(args: readonly string[], label: string): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (typeof arg !== 'string' || hasControlChars(arg)) {
      throw new Error(`Tunnel ${label} contains invalid control characters.`);
    }
    out.push(arg);
  }
  return out;
}

export function buildTunnelCommand(
  config: Pick<
    TunnelAdapterConfig,
    'provider' | 'executable' | 'args' | 'extraArgs' | 'token' | 'tokenFile' | 'tunnelName' | 'noAutoupdate'
  >,
  options: Pick<TunnelStartOptions, 'localUrl' | 'publicUrl'>,
): TunnelCommandSpec {
  const provider: TunnelProvider = config.provider ?? 'cloudflared';
  const localValidation = validateLocalUrl(options.localUrl);
  if (!localValidation.ok) {
    throw new Error(localValidation.reason);
  }
  const localUrl = localValidation.url;

  let fixedPublicUrl: string | undefined;
  if (options.publicUrl !== undefined) {
    const publicValidation = validatePublicUrl(options.publicUrl);
    if (!publicValidation.ok) {
      throw new Error(publicValidation.reason);
    }
    fixedPublicUrl = publicValidation.url;
  }

  const extraArgs = validateArgList(config.extraArgs ?? [], 'extraArgs');
  const envOverrides: Record<string, string> = {};

  if (provider === 'cloudflared') {
    const executable = validateExecutable(config.executable ?? 'cloudflared');
    const hasNamedConfig =
      config.token !== undefined
      || config.tokenFile !== undefined
      || config.tunnelName !== undefined
      || fixedPublicUrl !== undefined;

    if (!hasNamedConfig) {
      const args: string[] = [];
      if (config.noAutoupdate) {
        args.push('--no-autoupdate');
      }
      args.push('tunnel', '--url', localUrl, ...extraArgs);
      return { executable, args, kind: 'temporary', envOverrides };
    }

    if (fixedPublicUrl === undefined) {
      throw new Error('Fixed or named cloudflared tunnel requires a validated https:// publicUrl.');
    }

    const args: string[] = [];
    if (config.noAutoupdate) {
      args.push('--no-autoupdate');
    }

    if (config.tokenFile !== undefined) {
      if (hasControlChars(config.tokenFile) || config.tokenFile.trim().length === 0) {
        throw new Error('Tunnel tokenFile path must be a non-empty valid path.');
      }
      args.push('tunnel', 'run', '--token-file', config.tokenFile.trim(), ...extraArgs);
      return { executable, args, kind: 'fixed', envOverrides };
    }

    if (config.token !== undefined) {
      if (hasControlChars(config.token) || config.token.trim().length === 0) {
        throw new Error('Tunnel token must be a non-empty string.');
      }
      envOverrides.TUNNEL_TOKEN = config.token.trim();
      args.push('tunnel', 'run', ...extraArgs);
      return { executable, args, kind: 'fixed', envOverrides };
    }

    if (config.tunnelName !== undefined) {
      if (hasControlChars(config.tunnelName) || config.tunnelName.trim().length === 0) {
        throw new Error('Tunnel name must be a non-empty string.');
      }
      args.push('tunnel', 'run', '--url', localUrl, config.tunnelName.trim(), ...extraArgs);
      return { executable, args, kind: 'fixed', envOverrides };
    }

    args.push('tunnel', '--url', localUrl, ...extraArgs);
    return { executable, args, kind: 'fixed', envOverrides };
  }

  if (provider === 'ngrok') {
    const executable = validateExecutable(config.executable ?? 'ngrok');
    if (config.token !== undefined) {
      if (hasControlChars(config.token) || config.token.trim().length === 0) {
        throw new Error('Tunnel token must be a non-empty string.');
      }
      envOverrides.NGROK_AUTHTOKEN = config.token.trim();
    }
    const args = ['http', localUrl, '--log=stdout'];
    if (fixedPublicUrl !== undefined) {
      args.push('--url', fixedPublicUrl);
    }
    args.push(...extraArgs);
    return {
      executable,
      args,
      kind: fixedPublicUrl !== undefined ? 'fixed' : 'temporary',
      envOverrides,
    };
  }

  if (config.executable === undefined) {
    throw new Error('Custom tunnel provider requires an explicit executable path.');
  }
  const executable = validateExecutable(config.executable);
  const templateArgs = validateArgList(config.args ?? [], 'args');
  const args = templateArgs.map((arg) => {
    if (arg === '{localUrl}') return localUrl;
    if (arg === '{publicUrl}') {
      if (fixedPublicUrl === undefined) {
        throw new Error('Custom tunnel arg "{publicUrl}" requires options.publicUrl.');
      }
      return fixedPublicUrl;
    }
    return arg;
  });
  args.push(...extraArgs);
  return {
    executable,
    args,
    kind: fixedPublicUrl !== undefined ? 'fixed' : 'temporary',
    envOverrides,
  };
}

interface ActiveChildRecord {
  generation: number;
  child: TunnelProcessLike;
  pid: number | null;
  exited: boolean;
  closed: boolean;
  stopping: boolean;
  timedOut: boolean;
  closePromise: Promise<void>;
  resolveClose: () => void;
}

class LineAccumulator {
  private buffer = '';

  push(chunk: string | Uint8Array): string[] {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    this.buffer += text;
    const lines: string[] = [];
    let newlineIdx = this.buffer.search(/\r?\n/);
    while (newlineIdx !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      const sepLen = this.buffer[newlineIdx] === '\r' && this.buffer[newlineIdx + 1] === '\n' ? 2 : 1;
      this.buffer = this.buffer.slice(newlineIdx + sepLen);
      lines.push(line);
      newlineIdx = this.buffer.search(/\r?\n/);
    }
    return lines;
  }

  flush(): string[] {
    if (this.buffer.length === 0) return [];
    const trailing = this.buffer;
    this.buffer = '';
    return [trailing];
  }
}

export function createTunnelAdapter(config: TunnelAdapterConfig = {}): TunnelAdapter {
  const provider: TunnelProvider = config.provider ?? 'cloudflared';
  const spawnFn: TunnelSpawnFn = config.spawn ?? defaultSpawn;
  const killTreeFn = config.killProcessTree ?? defaultKillProcessTree;
  const logWriterFn = config.logWriter ?? defaultLogWriter;
  const timers: TunnelTimerApi = config.timers ?? {
    setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  };
  const stopGraceMs = config.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;

  let currentStatus: TunnelStatus = {
    state: 'stopped',
    pid: null,
    publicUrl: null,
    kind: 'temporary',
  };

  let generation = 0;
  let activeRecord: ActiveChildRecord | null = null;
  let startupTimer: unknown = null;
  let pendingStartResolve: ((status: TunnelStatus) => void) | null = null;
  let logChain: Promise<void> = Promise.resolve();
  let knownSecrets: string[] = collectConfiguredSecrets(config);

  function collectConfiguredSecrets(cfg: TunnelAdapterConfig): string[] {
    const secrets: string[] = [];
    if (cfg.token && cfg.token.trim().length > 0) {
      secrets.push(cfg.token.trim());
    }
    if (cfg.env) {
      for (const [key, value] of Object.entries(cfg.env)) {
        if (value && /TOKEN|SECRET|KEY|PASSWORD/i.test(key)) {
          secrets.push(value);
        }
      }
    }
    return secrets;
  }

  function redact(text: string): string {
    return redactSecrets(text, knownSecrets);
  }

  function cloneStatus(): TunnelStatus {
    return {
      state: currentStatus.state,
      pid: currentStatus.pid,
      publicUrl: currentStatus.publicUrl,
      kind: currentStatus.kind,
      ...(currentStatus.error !== undefined ? { error: currentStatus.error } : {}),
    };
  }

  function setStatus(next: TunnelStatus, notify = false): TunnelStatus {
    currentStatus = {
      state: next.state,
      pid: next.pid,
      publicUrl: next.publicUrl,
      kind: next.kind,
      ...(next.error !== undefined ? { error: redact(next.error) } : {}),
    };
    const snapshot = cloneStatus();
    if (notify) {
      config.onStatusChange?.(snapshot);
    }
    return snapshot;
  }

  function clearStartupTimer(): void {
    if (startupTimer !== null) {
      timers.clearTimeout(startupTimer);
      startupTimer = null;
    }
  }

  function writeLog(logPath: string | undefined, stream: TunnelLogEntry['stream'], rawLine: string): void {
    const clean = redact(stripAnsi(rawLine).trimEnd());
    if (clean.length === 0) return;
    config.onLog?.({ stream, line: clean });
    if (logPath !== undefined) {
      const formatted = `[${stream}] ${clean}`;
      logChain = logChain
        .then(() => logWriterFn(logPath, formatted))
        .catch(() => {
          // Do not crash tunnel adapter if log file write fails.
        });
    }
  }

  async function terminateRecord(record: ActiveChildRecord): Promise<void> {
    if (record.closed) {
      record.resolveClose();
      return;
    }

    if (record.child.exitCode !== null || record.child.signalCode !== null) {
      record.exited = true;
    }

    if (!record.exited) {
      try {
        record.child.kill('SIGTERM');
      } catch {
        // Child may have exited concurrently.
      }
    }

    let graceHandle: unknown = null;
    const gracePromise = new Promise<'timeout'>((resolve) => {
      graceHandle = timers.setTimeout(() => resolve('timeout'), stopGraceMs);
    });

    const outcome = await Promise.race([
      record.closePromise.then(() => 'closed' as const),
      gracePromise,
    ]);

    if (graceHandle !== null) {
      timers.clearTimeout(graceHandle);
    }

    if (
      outcome === 'timeout'
      && !record.closed
      && !record.exited
      && record.child.exitCode === null
      && record.child.signalCode === null
    ) {
      if (record.pid !== null) {
        try {
          await killTreeFn(record.pid, 'SIGKILL');
        } catch {
          // Ignore already-exited PID errors.
        }
      }
      if (!record.closed && !record.exited && record.child.exitCode === null && record.child.signalCode === null) {
        try {
          record.child.kill('SIGKILL');
        } catch {
          // Ignore already-exited child errors.
        }
      }

      let forceHandle: unknown = null;
      const forcePromise = new Promise<void>((resolve) => {
        forceHandle = timers.setTimeout(() => resolve(), Math.min(stopGraceMs, 500));
      });
      await Promise.race([record.closePromise, forcePromise]);
      if (forceHandle !== null) {
        timers.clearTimeout(forceHandle);
      }
    }
  }

  async function stop(): Promise<void> {
    generation += 1;
    clearStartupTimer();

    const record = activeRecord;
    activeRecord = null;

    if (pendingStartResolve !== null) {
      const resolvePending = pendingStartResolve;
      pendingStartResolve = null;
      const stoppedSnapshot = setStatus({
        state: 'stopped',
        pid: null,
        publicUrl: null,
        kind: currentStatus.kind,
      });
      resolvePending(stoppedSnapshot);
    }

    // Clear publicUrl immediately so no stale link is observable during shutdown.
    setStatus({
      state: 'stopped',
      pid: null,
      publicUrl: null,
      kind: currentStatus.kind,
    });

    if (record !== null) {
      record.stopping = true;
      await terminateRecord(record);
    }

    await logChain;
    setStatus({
      state: 'stopped',
      pid: null,
      publicUrl: null,
      kind: currentStatus.kind,
    }, true);
  }

  function isNamedTunnelReadyLine(line: string, fixedPublicUrl: string): boolean {
    const clean = stripAnsi(line);
    if (config.readyPattern && config.readyPattern.test(clean)) {
      return true;
    }
    if (NAMED_TUNNEL_READY_PATTERNS.some((pattern) => pattern.test(clean))) {
      return true;
    }
    const extracted = extractPublicUrlFromLine(clean, provider);
    return extracted !== null && extracted === fixedPublicUrl;
  }

  async function start(options: TunnelStartOptions): Promise<TunnelStatus> {
    if (activeRecord !== null || currentStatus.state === 'starting' || currentStatus.state === 'ready') {
      await stop();
    }

    const myGen = ++generation;
    const timeoutMs = options.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      const kind: TunnelUrlKind = options.publicUrl !== undefined ? 'fixed' : 'temporary';
      return setStatus({
        state: 'failed',
        pid: null,
        publicUrl: null,
        kind,
        error: 'Tunnel startup timeoutMs must be a positive finite number.',
      }, true);
    }

    let commandSpec: TunnelCommandSpec;
    try {
      commandSpec = buildTunnelCommand(config, options);
    } catch (error) {
      const kind: TunnelUrlKind = options.publicUrl !== undefined ? 'fixed' : 'temporary';
      const message = error instanceof Error ? error.message : String(error);
      return setStatus({
        state: 'failed',
        pid: null,
        publicUrl: null,
        kind,
        error: message,
      }, true);
    }

    knownSecrets = [
      ...new Set([
        ...collectConfiguredSecrets(config),
        ...Object.values(commandSpec.envOverrides),
      ]),
    ];

    const fixedUrl = options.publicUrl !== undefined
      ? validatePublicUrl(options.publicUrl)
      : null;
    const expectedFixedUrl = fixedUrl && fixedUrl.ok ? fixedUrl.url : null;

    setStatus({
      state: 'starting',
      pid: null,
      publicUrl: null,
      kind: commandSpec.kind,
    }, true);

    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...config.env,
      ...commandSpec.envOverrides,
    };

    let child: TunnelProcessLike;
    try {
      child = spawnFn(commandSpec.executable, commandSpec.args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: mergedEnv,
        windowsHide: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeLog(options.logPath, 'system', `Failed to start tunnel process: ${message}`);
      await logChain;
      return setStatus({
        state: 'failed',
        pid: null,
        publicUrl: null,
        kind: commandSpec.kind,
        error: message,
      }, true);
    }

    const pid = typeof child.pid === 'number' && Number.isInteger(child.pid) && child.pid > 0
      ? child.pid
      : null;

    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });

    const record: ActiveChildRecord = {
      generation: myGen,
      child,
      pid,
      exited: false,
      closed: false,
      stopping: false,
      timedOut: false,
      closePromise,
      resolveClose,
    };
    activeRecord = record;
    setStatus({
      state: 'starting',
      pid,
      publicUrl: null,
      kind: commandSpec.kind,
    });

    const recentOutputLines: string[] = [];
    const stdoutLines = new LineAccumulator();
    const stderrLines = new LineAccumulator();

    return await new Promise<TunnelStatus>((resolveStart) => {
      let settled = false;

      const finishStart = (snapshot: TunnelStatus): void => {
        if (settled) return;
        settled = true;
        clearStartupTimer();
        if (pendingStartResolve === finishStart) {
          pendingStartResolve = null;
        }
        resolveStart(snapshot);
      };

      pendingStartResolve = finishStart;

      const handleLine = (stream: 'stdout' | 'stderr', line: string): void => {
        if (myGen !== generation || record.stopping || record.timedOut) {
          return;
        }
        const redacted = redact(stripAnsi(line).trimEnd());
        if (redacted.length > 0) {
          recentOutputLines.push(redacted);
          if (recentOutputLines.length > MAX_STDERR_SUMMARY_LINES) {
            recentOutputLines.shift();
          }
          writeLog(options.logPath, stream, line);
        }

        if (settled) {
          if (commandSpec.kind === 'temporary') {
            const refreshedUrl = extractPublicUrlFromLine(line, provider);
            if (refreshedUrl !== null && refreshedUrl !== currentStatus.publicUrl) {
              setStatus({
                state: 'ready',
                pid: record.pid,
                publicUrl: refreshedUrl,
                kind: 'temporary',
              }, true);
            }
          }
          return;
        }

        if (commandSpec.kind === 'fixed' && expectedFixedUrl !== null) {
          if (isNamedTunnelReadyLine(line, expectedFixedUrl)) {
            const readySnapshot = setStatus({
              state: 'ready',
              pid: record.pid,
              publicUrl: expectedFixedUrl,
              kind: 'fixed',
            }, true);
            finishStart(readySnapshot);
          }
          return;
        }

        const discoveredUrl = extractPublicUrlFromLine(line, provider);
        if (discoveredUrl !== null) {
          const readySnapshot = setStatus({
            state: 'ready',
            pid: record.pid,
            publicUrl: discoveredUrl,
            kind: 'temporary',
          }, true);
          finishStart(readySnapshot);
        }
      };

      child.stdout?.on('data', (chunk) => {
        for (const line of stdoutLines.push(chunk)) {
          handleLine('stdout', line);
        }
      });
      child.stdout?.on('end', () => {
        for (const line of stdoutLines.flush()) {
          handleLine('stdout', line);
        }
      });

      child.stderr?.on('data', (chunk) => {
        for (const line of stderrLines.push(chunk)) {
          handleLine('stderr', line);
        }
      });
      child.stderr?.on('end', () => {
        for (const line of stderrLines.flush()) {
          handleLine('stderr', line);
        }
      });

      const handleProcessClosed = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (record.closed) return;
        record.closed = true;
        record.exited = true;
        for (const line of stdoutLines.flush()) {
          handleLine('stdout', line);
        }
        for (const line of stderrLines.flush()) {
          handleLine('stderr', line);
        }
        record.resolveClose();

        if (myGen !== generation || record.stopping || record.timedOut) {
          return;
        }

        if (activeRecord === record) {
          activeRecord = null;
        }

        const exitDesc = signal !== null
          ? `signal ${signal}`
          : `exit code ${code ?? 'unknown'}`;
        const tail = recentOutputLines.length > 0 ? `: ${recentOutputLines.join(' | ')}` : '';
        const wasReady = currentStatus.state === 'ready';
        const message = wasReady
          ? `Tunnel process exited unexpectedly (${exitDesc})${tail}`
          : `Tunnel process exited before becoming ready (${exitDesc})${tail}`;

        writeLog(options.logPath, 'system', message);
        const failedSnapshot = setStatus({
          state: 'failed',
          pid: null,
          publicUrl: null,
          kind: commandSpec.kind,
          error: message,
        }, true);

        if (!settled) {
          finishStart(failedSnapshot);
        }
      };

      child.on('error', (error) => {
        record.exited = true;
        record.closed = true;
        record.resolveClose();
        if (myGen !== generation || record.stopping || record.timedOut) {
          return;
        }
        if (activeRecord === record) {
          activeRecord = null;
        }
        const message = `Tunnel process error: ${error.message}`;
        writeLog(options.logPath, 'system', message);
        const failedSnapshot = setStatus({
          state: 'failed',
          pid: null,
          publicUrl: null,
          kind: commandSpec.kind,
          error: message,
        }, true);
        if (!settled) {
          finishStart(failedSnapshot);
        }
      });

      child.on('exit', () => {
        record.exited = true;
      });
      child.on('close', handleProcessClosed);

      startupTimer = timers.setTimeout(() => {
        if (settled || myGen !== generation || record.stopping) {
          return;
        }
        record.timedOut = true;
        if (activeRecord === record) {
          activeRecord = null;
        }
        const timeoutMessage = `Tunnel startup timed out after ${timeoutMs}ms`;
        writeLog(options.logPath, 'system', timeoutMessage);
        void terminateRecord(record).then(async () => {
          await logChain;
          if (myGen !== generation) return;
          const failedSnapshot = setStatus({
            state: 'failed',
            pid: null,
            publicUrl: null,
            kind: commandSpec.kind,
            error: timeoutMessage,
          }, true);
          finishStart(failedSnapshot);
        });
      }, timeoutMs);
    });
  }

  return {
    start,
    stop,
    status: cloneStatus,
  };
}
