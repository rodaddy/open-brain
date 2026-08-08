import { describe, expect, it } from "bun:test";
import type os from "node:os";
import {
  readDeployedRevision,
  resolveServerIdentity,
} from "./server-identity.ts";

type Interfaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

function ipv4(
  address: string,
  internal = false,
): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}

/**
 * The interface SHAPE of the Mac that exposed this defect, verified live on
 * 2026-08-04: a loopback, the true LAN address on `en0`, a second physical
 * address on `en1`, and a VM bridge on `en10`. The addresses are neutral
 * stand-ins for that machine's real ones (#636).
 *
 * They must stay inside an RFC1918 range, because that membership is the
 * property under test: resolution step 3 is "detected PRIVATE LAN interfaces"
 * (docs/CONFIG_REFERENCE.md, "Host identity in /health"), and `isPrivateIpv4`
 * accepts 10/8, 172.16/12, 192.168/16, 169.254/16 and 100.64/10 only. The usual
 * documentation range 192.0.2.0/24 (TEST-NET-1, RFC5737) is NOT private, so
 * using it here makes the resolver correctly skip `en0` and collapses every
 * expectation onto the `en10` bridge.
 */
function macMiniInterfaces(): Interfaces {
  return {
    lo0: [ipv4("127.0.0.1", true)],
    en0: [ipv4("172.16.0.20")],
    en1: [ipv4("172.16.0.131")],
    en10: [ipv4("192.168.127.11")],
  };
}

const hostname = () => "Mini-M4-Pro.local";

describe("server identity resolution", () => {
  // -- The defect ------------------------------------------------------------
  it("reports the real LAN address when the bind host is the 0.0.0.0 wildcard", () => {
    // RED PROOF. This is the measured local-clone configuration: no
    // OPEN_BRAIN_SERVER_IP, OPEN_BRAIN_BIND_HOST=0.0.0.0. The shipped code
    // answered "unknown" here, which is what a client saw on 127.0.0.1:3100.
    const identity = resolveServerIdentity({
      bindHost: "0.0.0.0",
      interfaces: macMiniInterfaces,
      hostname,
    });

    expect(identity.serverIp).toBe("172.16.0.20");
    expect(identity.serverIp).not.toBe("unknown");
    expect(identity.serverIps).toContain("172.16.0.20");
  });

  it("reports the real LAN address when nothing at all is configured", () => {
    const identity = resolveServerIdentity({
      interfaces: macMiniInterfaces,
      hostname,
    });

    expect(identity.serverIp).toBe("172.16.0.20");
    expect(identity.serverIps).not.toEqual(["unknown"]);
  });

  // -- Precedence ------------------------------------------------------------
  it("prefers the explicitly advertised address over detection", () => {
    const identity = resolveServerIdentity({
      configuredServerIp: "172.16.0.21",
      bindHost: "0.0.0.0",
      interfaces: macMiniInterfaces,
      hostname,
    });

    expect(identity.serverIp).toBe("172.16.0.21");
    expect(identity.serverIps).toEqual(["172.16.0.21"]);
  });

  it("uses a concrete bind host in preference to detection", () => {
    const identity = resolveServerIdentity({
      bindHost: "172.16.0.131",
      interfaces: macMiniInterfaces,
      hostname,
    });

    expect(identity.serverIp).toBe("172.16.0.131");
    expect(identity.serverIps).toEqual(["172.16.0.131"]);
  });

  it.each([
    ["0.0.0.0"],
    ["::"],
    ["[::]"],
    ["127.0.0.1"],
    ["::1"],
    ["[::1]"],
    ["localhost"],
    ["unknown"],
  ])("never answers with the non-identifying bind value %s", (bindHost) => {
    const identity = resolveServerIdentity({
      bindHost,
      interfaces: macMiniInterfaces,
      hostname,
    });

    expect(identity.serverIp).toBe("172.16.0.20");
  });

  it("ignores an explicit server IP that is itself loopback or wildcard", () => {
    const identity = resolveServerIdentity({
      configuredServerIp: "127.0.0.1",
      interfaces: macMiniInterfaces,
      hostname,
    });

    expect(identity.serverIp).toBe("172.16.0.20");
  });

  it("treats a blank or whitespace-only configuration value as unset", () => {
    const identity = resolveServerIdentity({
      configuredServerIp: "   ",
      bindHost: "",
      interfaces: macMiniInterfaces,
      hostname,
    });

    expect(identity.serverIp).toBe("172.16.0.20");
  });

  // -- Ordering and disclosure bounds ----------------------------------------
  it("orders physical interfaces ahead of virtual bridges", () => {
    const identity = resolveServerIdentity({
      interfaces: () => ({
        bridge100: [ipv4("192.168.64.1")],
        en0: [ipv4("172.16.0.20")],
      }),
      hostname,
    });

    expect(identity.serverIp).toBe("172.16.0.20");
    expect(identity.serverIps).toEqual(["172.16.0.20", "192.168.64.1"]);
  });

  it("orders interfaces deterministically regardless of enumeration order", () => {
    // Interface enumeration order is not stable across reboots, and a /health
    // answer that reshuffles between restarts is not an identity.
    const shuffled = resolveServerIdentity({
      interfaces: () => ({
        en10: [ipv4("192.168.127.11")],
        en1: [ipv4("172.16.0.131")],
        en0: [ipv4("172.16.0.20")],
      }),
      hostname,
    });

    expect(shuffled.serverIps).toEqual(
      resolveServerIdentity({ interfaces: macMiniInterfaces, hostname })
        .serverIps,
    );
  });

  it("sorts interface names numerically so en2 precedes en10", () => {
    const identity = resolveServerIdentity({
      interfaces: () => ({
        en10: [ipv4("192.168.127.11")],
        en2: [ipv4("172.16.0.55")],
      }),
      hostname,
    });

    expect(identity.serverIps).toEqual(["172.16.0.55", "192.168.127.11"]);
  });

  it("keeps every detected private address visible, not just the winner", () => {
    const identity = resolveServerIdentity({
      interfaces: macMiniInterfaces,
      hostname,
    });

    // en0, en1, en10 — numerically sorted, so the VM bridge on en10 stays
    // visible but never displaces a real adapter.
    expect(identity.serverIps).toEqual([
      "172.16.0.20",
      "172.16.0.131",
      "192.168.127.11",
    ]);
  });

  it("never volunteers a public address through detection", () => {
    // `/health` is unauthenticated, so detection is bounded to private ranges.
    const identity = resolveServerIdentity({
      interfaces: () => ({ en0: [ipv4("203.0.113.7")] }),
      hostname,
    });

    expect(identity.serverIp).toBe("unknown");
    expect(identity.serverIps).toEqual(["unknown"]);
  });

  it("still advertises a public address when an operator configures one explicitly", () => {
    const identity = resolveServerIdentity({
      configuredServerIp: "203.0.113.7",
      interfaces: () => ({ en0: [ipv4("203.0.113.7")] }),
      hostname,
    });

    expect(identity.serverIp).toBe("203.0.113.7");
  });

  it("skips internal loopback interfaces during detection", () => {
    const identity = resolveServerIdentity({
      interfaces: () => ({ lo0: [ipv4("127.0.0.1", true)] }),
      hostname,
    });

    expect(identity.serverIp).toBe("unknown");
  });

  it("accepts the numeric IPv4 family that older Node runtimes report", () => {
    const identity = resolveServerIdentity({
      interfaces: () =>
        ({
          en0: [{ ...ipv4("172.16.0.20"), family: 4 as unknown as "IPv4" }],
        }) as Interfaces,
      hostname,
    });

    expect(identity.serverIp).toBe("172.16.0.20");
  });

  it("deduplicates an address that appears on more than one interface", () => {
    const identity = resolveServerIdentity({
      interfaces: () => ({
        en0: [ipv4("172.16.0.20")],
        en5: [ipv4("172.16.0.20")],
      }),
      hostname,
    });

    expect(identity.serverIps).toEqual(["172.16.0.20"]);
  });

  // -- Hostname --------------------------------------------------------------
  it("reports the machine hostname alongside the address", () => {
    const identity = resolveServerIdentity({
      interfaces: macMiniInterfaces,
      hostname,
    });

    expect(identity.hostname).toBe("Mini-M4-Pro.local");
  });

  it("degrades the hostname rather than failing when it cannot be read", () => {
    const identity = resolveServerIdentity({
      interfaces: macMiniInterfaces,
      hostname: () => {
        throw new Error("no hostname");
      },
    });

    expect(identity.hostname).toBe("unknown");
    expect(identity.serverIp).toBe("172.16.0.20");
  });

  it("degrades identity rather than failing when interfaces cannot be read", () => {
    const identity = resolveServerIdentity({
      interfaces: () => {
        throw new Error("no interfaces");
      },
      hostname,
    });

    expect(identity.serverIp).toBe("unknown");
    expect(identity.hostname).toBe("Mini-M4-Pro.local");
  });
});

describe("deployed revision stamp", () => {
  const stamp = [
    "sha=f705fc9011baf60c28ef3acd4132d00ff8afc004",
    "short_sha=f705fc9",
    "ref=HEAD",
    "deployed_at=2026-08-04T14:34:50Z",
    "repo=/workspace/open-brain",
    "subject=feat(capture): say it out loud when a turn cannot be written",
  ].join("\n");

  it("reads the short sha from a real deploy stamp", () => {
    expect(readDeployedRevision(() => stamp)).toBe("f705fc9");
  });

  it("does not expose the commit subject", () => {
    // The subject is arbitrary operator text; only the sha identifies code.
    expect(readDeployedRevision(() => stamp)).not.toContain("feat");
  });

  it("tolerates a subject containing its own equals signs", () => {
    expect(
      readDeployedRevision(() => "short_sha=abc1234\nsubject=fix: a=b resolved"),
    ).toBe("abc1234");
  });

  it("returns undefined for an undeployed tree with no stamp", () => {
    expect(readDeployedRevision(() => undefined)).toBeUndefined();
  });

  it("returns undefined when the stamp is unreadable", () => {
    expect(
      readDeployedRevision(() => {
        throw new Error("ENOENT");
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the stamp carries no short_sha line", () => {
    expect(readDeployedRevision(() => "sha=abc\nref=HEAD")).toBeUndefined();
  });

  it("returns undefined when short_sha is present but empty", () => {
    expect(readDeployedRevision(() => "short_sha=")).toBeUndefined();
  });
});
