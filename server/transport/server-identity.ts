import os from "node:os";

/**
 * Who and where this brain is, for `/health`. Configuration wins; the host's
 * real private LAN interfaces answer only when configuration names no concrete
 * address, and a wildcard or loopback bind is never an answer.
 *
 * See docs/decisions/server-identity-config-first-then-private-interfaces.md
 */

/** A bind value that identifies no particular machine, so it can never be the answer. */
const UNSPECIFIED_HOSTS = new Set([
  "0.0.0.0",
  "::",
  "[::]",
  "127.0.0.1",
  "::1",
  "[::1]",
  "localhost",
  "unknown",
]);

export const UNKNOWN_SERVER_IP = "unknown";

/**
 * `/health` is unauthenticated (`server/transport/http-app.ts`), so automatic
 * interface disclosure is bounded to addresses that are only meaningful inside
 * the LAN already. A routable public address is never volunteered by detection:
 * an operator who genuinely wants to advertise one sets `OPEN_BRAIN_SERVER_IP`
 * and owns that decision explicitly.
 *
 * RFC1918 plus RFC3927 link-local and RFC6598 carrier-grade NAT, which are the
 * ranges this fleet actually appears on.
 */
/**
 * The accepted ranges as data, first octet exact and second octet inclusive.
 *
 * A `secondMin`/`secondMax` spanning the whole octet is how a /8 is written, so
 * every range is checked by one expression rather than a per-range branch.
 */
const PRIVATE_IPV4_RANGES: ReadonlyArray<{
  readonly first: number;
  readonly secondMin: number;
  readonly secondMax: number;
}> = [
  { first: 10, secondMin: 0, secondMax: 255 }, // RFC1918 10/8
  { first: 172, secondMin: 16, secondMax: 31 }, // RFC1918 172.16/12
  { first: 192, secondMin: 168, secondMax: 168 }, // RFC1918 192.168/16
  { first: 169, secondMin: 254, secondMax: 254 }, // RFC3927 link-local
  { first: 100, secondMin: 64, secondMax: 127 }, // RFC6598 carrier-grade NAT
];

function parseIpv4Octets(address: string): [number, number] | undefined {
  const octets = address.split(".").map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return undefined;
  }
  const [a, b] = octets as [number, number, number, number];
  return [a, b];
}

function isPrivateIpv4(address: string): boolean {
  const parsed = parseIpv4Octets(address);
  if (parsed === undefined) return false;
  const [a, b] = parsed;
  return PRIVATE_IPV4_RANGES.some(
    (range) => a === range.first && b >= range.secondMin && b <= range.secondMax,
  );
}

/**
 * Interfaces that exist on developer machines but are not how anything reaches
 * this service: container/VM bridges and virtual adapters. They are real,
 * non-internal, and private, so nothing else here excludes them — and on the
 * Mac that exposed this defect one of them (`en10`, 192.168.50.11) would
 * otherwise compete with the true LAN address. They stay in `server_ips`; they
 * just never take first place.
 */
const VIRTUAL_INTERFACE_PREFIXES = [
  "bridge",
  "utun",
  "vmnet",
  "docker",
  "veth",
  "tap",
  "tun",
  "awdl",
  "llw",
];

function isVirtualInterface(name: string): boolean {
  const lower = name.toLowerCase();
  return VIRTUAL_INTERFACE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export interface ServerIdentityInput {
  /** `OPEN_BRAIN_SERVER_IP` — an explicit advertised address; always wins. */
  readonly configuredServerIp?: string | undefined;
  /** `OPEN_BRAIN_BIND_HOST` — used when it names a concrete (non-wildcard) address. */
  readonly bindHost?: string | undefined;
  /** Injected for tests; defaults to the host's real interfaces. */
  readonly interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** Injected for tests; defaults to the machine hostname. */
  readonly hostname?: () => string;
}

export interface ServerIdentity {
  readonly hostname: string;
  readonly serverIp: string;
  readonly serverIps: readonly string[];
}

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isConcreteHost(value: string): boolean {
  return !UNSPECIFIED_HOSTS.has(value.toLowerCase());
}

/**
 * Every private IPv4 the host actually carries, best candidate first.
 *
 * Ordering is what makes a single `server_ip` meaningful on a multi-homed
 * machine: physical interfaces precede virtual bridges, so the address a client
 * would really use to reach this brain is the one reported, and the rest stay
 * visible in `server_ips` rather than being silently dropped.
 */
function detectLanIpv4(
  interfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string[] {
  let entries: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  try {
    entries = interfaces();
  } catch {
    // Fail open: an unreadable interface table degrades identity, never health.
    return [];
  }

  const physical: Array<{ name: string; address: string }> = [];
  const virtual: string[] = [];
  for (const [name, addresses] of Object.entries(entries)) {
    for (const address of addresses ?? []) {
      // Node <18.4 reports `family` as the number 4; newer as the string "IPv4".
      const isV4 = address.family === "IPv4" || (address.family as unknown) === 4;
      if (!isV4 || address.internal) continue;
      if (!isPrivateIpv4(address.address)) continue;
      if (isVirtualInterface(name)) {
        virtual.push(address.address);
      } else {
        physical.push({ name, address: address.address });
      }
    }
  }

  // Interface enumeration order is not guaranteed stable across reboots, and a
  // `/health` answer that reshuffles between restarts is not an identity. Sort
  // physical interfaces by name — naturally, so `en2` precedes `en10` rather
  // than sorting as text — which puts the primary adapter (`en0`) first on
  // every machine in this fleet and makes the rest deterministic.
  physical.sort((a, b) =>
    a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }),
  );

  return [...new Set([...physical.map((i) => i.address), ...virtual])];
}

/**
 * Resolve the identity `/health` reports.
 *
 * Precedence, highest first:
 *   1. `OPEN_BRAIN_SERVER_IP` — the explicit advertised address.
 *   2. `OPEN_BRAIN_BIND_HOST`, when it names a concrete address rather than a
 *      wildcard or loopback.
 *   3. Detected private LAN interfaces.
 *   4. `"unknown"` — only when the host genuinely has no private address.
 */
/**
 * The machine hostname, degraded to `"unknown"` rather than thrown.
 *
 * Fail open for the same reason `detectLanIpv4` does: a host that cannot name
 * itself still has a `/health` answer to give.
 */
function resolveHostname(hostnameFn: () => string): string {
  try {
    return hostnameFn().trim() || UNKNOWN_SERVER_IP;
  } catch {
    return UNKNOWN_SERVER_IP;
  }
}

/**
 * The first configured value that names a concrete machine — precedence steps 1
 * and 2, in order. `undefined` means configuration named nothing usable and
 * detection is next.
 */
function configuredServerIp(input: ServerIdentityInput): string | undefined {
  for (const candidate of [input.configuredServerIp, input.bindHost]) {
    const value = normalize(candidate);
    if (value && isConcreteHost(value)) return value;
  }
  return undefined;
}

export function resolveServerIdentity(input: ServerIdentityInput = {}): ServerIdentity {
  const hostname = resolveHostname(input.hostname ?? (() => os.hostname()));

  const configured = configuredServerIp(input);
  if (configured !== undefined) {
    return { hostname, serverIp: configured, serverIps: [configured] };
  }

  const detected = detectLanIpv4(input.interfaces ?? (() => os.networkInterfaces()));
  const [first] = detected;
  if (first !== undefined) {
    return { hostname, serverIp: first, serverIps: detected };
  }

  return {
    hostname,
    serverIp: UNKNOWN_SERVER_IP,
    serverIps: [UNKNOWN_SERVER_IP],
  };
}

/**
 * The deploy stamp's short sha, or `undefined` when the tree carries none.
 *
 * The deployment scripts write `.deployed-revision` as plain `key=value` lines
 * (deliberately not JSON — the commit subject is arbitrary
 * text). Only `short_sha` is read here: it is the which-code discriminator, and
 * the subject line is free-form text that does not belong on a public endpoint.
 * A dev tree that was never deployed has no stamp, which is normal, not a fault.
 */
export function readDeployedRevision(
  readStamp: () => string | undefined,
): string | undefined {
  let raw: string | undefined;
  try {
    raw = readStamp();
  } catch {
    // Deliberate fail-open, per the doc comment at :258: a tree that was never
    // deployed has no stamp, which is normal rather than a fault. This module
    // imports only `node:os` and stays logger-free; the tracing caller treats
    // undefined as an ordinary miss (observability/trace-release.ts:53).
    return undefined;
  }
  if (!raw) return undefined;
  for (const line of raw.split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key?.trim() === "short_sha") {
      const value = rest.join("=").trim();
      if (value) return value;
    }
  }
  return undefined;
}
