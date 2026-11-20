import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { decodeClientMessage, encode, isLobbyCiv } from '@aoe/protocol';
import { DEFAULT_ASSETS_DIR, DEFAULT_CLIENT_DIR, serveAsset, serveClient } from './assets';
import { RoomRegistry, type Peer, type RoomRegistryOptions } from './rooms';

const MAX_FRAME_BYTES = 64 * 1024;

export interface AppOptions {
  rooms?: RoomRegistry;
  /** Folder served at `/assets/` (the pack from `npm run assets:import`). */
  assetsDir?: string;
  /** Folder served at `/`: the built client (`npm run build`). */
  clientDir?: string;
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

/** HTTP server with `/health`, `/assets/*`, the built client at `/` and the game relay on WebSocket path `/ws`. */
export function createApp({
  rooms = new RoomRegistry(roomOptionsFromEnv()),
  assetsDir = process.env.ASSETS_DIR ?? DEFAULT_ASSETS_DIR,
  clientDir = process.env.CLIENT_DIR ?? DEFAULT_CLIENT_DIR,
}: AppOptions = {}): Server {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    const { method, url } = req;
    if ((method === 'GET' || method === 'HEAD') && url !== undefined) {
      void (url.startsWith('/assets/') ? serveAsset(req, url, assetsDir, res) : serveClient(req, url, clientDir, res));
      return;
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
          console.error('Error handling peer message:', err);
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
