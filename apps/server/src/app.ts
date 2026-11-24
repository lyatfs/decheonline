import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_COMPATIBILITY_VERSIONS,
  decodeClientMessage,
  encode,
  isCompatibilityVersions,
  isLobbyCiv,
  sameCompatibilityVersions,
  type CompatibilityVersions,
} from '@aoe/protocol';
import { DEFAULT_ASSETS_DIR, DEFAULT_CLIENT_DIR, serveAsset, serveClient, type PackAuditFn } from './assets';
import { RoomRegistry, type Peer, type RoomRegistryOptions } from './rooms';
import { computeCompatibilityVersions, evaluateServerReadiness, freezeVersions } from './versions';

const MAX_FRAME_BYTES = 64 * 1024;

export interface AppOptions {
  rooms?: RoomRegistry;
  /** Folder served at `/assets/` (the pack from `npm run assets:import`). */
  assetsDir?: string;
  /** Folder served at `/`: the built client (`npm run build`). */
  clientDir?: string;
  /** Explicit compatibility versions authority; derived from client build + asset pack when omitted. */
  versions?: CompatibilityVersions;
  /** Optional public origin (`PUBLIC_URL`) validated by readiness checks. */
  publicUrl?: string;
  /** Optional asset pack audit hook (wired to M08 `auditMultiplayerAssets` in Phase 2). */
  auditPack?: PackAuditFn;
}

/**
 * Env `LOBBY_CIV` (1-17): every player starts the lobby with that civ instead of a random one, so the e2e games that do
 * not pick a civ play the same civ every run. Env `DROP_AFTER_MS`: how long a broken socket keeps its slot (default the
 * original's 120.5 s), shortened by the e2e that watches a dropped player's score line.
 */
function roomOptionsFromEnv(): RoomRegistryOptions {
  const civ = Number(process.env.LOBBY_CIV);
  const dropAfterMs = Number(process.env.DROP_AFTER_MS);
  return { ...(isLobbyCiv(civ) ? { generateCiv: () => civ } : {}), ...(dropAfterMs > 0 ? { dropAfterMs } : {}) };
}

function resolveEnvPath(value: string | undefined, fallback: string): string {
  return value !== undefined && value.trim() !== '' ? value : fallback;
}

function sendJson(req: IncomingMessage, res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

/** HTTP server with `/health`, `/api/versions`, `/api/health`, `/assets/*`, the built client at `/` and the game relay on `/ws`. */
export function createApp(options: AppOptions = {}): Server {
  const assetsDir = options.assetsDir ?? resolveEnvPath(process.env.ASSETS_DIR, DEFAULT_ASSETS_DIR);
  const clientDir = options.clientDir ?? resolveEnvPath(process.env.CLIENT_DIR, DEFAULT_CLIENT_DIR);
  const publicUrl = options.publicUrl ?? process.env.PUBLIC_URL;
  const hasExplicitVersions = options.versions !== undefined;

  if (options.rooms && hasExplicitVersions &&
      (!isCompatibilityVersions(options.versions) || !sameCompatibilityVersions(options.versions, options.rooms.compatibilityVersions))) {
    throw new Error('conflicting compatibility versions for injected room registry');
  }
  const versions: Readonly<CompatibilityVersions> = options.rooms
    ? options.rooms.compatibilityVersions
    : hasExplicitVersions
      ? freezeVersions(isCompatibilityVersions(options.versions) ? options.versions : DEFAULT_COMPATIBILITY_VERSIONS)
      : computeCompatibilityVersions({ clientDir, assetsDir, auditPack: options.auditPack });

  const rooms = options.rooms ?? new RoomRegistry({ ...roomOptionsFromEnv(), versions });

  const server = createServer((req, res) => {
    const { method, url } = req;
    let pathname: string | null = null;
    if (url !== undefined) {
      try {
        pathname = new URL(url, 'http://localhost').pathname;
      } catch {
        pathname = null;
      }
    }

    if ((method === 'GET' || method === 'HEAD') && pathname !== null) {
      if (pathname === '/health') {
        sendJson(req, res, 200, { status: 'ok' });
        return;
      }
      if (pathname === '/api/versions') {
        sendJson(req, res, 200, versions);
        return;
      }
      if (pathname === '/api/health') {
        const report = evaluateServerReadiness({
          clientDir,
          assetsDir,
          ...(hasExplicitVersions ? { versions: options.versions } : options.rooms ? { versions } : { expectedVersions: versions }),
          publicUrl,
          auditPack: options.auditPack,
        });
        if (report.ready) {
          sendJson(req, res, 200, { status: 'ready', versions: report.versions });
        } else {
          sendJson(req, res, 503, { status: 'not-ready', versions: report.versions, reasons: report.reasons });
        }
        return;
      }
      if (url !== undefined) {
        void (pathname.startsWith('/assets/') ? serveAsset(req, url, assetsDir, res) : serveClient(req, url, clientDir, res));
        return;
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_FRAME_BYTES });
  wss.on('connection', (socket: WebSocket) => {
    const peer: Peer = {
      send(message) {
        if (socket.readyState === socket.OPEN) socket.send(encode(message));
      },
    };
    socket.on('message', (data, isBinary) => {
      const decoded = isBinary
        ? ({ ok: false, error: 'binary frames not supported' } as const)
        : decodeClientMessage(data.toString());
      if (decoded.ok) {
        try {
          rooms.handle(peer, decoded.message);
        } catch (err) {
          console.error('Error handling peer message:', err instanceof Error ? err.message : 'unknown error');
        }
      } else peer.send({ t: 'error', code: 'bad-message', message: decoded.error });
    });
    // A socket that broke (1006, no close frame) or that a client closed as a drop (4000 up) may come back with `rejoin`;
    // one closed on purpose (1000, 1001 a closed tab, 1005) has left.
    socket.on('close', (code) => rooms.disconnect(peer, code === 1006 || code >= 4000));
    socket.on('error', () => socket.terminate());
  });
  server.on('close', () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
  });
  return server;
}
