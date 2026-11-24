import { execFile as execFileCb, spawn as spawnCb, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, openSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { HostConfig, ProcessIdentity, ProcessRecord } from './types.ts';

const LOCK_STALE_MS = 30_000;
const PID_POLL_MS = 100;

export function redactSecrets(input: string): string {
  let out = input;
  // Redact embedded credentials in URLs: https://user:pass@host -> https://[REDACTED]@host
  out = out.replace(/(https?:\/\/)([^/\s:@]+:[^/\s@]+@)/gi, '$1[REDACTED]@');
  // Redact Authorization: Bearer <token>
  out = out.replace(/(Authorization\s*:\s*Bearer\s+)([^\s"']+)/gi, '$1[REDACTED]');
  // Redact key=value / key: value token-like parameters
  out = out.replace(
    /(\b(?:rejoin_?token|bot_?token|tunnel_?token|access_?token|auth_?token|token|secret|password)\b\s*[=:]\s*)(["']?)([^\s"',&;]+)\2/gi,
    '$1$2[REDACTED]$2',
  );
  // Redact JSON "token":"..." fields
  out = out.replace(
    /("(?:rejoinToken|botToken|tunnelToken|accessToken|authToken|token|secret|password)"\s*:\s*")([^"]*)(")/gi,
    '$1[REDACTED]$3',
  );
  // Redact standalone JWT/Cloudflare-style tokens (eyJ...)
  out = out.replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+)?\b/g, '[REDACTED]');
  return out;
}

export async function rotateLogIfNeeded(logPath: string, maxBytes: number, maxFiles: number): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  let size = 0;
  try {
    const info = await stat(logPath);
    size = info.size;
  } catch {
    return;
  }
  if (size < maxBytes) return;

  for (let i = maxFiles - 1; i >= 1; i -= 1) {
    const src = `${logPath}.${i}`;
    const dst = `${logPath}.${i + 1}`;
    try {
      await rm(dst, { force: true });
      await rename(src, dst);
    } catch {
      // Ignore missing rotated segments
    }
  }
  try {
    await rm(`${logPath}.1`, { force: true });
    await rename(logPath, `${logPath}.1`);
  } catch {
    // Ignore race if file disappeared
  }
}

export function appendRedactedLog(logPath: string, message: string): void {
  const safe = redactSecrets(message);
  const line = safe.endsWith('\n') ? safe : `${safe}\n`;
  appendFileSync(logPath, line, 'utf8');
}

export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

function execFileAsync(
  file: string,
  args: string[],
  timeoutMs: number = 4_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCb(file, args, { shell: false, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function parseWmiCreationDate(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const msMatch = /\/Date\((\d+)\)\//.exec(raw);
  if (msMatch?.[1]) {
    const ms = Number(msMatch[1]);
    return Number.isFinite(ms) ? ms : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function defaultInspectProcess(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (platform === 'win32') {
    const psCmd = `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object ProcessId,CommandLine,ExecutablePath,CreationDate | ConvertTo-Json -Compress`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd]);
    const trimmed = stdout.trim();
    if (trimmed.length === 0) return null;
    const parsed = JSON.parse(trimmed) as {
      ProcessId?: number;
      CommandLine?: string | null;
      ExecutablePath?: string | null;
      CreationDate?: string | null;
    };
    const commandLine = [parsed.ExecutablePath, parsed.CommandLine].filter(Boolean).join(' ').trim();
    return {
      pid,
      commandLine,
      startedAtMs: parseWmiCreationDate(parsed.CreationDate),
    };
  }

  const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart=,args=']);
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  // lstart format is typically "Day Mon DD HH:MM:SS YYYY" (5 whitespace tokens) followed by args
  const match = /^([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(trimmed);
  if (match?.[1] && match[2]) {
    const startedAtMs = Date.parse(match[1]);
    return {
      pid,
      commandLine: match[2],
      startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
    };
  }
  return {
    pid,
    commandLine: trimmed,
    startedAtMs: null,
  };
}

export interface ProcessVerification {
  alive: boolean;
  matches: boolean;
  indeterminate?: boolean;
  reason: string;
}

function matchesCommandLine(commandLine: string, record: ProcessRecord): boolean {
  const normCmd = commandLine.replace(/\\/g, '/').toLowerCase();
  const normEntry = record.serverEntry.replace(/\\/g, '/').toLowerCase();
  const entryBase = basename(normEntry);
  const exeBase = basename(record.command.replace(/\\/g, '/').toLowerCase()).replace(/\.exe$/, '');

  const hasEntry = normCmd.includes(normEntry) || normCmd.includes(entryBase);
  const hasExe = exeBase.length === 0 || normCmd.includes(exeBase);
  return hasEntry && hasExe;
}

export async function verifyProcessIdentity(
  record: ProcessRecord,
  options: {
    ownedChild?: ChildProcess | null;
    isPidAlive?: (pid: number) => boolean;
    inspectProcess?: (pid: number) => Promise<ProcessIdentity | null>;
  } = {},
): Promise<ProcessVerification> {
  const checkAlive = options.isPidAlive ?? defaultIsPidAlive;
  const inspect = options.inspectProcess ?? ((pid: number) => defaultInspectProcess(pid));

  if (!checkAlive(record.pid)) {
    return { alive: false, matches: false, reason: 'process-not-running' };
  }

  if (
    options.ownedChild &&
    options.ownedChild.pid === record.pid &&
    options.ownedChild.exitCode === null &&
    !options.ownedChild.killed
  ) {
    return { alive: true, matches: true, reason: 'owned-child-handle' };
  }

  let identity: ProcessIdentity | null;
  try {
    identity = await inspect(record.pid);
  } catch {
    return {
      alive: true,
      matches: false,
      indeterminate: true,
      reason: 'process-inspection-unavailable',
    };
  }

  if (identity === null) {
    return { alive: false, matches: false, reason: 'process-exited' };
  }

  if (!matchesCommandLine(identity.commandLine, record)) {
    return { alive: true, matches: false, reason: 'pid-reused-command-mismatch' };
  }

  const recordStartedMs = Date.parse(record.startedAt);
  if (Number.isFinite(recordStartedMs) && identity.startedAtMs !== null) {
    if (identity.startedAtMs > recordStartedMs + 15_000 || identity.startedAtMs < recordStartedMs - 60_000) {
      return { alive: true, matches: false, reason: 'pid-reused-start-time-mismatch' };
    }
  }

  return { alive: true, matches: true, reason: 'verified-command-and-time' };
}

export interface ProcessManagerDeps {
  spawn?: typeof spawnCb;
  execFile?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  isPidAlive?: (pid: number) => boolean;
  inspectProcess?: (pid: number) => Promise<ProcessIdentity | null>;
  platform?: NodeJS.Platform;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface SpawnServerOptions {
  detach?: boolean;
  extraEnv?: Record<string, string | undefined>;
}

export interface SpawnServerResult {
  spawned: boolean;
  alreadyRunning: boolean;
  record: ProcessRecord;
}

export interface StopServerResult {
  stopped: boolean;
  alreadyStopped: boolean;
  pid: number | null;
  reason?: string;
}

export interface ManagedProcessStatus {
  running: boolean;
  record: ProcessRecord | null;
  verification: ProcessVerification | null;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ProcessManager {
  private readonly config: HostConfig;
  private readonly deps: ProcessManagerDeps;
  private activeChild: ChildProcess | null = null;
  private lastExitCode: number | null = null;
  private lastExitSignal: NodeJS.Signals | null = null;

  constructor(config: HostConfig, deps: ProcessManagerDeps = {}) {
    this.config = config;
    this.deps = deps;
  }

  private get platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }

  private isAlive(pid: number): boolean {
    return (this.deps.isPidAlive ?? defaultIsPidAlive)(pid);
  }

  private async runExecFile(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    if (this.deps.execFile) return this.deps.execFile(file, args);
    return execFileAsync(file, args);
  }

  private sendSignal(pid: number, signal: NodeJS.Signals): void {
    if (this.deps.killProcess) {
      this.deps.killProcess(pid, signal);
      return;
    }
    process.kill(pid, signal);
  }

  async readPidRecord(): Promise<ProcessRecord | null> {
    try {
      const raw = await readFile(this.config.pidFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ProcessRecord>;
      if (
        typeof parsed.pid === 'number' &&
        Number.isInteger(parsed.pid) &&
        parsed.pid > 0 &&
        typeof parsed.serverEntry === 'string' &&
        typeof parsed.startedAt === 'string' &&
        typeof parsed.command === 'string'
      ) {
        return {
          pid: parsed.pid,
          command: parsed.command,
          args: Array.isArray(parsed.args) ? parsed.args : [],
          cwd: typeof parsed.cwd === 'string' ? parsed.cwd : this.config.repoRoot,
          startedAt: parsed.startedAt,
          port: typeof parsed.port === 'number' ? parsed.port : this.config.port,
          host: typeof parsed.host === 'string' ? parsed.host : this.config.host,
          nonce: typeof parsed.nonce === 'string' ? parsed.nonce : '',
          serverEntry: parsed.serverEntry,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async removePidFile(): Promise<void> {
    await rm(this.config.pidFilePath, { force: true });
  }

  private async acquireLock(): Promise<void> {
    await mkdir(dirname(this.config.lockFilePath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.config.lockFilePath, 'wx');
        try {
          await handle.writeFile(
            JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
            'utf8',
          );
        } finally {
          await handle.close();
        }
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        let stale = false;
        try {
          const raw = await readFile(this.config.lockFilePath, 'utf8');
          const lockData = JSON.parse(raw) as { pid?: number; createdAt?: string };
          const ageMs = lockData.createdAt ? Date.now() - Date.parse(lockData.createdAt) : Number.POSITIVE_INFINITY;
          const holderAlive = typeof lockData.pid === 'number' && this.isAlive(lockData.pid);
          if (!holderAlive && (!Number.isFinite(ageMs) || ageMs > LOCK_STALE_MS || lockData.pid !== undefined)) {
            stale = true;
          }
        } catch {
          stale = true;
        }
        if (stale && attempt === 0) {
          await rm(this.config.lockFilePath, { force: true });
          continue;
        }
        throw new Error(`Host launcher operation already in progress (lock file: "${this.config.lockFilePath}").`);
      }
    }
  }

  private async releaseLock(): Promise<void> {
    await rm(this.config.lockFilePath, { force: true });
  }

  async inspectManagedProcess(): Promise<ManagedProcessStatus> {
    const record = await this.readPidRecord();
    if (!record) {
      return {
        running: false,
        record: null,
        verification: null,
        exitCode: this.lastExitCode,
        exitSignal: this.lastExitSignal,
      };
    }

    const verification = await verifyProcessIdentity(record, {
      ownedChild: this.activeChild,
      isPidAlive: (pid) => this.isAlive(pid),
      inspectProcess: this.deps.inspectProcess ?? ((pid) => defaultInspectProcess(pid, this.platform)),
    });

    if (!verification.alive || (!verification.matches && !verification.indeterminate)) {
      await this.removePidFile();
      if (this.activeChild?.pid === record.pid) this.activeChild = null;
      return {
        running: false,
        record: null,
        verification,
        exitCode: this.lastExitCode,
        exitSignal: this.lastExitSignal,
      };
    }

    return {
      running: verification.matches,
      record,
      verification,
      exitCode: this.lastExitCode,
      exitSignal: this.lastExitSignal,
    };
  }

  async spawnServer(options: SpawnServerOptions = {}): Promise<SpawnServerResult> {
    await mkdir(this.config.stateDir, { recursive: true });
    await this.acquireLock();
    try {
      const existing = await this.inspectManagedProcess();
      if (existing.running && existing.record) {
        return {
          spawned: false,
          alreadyRunning: true,
          record: existing.record,
        };
      }
      if (existing.verification?.indeterminate && existing.record) {
        throw new Error(
          `Existing PID file references live PID ${existing.record.pid}, but process identity could not be verified. Inspect or remove "${this.config.pidFilePath}" manually.`,
        );
      }

      await rotateLogIfNeeded(this.config.logPath, this.config.maxLogBytes, this.config.maxLogFiles);

      const nonce = randomUUID();
      const args = [this.config.serverEntry];
      const childEnv: Record<string, string | undefined> = {
        ...process.env,
        ...options.extraEnv,
        HOST: this.config.host,
        PORT: String(this.config.port),
        ASSETS_DIR: this.config.assetsDir,
        CLIENT_DIR: this.config.clientDir,
        ...(this.config.publicUrl ? { PUBLIC_URL: this.config.publicUrl } : {}),
      };

      const spawnFn = this.deps.spawn ?? spawnCb;
      const detach = Boolean(options.detach);
      this.lastExitCode = null;
      this.lastExitSignal = null;

      appendRedactedLog(
        this.config.logPath,
        `[${new Date().toISOString()}] [launcher] starting server "${this.config.serverEntry}" on ${this.config.host}:${this.config.port}`,
      );

      let logFd: number | null = null;
      let child: ChildProcess;
      try {
        if (detach) {
          logFd = openSync(this.config.logPath, 'a');
          child = spawnFn(this.config.nodeExecutable, args, {
            cwd: this.config.repoRoot,
            env: childEnv,
            shell: false,
            detached: true,
            stdio: ['ignore', logFd, logFd],
            windowsHide: true,
          });
          child.unref();
        } else {
          child = spawnFn(this.config.nodeExecutable, args, {
            cwd: this.config.repoRoot,
            env: childEnv,
            shell: false,
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
        }
      } finally {
        if (logFd !== null) {
          try {
            closeSync(logFd);
          } catch {
            // Ignore close failure
          }
        }
      }

      if (!child.pid) {
        throw new Error('Failed to spawn game server child process (missing PID).');
      }

      this.activeChild = child;
      const record: ProcessRecord = {
        pid: child.pid,
        command: this.config.nodeExecutable,
        args,
        cwd: this.config.repoRoot,
        startedAt: new Date().toISOString(),
        port: this.config.port,
        host: this.config.host,
        nonce,
        serverEntry: this.config.serverEntry,
      };

      await writeFile(this.config.pidFilePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

      if (!detach) {
        const writeChunk = (streamLabel: string, chunk: Buffer | string) => {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          for (const line of text.split(/\r?\n/)) {
            if (line.length === 0) continue;
            try {
              appendRedactedLog(this.config.logPath, `[${new Date().toISOString()}] [${streamLabel}] ${line}`);
            } catch {
              // Ignore log write error during shutdown
            }
          }
        };
        child.stdout?.on('data', (chunk: Buffer | string) => writeChunk('server', chunk));
        child.stderr?.on('data', (chunk: Buffer | string) => writeChunk('server:err', chunk));
      }

      child.once('exit', (code, signal) => {
        this.lastExitCode = code;
        this.lastExitSignal = signal;
        if (this.activeChild?.pid === record.pid) {
          this.activeChild = null;
        }
        try {
          appendRedactedLog(
            this.config.logPath,
            `[${new Date().toISOString()}] [launcher] server process ${record.pid} exited (code=${String(code)}, signal=${String(signal)})`,
          );
        } catch {
          // Ignore log failure
        }
        void this.readPidRecord().then((current) => {
          if (current?.pid === record.pid && current.nonce === record.nonce) {
            return this.removePidFile();
          }
          return undefined;
        });
      });

      return {
        spawned: true,
        alreadyRunning: false,
        record,
      };
    } finally {
      await this.releaseLock();
    }
  }

  async stopServer(): Promise<StopServerResult> {
    const record = await this.readPidRecord();
    if (!record) {
      if (this.activeChild?.pid && this.isAlive(this.activeChild.pid)) {
        const fallbackPid = this.activeChild.pid;
        await this.terminateProcessTree(fallbackPid);
        this.activeChild = null;
        return { stopped: true, alreadyStopped: false, pid: fallbackPid };
      }
      this.activeChild = null;
      return { stopped: true, alreadyStopped: true, pid: null };
    }

    const verification = await verifyProcessIdentity(record, {
      ownedChild: this.activeChild,
      isPidAlive: (pid) => this.isAlive(pid),
      inspectProcess: this.deps.inspectProcess ?? ((pid) => defaultInspectProcess(pid, this.platform)),
    });

    if (!verification.alive) {
      await this.removePidFile();
      if (this.activeChild?.pid === record.pid) this.activeChild = null;
      return { stopped: true, alreadyStopped: true, pid: record.pid, reason: verification.reason };
    }

    if (!verification.matches) {
      // PID was reused by another program or could not be verified: NEVER kill an unrelated process.
      if (!verification.indeterminate) {
        await this.removePidFile();
      }
      if (this.activeChild?.pid === record.pid) this.activeChild = null;
      try {
        appendRedactedLog(
          this.config.logPath,
          `[${new Date().toISOString()}] [launcher] refused to stop PID ${record.pid}: ${verification.reason}`,
        );
      } catch {
        // Ignore log error
      }
      return {
        stopped: false,
        alreadyStopped: false,
        pid: record.pid,
        reason: verification.reason,
      };
    }

    await this.terminateProcessTree(record.pid);
    await this.removePidFile();
    if (this.activeChild?.pid === record.pid) this.activeChild = null;
    try {
      appendRedactedLog(
        this.config.logPath,
        `[${new Date().toISOString()}] [launcher] stopped server process ${record.pid}`,
      );
    } catch {
      // Ignore log error
    }
    return { stopped: true, alreadyStopped: false, pid: record.pid };
  }

  private async terminateProcessTree(pid: number): Promise<void> {
    if (this.platform === 'win32') {
      if (this.activeChild?.pid === pid) {
        try {
          this.activeChild.kill('SIGTERM');
        } catch {
          // Fall through to taskkill
        }
        const graceDeadline = Date.now() + Math.min(1_000, this.config.stopTimeoutMs);
        while (Date.now() < graceDeadline && this.isAlive(pid)) {
          await sleep(PID_POLL_MS);
        }
      }
      if (this.isAlive(pid)) {
        try {
          await this.runExecFile('taskkill', ['/PID', String(pid), '/T', '/F']);
        } catch {
          // Process may have exited concurrently; verify below
        }
      }
      const deadline = Date.now() + this.config.stopTimeoutMs;
      while (Date.now() < deadline && this.isAlive(pid)) {
        await sleep(PID_POLL_MS);
      }
      return;
    }

    try {
      if (this.activeChild?.pid === pid) {
        this.activeChild.kill('SIGTERM');
      } else {
        this.sendSignal(pid, 'SIGTERM');
      }
    } catch {
      // May already be gone
    }

    const deadline = Date.now() + this.config.stopTimeoutMs;
    while (Date.now() < deadline && this.isAlive(pid)) {
      await sleep(PID_POLL_MS);
    }

    if (this.isAlive(pid)) {
      try {
        this.sendSignal(pid, 'SIGKILL');
      } catch {
        // Ignore if already exited
      }
      const killDeadline = Date.now() + 1_000;
      while (Date.now() < killDeadline && this.isAlive(pid)) {
        await sleep(PID_POLL_MS);
      }
    }
  }
}
