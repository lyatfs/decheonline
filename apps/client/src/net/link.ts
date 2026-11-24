import { decodeServerMessage, DROP_AFTER_MS, encode, type ClientMessage, type ServerMessage } from '@aoe/protocol';

/** Connection to the relay: send client messages, subscribe to server messages. Modules share one link. */
export interface Link {
  send(message: ClientMessage): void;
  /** Returns an unsubscribe function. */
  onMessage(handler: (message: ServerMessage) => void): () => void;
  /** Called once when the connection is gone for good: closed, or broken with nothing to resume or no way back. */
  onClose(handler: () => void): void;
  close(): void;
  /**
   * While set, a broken socket is replaced: the link connects again, every `RETRY_MS` for up to `RESUME_FOR_MS`, and
   * sends `resume()` (a `rejoin`) first. A `bad-rejoin` answer, or running out of time, closes the link for good.
   */
  setResume?(resume: (() => ClientMessage) | null): void;
  /** Debug: break the socket now (close code 4000, the server keeps the slot) and stay away `holdMs` before reconnecting. */
  drop?(holdMs: number): void;
}

/** Between two reconnection attempts. */
export const RETRY_MS = 1000;
/** How long a broken link tries to come back: a little past the server's `DROP_AFTER_MS`, after which it says no. */
export const RESUME_FOR_MS = DROP_AFTER_MS + 10_000;
/** Close code of `Link.drop`: the server takes 4000 up (and 1006, a broken socket) as a drop, not a leave. */
const DROP_CODE = 4000;

/** ws(s) URL of the relay on the page's own origin; the dev server proxies `/ws` to the game server. */
export function relayUrl(loc: Pick<Location, 'protocol' | 'host'> = location): string {
  if (!loc.host) {
    throw new Error('cannot determine WebSocket relay host from empty location.host');
  }
  const scheme = loc.protocol === 'https:' || loc.protocol === 'wss:' ? 'wss' : 'ws';
  return `${scheme}://${loc.host}/ws`;
}

/** Opens a socket; resolves once it is open, rejects when it cannot. */
function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('error', () => reject(new Error('cannot reach the game server')), { once: true });
    socket.addEventListener('open', () => resolve(socket), { once: true });
  });
}

export async function connect(url: string = relayUrl()): Promise<Link> {
  return new SocketLink(url, await open(url));
}

class SocketLink implements Link {
  private readonly handlers = new Set<(message: ServerMessage) => void>();
  private readonly closeHandlers: (() => void)[] = [];
  private resume: (() => ClientMessage) | null = null;
  /** Gone for good: no more reconnecting, the close handlers ran. */
  private ended = false;
  /** Wall time before which a dropped link does not reconnect (`drop`). */
  private holdUntil = 0;

  constructor(
    private readonly url: string,
    private socket: WebSocket,
  ) {
    this.attach(socket);
  }

  send(message: ClientMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(encode(message));
  }

  onMessage(handler: (message: ServerMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    this.end();
  }

  setResume(resume: (() => ClientMessage) | null): void {
    this.resume = resume;
  }

  drop(holdMs: number): void {
    this.holdUntil = Date.now() + holdMs;
    this.socket.close(DROP_CODE, 'drop');
  }

  private attach(socket: WebSocket): void {
    socket.addEventListener('message', (event: MessageEvent) => {
      if (socket !== this.socket || typeof event.data !== 'string') return;
      const decoded = decodeServerMessage(event.data);
      if (!decoded.ok) return;
      if (decoded.message.t === 'error' && decoded.message.code === 'bad-rejoin') return this.end();
      for (const handler of [...this.handlers]) handler(decoded.message);
    });
    socket.addEventListener('close', () => {
      if (socket === this.socket) this.broken();
    });
  }

  /** The socket closed: come back when there is a game to resume, else the link is gone. */
  private broken(): void {
    if (this.ended) return;
    if (!this.resume) return this.end();
    const giveUpAt = Date.now() + RESUME_FOR_MS;
    const retry = (): void => {
      if (this.ended || !this.resume) return;
      if (Date.now() > giveUpAt) return this.end();
      open(this.url).then(
        (socket) => {
          if (this.ended || !this.resume) return socket.close();
          this.socket = socket;
          this.attach(socket);
          this.send(this.resume());
        },
        () => setTimeout(retry, RETRY_MS),
      );
    };
    setTimeout(retry, Math.max(0, this.holdUntil - Date.now()));
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.socket.close();
    for (const handler of this.closeHandlers) handler();
  }
}
