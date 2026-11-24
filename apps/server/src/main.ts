import { realpathSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { DEFAULT_ASSETS_DIR, DEFAULT_CLIENT_DIR } from './assets';
import { evaluateServerReadiness, normalizePublicUrl } from './versions';

export const DEFAULT_HOST = '0.0.0.0';
export const DEFAULT_PORT = 8787;

export interface ServerConfig {
  host: string;
  port: number;
  assetsDir: string;
  clientDir: string;
  publicUrl?: string;
}

export function resolveServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const hostRaw = env.HOST?.trim();
  const host = hostRaw && hostRaw.length > 0 ? hostRaw : DEFAULT_HOST;

  const portRaw = env.PORT?.trim();
  const port = portRaw && portRaw.length > 0 ? Number(portRaw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Invalid PORT configuration');
  }

  const assetsRaw = env.ASSETS_DIR?.trim();
  const clientRaw = env.CLIENT_DIR?.trim();
  const assetsDir = assetsRaw && assetsRaw.length > 0 ? resolve(assetsRaw) : DEFAULT_ASSETS_DIR;
  const clientDir = clientRaw && clientRaw.length > 0 ? resolve(clientRaw) : DEFAULT_CLIENT_DIR;
  const publicRaw = env.PUBLIC_URL?.trim();

  return {
    host,
    port,
    assetsDir,
    clientDir,
    ...(publicRaw && publicRaw.length > 0 ? { publicUrl: publicRaw } : {}),
  };
}

export function startServer(env: NodeJS.ProcessEnv = process.env): Server {
  const config = resolveServerConfig(env);
  const server = createApp({
    assetsDir: config.assetsDir,
    clientDir: config.clientDir,
    publicUrl: config.publicUrl,
  });

  server.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    console.error(`server failed to bind (${code ?? 'error'})`);
    process.exitCode = 1;
  });

  server.listen(config.port, config.host, () => {
    const address = server.address() as AddressInfo | null;
    const boundPort = address?.port ?? config.port;
    const displayHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
    console.log(`server listening on http://${displayHost}:${boundPort}`);
    const publicCheck = normalizePublicUrl(config.publicUrl);
    if (publicCheck.ok && publicCheck.origin) {
      console.log(`public origin: ${publicCheck.origin}`);
    }
    const readiness = evaluateServerReadiness({
      clientDir: config.clientDir,
      assetsDir: config.assetsDir,
      publicUrl: config.publicUrl,
    });
    if (!readiness.ready) {
      console.warn(`server readiness: not-ready (${readiness.reasons.join('; ')})`);
    }
  });

  const shutdown = (): void => {
    server.close(() => {
      process.exitCode = process.exitCode ?? 0;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const entryReal = realpathSync(resolve(entry));
    const selfReal = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32'
      ? entryReal.toLowerCase() === selfReal.toLowerCase()
      : entryReal === selfReal;
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  startServer();
}
