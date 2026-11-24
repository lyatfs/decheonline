import { resolveHostConfig } from './config.ts';
import { buildLocalProbeUrl, HostLauncher } from './launcher.ts';
import { selectLanAddresses } from './network.ts';
import type { TunnelAdapterConfig, TunnelProvider } from './tunnel.ts';
import type { HostConfigOverrides, HostStatus } from './types.ts';

type CliCommand = 'start' | 'status' | 'stop' | 'preflight' | 'help';

interface ParsedArgs {
  command: CliCommand;
  overrides: HostConfigOverrides;
  detach: boolean;
  json: boolean;
  tunnel: boolean;
  tunnelProvider: TunnelProvider;
  tunnelBin?: string;
  tunnelTokenFile?: string;
  tunnelName?: string;
}

function parseTunnelProvider(value: string): TunnelProvider {
  if (value === 'cloudflared' || value === 'ngrok' || value === 'custom') {
    return value;
  }
  throw new Error(`Invalid --tunnel-provider "${value}". Expected cloudflared, ngrok, or custom.`);
}

function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const overrides: HostConfigOverrides = {};
  let command: CliCommand = 'start';
  let commandExplicit = false;
  let detach = false;
  let json = false;
  let tunnel = false;
  let tunnelProvider: TunnelProvider = 'cloudflared';
  let tunnelBin: string | undefined;
  let tunnelTokenFile: string | undefined;
  let tunnelName: string | undefined;

  const takeValue = (index: number, flag: string): { value: string; nextIndex: number } => {
    const val = argv[index + 1];
    if (val === undefined || val.startsWith('--')) {
      throw new Error(`Flag ${flag} requires a value.`);
    }
    return { value: val, nextIndex: index + 1 };
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;

    if (!arg.startsWith('-') && !commandExplicit) {
      if (arg === 'start' || arg === 'status' || arg === 'stop' || arg === 'preflight' || arg === 'help') {
        command = arg;
        commandExplicit = true;
        continue;
      }
      throw new Error(`Unknown command "${arg}". Use start, status, stop, preflight, or help.`);
    }

    if (arg === '--help' || arg === '-h') {
      command = 'help';
      continue;
    }
    if (arg === '--detach') {
      detach = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--port') {
      const { value, nextIndex } = takeValue(i, arg);
      overrides.port = value;
      i = nextIndex;
      continue;
    }
    if (arg === '--host') {
      const { value, nextIndex } = takeValue(i, arg);
      overrides.host = value;
      i = nextIndex;
      continue;
    }
    if (arg === '--assets-dir') {
      const { value, nextIndex } = takeValue(i, arg);
      overrides.assetsDir = value;
      i = nextIndex;
      continue;
    }
    if (arg === '--client-dir') {
      const { value, nextIndex } = takeValue(i, arg);
      overrides.clientDir = value;
      i = nextIndex;
      continue;
    }
    if (arg === '--public-url') {
      const { value, nextIndex } = takeValue(i, arg);
      overrides.publicUrl = value;
      i = nextIndex;
      continue;
    }
    if (arg === '--interface') {
      const { value, nextIndex } = takeValue(i, arg);
      overrides.preferredInterface = value;
      i = nextIndex;
      continue;
    }
    if (arg === '--state-dir') {
      const { value, nextIndex } = takeValue(i, arg);
      overrides.stateDir = value;
      i = nextIndex;
      continue;
    }
    if (arg === '--log-path') {
      const { value, nextIndex } = takeValue(i, arg);
      overrides.logPath = value;
      i = nextIndex;
      continue;
    }
    if (arg === '--tunnel') {
      tunnel = true;
      continue;
    }
    if (arg === '--tunnel-provider') {
      const { value, nextIndex } = takeValue(i, arg);
      tunnelProvider = parseTunnelProvider(value);
      i = nextIndex;
      continue;
    }
    if (arg === '--tunnel-bin') {
      const { value, nextIndex } = takeValue(i, arg);
      tunnelBin = value;
      i = nextIndex;
      continue;
    }
    if (arg === '--tunnel-token-file') {
      const { value, nextIndex } = takeValue(i, arg);
      tunnelTokenFile = value;
      i = nextIndex;
      continue;
    }
    if (arg === '--tunnel-name') {
      const { value, nextIndex } = takeValue(i, arg);
      tunnelName = value;
      i = nextIndex;
      continue;
    }

    throw new Error(`Unknown option "${arg}". Run with --help to see supported flags.`);
  }

  return {
    command,
    overrides,
    detach,
    json,
    tunnel,
    tunnelProvider,
    ...(tunnelBin !== undefined ? { tunnelBin } : {}),
    ...(tunnelTokenFile !== undefined ? { tunnelTokenFile } : {}),
    ...(tunnelName !== undefined ? { tunnelName } : {}),
  };
}

function printHelp(): void {
  console.log(`AoE1 Web — Production Host Launcher

Usage:
  node tools/host/cli.ts [start|status|stop|preflight|help] [options]

Options:
  --port <port>                   Server port (default: PORT env or 8787)
  --host <address>                Bind address (default: HOST env or 0.0.0.0)
  --assets-dir <path>             Path to asset pack (default: ASSETS_DIR or assets-local/pack)
  --client-dir <path>             Path to built client (default: CLIENT_DIR or apps/client/dist)
  --public-url <url>              Configured public HTTPS/HTTP origin (default: PUBLIC_URL)
  --interface <name|ip>           Preferred LAN network interface name or IPv4 address
  --state-dir <path>              Runtime state directory (PID/lock/log files)
  --log-path <path>               Log file path
  --tunnel                        Opt-in: start an Internet tunnel for outside-LAN invites
  --tunnel-provider <name>        Tunnel provider: cloudflared (default), ngrok, or custom
  --tunnel-bin <path>             Explicit path to tunnel executable (user-installed)
  --tunnel-token-file <path>      Path to tunnel token file (for named tunnels; never logged)
  --tunnel-name <name>            Optional named tunnel identifier
  --detach                        Start server in background and return when ready
  --json                          Output machine-readable JSON status
  -h, --help                      Show this help text
`);
}

function printHumanStatus(status: HostStatus, localUrl: string, lanWarning?: string): void {
  console.log(`Status:      ${status.state}`);
  console.log(`PID:         ${status.pid ?? 'none'}`);
  console.log(`Local URL:   ${localUrl}`);
  if (status.lanUrls.length > 0) {
    console.log('LAN URLs:');
    for (const url of status.lanUrls) {
      console.log(`  - ${url}`);
    }
  } else {
    console.log('LAN URLs:    none detected');
  }
  if (lanWarning) {
    console.log(`LAN Notice:  ${lanWarning}`);
  }
  if (status.publicUrl) {
    const kindLabel = status.publicUrlKind ? ` (${status.publicUrlKind})` : '';
    console.log(`Public URL:  ${status.publicUrl}${kindLabel}`);
  }
  console.log(`Log file:    ${status.logPath}`);
  if (status.error) {
    console.error(`Error:       ${status.error}`);
  }
}

async function run(): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (parsed.command === 'help') {
    printHelp();
    return 0;
  }

  if (parsed.tunnel && parsed.detach) {
    console.error('Option --tunnel cannot be combined with --detach because the tunnel lifecycle is tied to the foreground launcher.');
    return 1;
  }

  let config;
  try {
    config = resolveHostConfig(parsed.overrides);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const tunnelConfig: TunnelAdapterConfig | undefined = parsed.tunnel
    ? {
        provider: parsed.tunnelProvider,
        ...(parsed.tunnelBin !== undefined ? { executable: parsed.tunnelBin } : {}),
        ...(parsed.tunnelTokenFile !== undefined ? { tokenFile: parsed.tunnelTokenFile } : {}),
        ...(parsed.tunnelName !== undefined ? { tunnelName: parsed.tunnelName } : {}),
      }
    : undefined;

  const launcher = new HostLauncher({
    config,
    ...(tunnelConfig !== undefined ? { tunnelConfig } : {}),
  });
  const localUrl = buildLocalProbeUrl(config.host, config.port);
  const lanInfo = selectLanAddresses({ preferredInterface: config.preferredInterface, host: config.host });

  if (parsed.command === 'preflight') {
    const result = await launcher.preflight();
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.ok) {
      console.log('Preflight checks passed.');
      console.log(`  Node:   ${result.details.nodeVersion}`);
      console.log(`  Server: ${result.details.serverEntry}`);
      console.log(`  Client: ${result.details.clientIndex}`);
      console.log(`  Assets: ${result.details.assetsDir}`);
      console.log(`  Listen: ${result.details.host}:${result.details.port}`);
    } else {
      console.error('Preflight checks failed:');
      for (const err of result.errors) {
        console.error(`  - ${err}`);
      }
    }
    return result.ok ? 0 : 1;
  }

  if (parsed.command === 'status') {
    const status = await launcher.status();
    if (parsed.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      printHumanStatus(status, localUrl, lanInfo.warning);
    }
    return status.state === 'failed' ? 1 : 0;
  }

  if (parsed.command === 'stop') {
    const status = await launcher.stop();
    if (parsed.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      printHumanStatus(status, localUrl);
    }
    return status.state === 'failed' ? 1 : 0;
  }

  // Command: 'start'
  const status = await launcher.start({ detach: parsed.detach });
  if (parsed.json) {
    console.log(JSON.stringify(status, null, 2));
    if (status.state !== 'ready') return 1;
    if (parsed.detach) return 0;
  } else {
    printHumanStatus(status, localUrl, lanInfo.warning);
    if (status.state !== 'ready') {
      return 1;
    }
    if (parsed.detach) {
      console.log('\nServer started in background. Run "node tools/host/cli.ts stop" to stop it.');
      return 0;
    }
    console.log('\nLAN Share Tip: Open one of the LAN URLs above in your browser to create a room and copy a shareable LAN invite link.');
    if (status.publicUrl) {
      console.log(`Internet Share Tip: Open ${status.publicUrl} to create a room and copy an Internet invite link (temporary URLs expire on stop).`);
    }
    console.log('Physical Host Warning: Keep this window open and prevent this computer from sleeping; closing it stops the match for all players.');
    console.log('Press Ctrl+C to stop the server cleanly.');
  }

  // Foreground watch loop: keep process alive and stop child cleanly on SIGINT/SIGTERM
  return await new Promise<number>((resolveExit) => {
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(watchTimer);
      if (!parsed.json) {
        console.log('\nStopping game server...');
      }
      await launcher.stop();
      resolveExit(0);
    };

    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());

    const watchTimer = setInterval(() => {
      void launcher.status().then((current) => {
        if (current.state === 'stopped' || current.state === 'failed') {
          clearInterval(watchTimer);
          if (!stopping) {
            console.error(`Game server stopped unexpectedly. Inspect logs at: ${current.logPath}`);
            resolveExit(1);
          }
        }
      });
    }, 2_000);
  });
}

const exitCode = await run();
process.exit(exitCode);
