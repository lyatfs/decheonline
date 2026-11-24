import { isIPv4 } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { LanInterfaceInfo } from './types.ts';

export type NetworkInterfacesMap = Record<string, NetworkInterfaceInfo[] | undefined>;

const VIRTUAL_INTERFACE_PATTERNS: readonly RegExp[] = [
  /vethernet/i,
  /(?:^|[\s_-])wsl(?:$|[\s_-]|\b)/i,
  /docker/i,
  /tailscale/i,
  /zerotier/i,
  /hamachi/i,
  /virtualbox|vboxnet/i,
  /vmware|vmnet/i,
  /hyper-v/i,
];

export function isVirtualAdapterName(name: string): boolean {
  return VIRTUAL_INTERFACE_PATTERNS.some((pattern) => pattern.test(name));
}

export function isLoopbackAddress(address: string): boolean {
  const lower = address.trim().toLowerCase();
  return lower === 'localhost' || lower === '::1' || lower.startsWith('127.');
}

export function isLinkLocalIPv4(address: string): boolean {
  return address.startsWith('169.254.');
}

export function isWildcardHost(host: string): boolean {
  const trimmed = host.trim();
  return trimmed === '' || trimmed === '0.0.0.0' || trimmed === '::' || trimmed === '::0';
}

function isIPv4Family(family: string | number): boolean {
  return family === 'IPv4' || family === 4;
}

function ipPriorityRank(address: string): number {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  const parts = address.split('.');
  const second = Number(parts[1]);
  if (parts[0] === '172' && Number.isInteger(second) && second >= 16 && second <= 31) return 2;
  return 3;
}

function adapterNameRank(name: string): number {
  const lower = name.toLowerCase();
  if (lower.includes('wi-fi') || lower.includes('wifi') || lower.startsWith('wlan')) return 0;
  if (lower.includes('ethernet') || lower.startsWith('eth') || lower.startsWith('en')) return 1;
  return 2;
}

function compareLanInterfaces(a: LanInterfaceInfo, b: LanInterfaceInfo): number {
  const ipDiff = ipPriorityRank(a.address) - ipPriorityRank(b.address);
  if (ipDiff !== 0) return ipDiff;
  const nameRankDiff = adapterNameRank(a.name) - adapterNameRank(b.name);
  if (nameRankDiff !== 0) return nameRankDiff;
  const nameDiff = a.name.localeCompare(b.name);
  if (nameDiff !== 0) return nameDiff;
  return a.address.localeCompare(b.address);
}

export interface EnumerateLanOptions {
  interfaces?: NetworkInterfacesMap;
  includeVirtual?: boolean;
}

export function enumerateLanInterfaces(options: EnumerateLanOptions = {}): {
  candidates: LanInterfaceInfo[];
  filteredVirtual: LanInterfaceInfo[];
} {
  const raw = options.interfaces ?? networkInterfaces();
  const includeVirtual = options.includeVirtual ?? false;
  const candidates: LanInterfaceInfo[] = [];
  const filteredVirtual: LanInterfaceInfo[] = [];

  for (const [name, entries] of Object.entries(raw)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (!isIPv4Family(entry.family as string | number)) continue;
      if (entry.internal) continue;
      if (isLoopbackAddress(entry.address) || isLinkLocalIPv4(entry.address) || entry.address === '0.0.0.0') continue;

      const info: LanInterfaceInfo = {
        name,
        address: entry.address,
        netmask: entry.netmask,
        cidr: entry.cidr ?? null,
        family: 'IPv4',
        internal: entry.internal,
      };

      if (!includeVirtual && isVirtualAdapterName(name)) {
        filteredVirtual.push(info);
      } else {
        candidates.push(info);
      }
    }
  }

  candidates.sort(compareLanInterfaces);
  filteredVirtual.sort(compareLanInterfaces);
  return { candidates, filteredVirtual };
}

export interface SelectLanOptions {
  interfaces?: NetworkInterfacesMap;
  preferredInterface?: string | null;
  host?: string;
}

export interface SelectLanResult {
  selected: LanInterfaceInfo[];
  allCandidates: LanInterfaceInfo[];
  filteredVirtual: LanInterfaceInfo[];
  warning?: string;
}

export function selectLanAddresses(options: SelectLanOptions = {}): SelectLanResult {
  const host = options.host?.trim() ?? '0.0.0.0';
  const { candidates, filteredVirtual } = enumerateLanInterfaces({ interfaces: options.interfaces });

  if (!isWildcardHost(host)) {
    if (isLoopbackAddress(host) || isLinkLocalIPv4(host)) {
      return {
        selected: [],
        allCandidates: candidates,
        filteredVirtual,
        warning: `Server HOST is set to "${host}"; LAN sharing is disabled because loopback/link-local addresses are not reachable from other devices.`,
      };
    }

    const allKnown = [...candidates, ...filteredVirtual];
    const matchedBound = allKnown.filter((item) => item.address === host);
    if (matchedBound.length > 0) {
      return { selected: matchedBound, allCandidates: candidates, filteredVirtual };
    }
    if (isIPv4(host)) {
      return {
        selected: [{ name: 'bound', address: host, netmask: '255.255.255.0', cidr: null, family: 'IPv4', internal: false }],
        allCandidates: candidates,
        filteredVirtual,
      };
    }
    return {
      selected: [],
      allCandidates: candidates,
      filteredVirtual,
      warning: `Server HOST "${host}" is not a valid IPv4 LAN address; verify HOST_INTERFACE or HOST.`,
    };
  }

  const preferred = options.preferredInterface?.trim();
  if (preferred && preferred.length > 0) {
    const allSelectable = [...candidates, ...filteredVirtual];
    const exactName = allSelectable.filter((item) => item.name === preferred);
    const ciName =
      exactName.length > 0
        ? exactName
        : allSelectable.filter((item) => item.name.toLowerCase() === preferred.toLowerCase());
    const matched = ciName.length > 0 ? ciName : allSelectable.filter((item) => item.address === preferred);

    if (matched.length > 0) {
      return { selected: matched, allCandidates: candidates, filteredVirtual };
    }
    const available = candidates.map((c) => `${c.name} (${c.address})`).join(', ');
    return {
      selected: [],
      allCandidates: candidates,
      filteredVirtual,
      warning: `Requested interface "${preferred}" was not found with a valid IPv4 LAN address.${available ? ` Available: ${available}` : ''}`,
    };
  }

  return { selected: candidates, allCandidates: candidates, filteredVirtual };
}

export function buildLanUrls(interfaces: readonly Pick<LanInterfaceInfo, 'address'>[], port: number): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const item of interfaces) {
    const address = item.address.trim();
    if (!isIPv4(address)) continue;
    if (isLoopbackAddress(address) || isLinkLocalIPv4(address) || address === '0.0.0.0') continue;
    const url = `http://${address}:${port}`;
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }

  return urls;
}
