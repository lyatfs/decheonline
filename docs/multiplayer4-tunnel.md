# Internet Tunnel Hosting (Opt-In)

> **Note:** LAN hosting is the default. An Internet tunnel is strictly **opt-in** for hosts who want friends outside their local network to join via a browser link (`https://.../?room=CODE`).

## 1. Prerequisites & Security Boundaries

- **User-installed binary only:** Install `cloudflared` (recommended) or `ngrok` yourself from the official vendor distribution. The launcher and `tools/host/tunnel.ts` **never** auto-download binaries, elevate privileges, or modify router/firewall/DNS settings.
- **No shell evaluation:** The tunnel adapter spawns the configured executable directly with a validated `argv` array (`shell: false`), supporting paths with spaces and Unicode characters.
- **Same-origin HTTP, Assets, and WebSocket:** Because the production server serves UI (`/`), assets (`/assets/*`), and lockstep WebSocket (`/ws`) on one port, guests opening `https://<public-host>/?room=CODE` automatically connect over `wss://<public-host>/ws` without extra port configuration.
- **Physical host vs. Lobby host:** Closing the game server, stopping the tunnel, closing the host PC lid, or sleeping the host machine immediately terminates the tunnel and drops active matches. Lobby host-role transfer only moves lobby controls between connected players; it never migrates the server or tunnel process.

## 2. Quick Tunnel (`temporary`) vs. Named Tunnel (`fixed`)

The tunnel adapter tracks `kind: 'temporary' | 'fixed'` in `TunnelStatus` so the launcher never promises a permanent URL for an ephemeral tunnel.

| Mode | Command / Setup | `kind` | URL Lifetime | Best For |
|---|---|---|---|---|
| **Cloudflare Quick Tunnel** | `cloudflared tunnel --url http://127.0.0.1:8787` | `temporary` | Changes on every restart; stops working immediately when the tunnel stops. | Ad-hoc 4-player sessions without owning a domain. |
| **Cloudflare Named Tunnel** | `cloudflared tunnel run --token-file <path>` (or `TUNNEL_TOKEN` env) + user-configured `publicUrl` | `fixed` | Stable `https://your-domain.example` across restarts (while tunnel & server run). | Regular hosting with your own domain & Cloudflare tunnel. |
| **ngrok / Custom Binary** | `ngrok http http://127.0.0.1:8787 --log=stdout` (or custom validated `argv`) | `temporary` (or `fixed` with user domain) | Depends on user plan/domain. | Hosts who already use ngrok or another HTTPS tunnel. |

### Validating `publicUrl`

Both user-supplied fixed domains and URLs parsed from tunnel stdout/stderr must pass `validatePublicUrl`:
- Must be a valid `https://` origin (`http://`, `ws://`, credentials, paths, and query parameters are rejected).
- Loopback, link-local, private LAN IPv4/IPv6 addresses, `.localhost`, `.local`, `.internal`, and single-label hostnames are rejected.
- Known vendor documentation/API URLs logged during startup (for example `api.trycloudflare.com` or `developers.cloudflare.com`) are ignored.

## 3. Token Security

- **Never** embed tunnel tokens, room rejoin tokens, or bot tokens in invite links (`?room=CODE`), commit them to Git, or share them in chat.
- For named Cloudflare tunnels, prefer `--token-file` (with OS permissions restricted to your user) or the `TUNNEL_TOKEN` environment variable rather than passing `--token` on the command line.
- All tunnel log lines (`logPath` / `onLog`) and error messages stored in `TunnelStatus.error` are filtered through `redactSecrets(...)`, which masks `Bearer` headers, `TUNNEL_TOKEN` / `NGROK_AUTHTOKEN` assignments, `--token` flags, URL query tokens, URL basic-auth credentials, and JWT / base64 `eyJ...` tokens.

## 4. Lifecycle, Reconnects, and Process Ownership

- **Startup timeout:** If the tunnel does not emit a valid `https://` URL (or named-tunnel connection confirmation) within `timeoutMs` (default `30000` ms), the adapter terminates only the child process it spawned and reports `state: 'failed'` with `publicUrl: null`.
- **No stale URLs:** Stopping the tunnel (`stop()`), experiencing a process crash, or restarting (`start()`) immediately clears `publicUrl` to `null` so an expired link cannot be copied by mistake.
- **Transient disconnects vs. process exit:**
  - Brief network blips where `cloudflared` stays alive and reconnects its edge connection allow players to recover via existing room rejoin tokens (within the server's grace window).
  - If the tunnel process exits unexpectedly, `TunnelStatus.state` becomes `'failed'` and `publicUrl` becomes `null`. Restarting a quick tunnel generates a **new** temporary URL, so players will need the new invite link.
- **Strict PID ownership:** `stop()` only targets the child process / process tree spawned by the adapter instance and never runs global kills (`pkill` / `taskkill /IM`). If the child has already exited, `stop()` skips signaling the OS PID to avoid harming an unrelated process after PID reuse.

## 5. Troubleshooting

| Symptom | Likely Cause | Action |
|---|---|---|
| `ENOENT` on start | `cloudflared` / `ngrok` is not installed or not in `PATH`. | Install the binary officially or configure the explicit executable path. |
| Startup timeout (`state: 'failed'`) | Outbound tunnel connection blocked by ISP, corporate firewall, or VPN, or slow edge handshake. | Check Internet/VPN connectivity, increase `timeoutMs`, or configure your local `cloudflared` transport protocol (e.g. `http2`). |
| Guests get WebSocket or asset errors | Guests opened an expired quick-tunnel link, or the local production server is not listening on `localUrl`. | Verify the local server `/api/health` is ready and share the current `publicUrl` from the active session. |
| URL rejected as invalid/internal | Fixed `publicUrl` uses `http://`, localhost/LAN IP, path, or query string. | Provide a clean external `https://your-host.example` origin. |

## 6. Verification Scope

- Automated unit tests (`tools/host/tunnel.test.ts`, gates `O07` and `O08`) verify URL parsing, token redaction, `shell: false` `argv` validation, startup timeout, crash cleanup, and process ownership using mock child process fixtures without network calls.
- Real outside-LAN gameplay over a live tunnel (`O09` / `A09`) requires an external client on a separate network and must be verified manually with a live host environment.
