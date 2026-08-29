// Trust rules for a caller-supplied repo-fact source URL: the SSRF allowlist
// and the check that a URL actually points at the repo/path/commit it claims.
// Split out of repo-facts.ts so the schema and tool layers stay under the
// server/ file rule (issue 864).

import { logger } from "../../src/logger.ts";

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return isLoopbackOrPrivatePrefix(host) || isPrivateIpv4Range(host);
}

// The literal-prefix cases: loopback by name or address, and the two private
// IPv4 blocks whose textual prefix is unambiguous on its own.
function isLoopbackOrPrivatePrefix(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.")
  );
}

// The private ranges that need the octets parsed to decide: 172.16-31.0.0/12
// and the 169.254.0.0/16 link-local block.
function isPrivateIpv4Range(host: string): boolean {
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  const isDottedQuad =
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
  if (!isDottedQuad) return false;
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  return (
    (first === 172 && second >= 16 && second <= 31) || (first === 169 && second === 254)
  );
}

/**
 * SSRF allowlist for a caller-supplied source URL.
 *
 * A predicate, not an operation: `false` IS the reported outcome, and the
 * `.refine()` below turns it into a caller-visible validation message. So the
 * catch is not a swallowed failure -- an unparseable URL is the same verdict as
 * a disallowed one, reached the same way, and reported by the same message.
 *
 * Deliberately not logged here: the input is untrusted and unbounded, so a line
 * per rejection would let a caller drive log volume, and the boundary that
 * knows which call it belonged to is already telling them.
 */
export function isTrustedSourceUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    if (isPrivateOrLocalHost(parsed.hostname)) return false;
    return ["github.com", "raw.githubusercontent.com"].includes(
      parsed.hostname.toLowerCase(),
    );
  } catch {
    // Unparseable URL: not trusted, same as any other rejection above.
    return false;
  }
}

// What the URL path has to resolve to for the pointer to be honest: the repo
// slug, the pinned commit, and the repo-relative source path.
interface ExpectedSource {
  repoSlug: string;
  commit: string;
  repoRelativePath: string;
}

// github.com/<owner>/<repo>/blob/<commit>/<path>. The owner is deliberately not
// compared: the repo slug, commit, and path are what pin the pointer.
function blobPathMatches(decodedPath: string, expected: ExpectedSource): boolean {
  const [, urlRepo, blob, urlCommit, ...sourceParts] = decodedPath.split("/");
  return (
    urlRepo === expected.repoSlug &&
    blob === "blob" &&
    urlCommit === expected.commit &&
    sourceParts.join("/") === expected.repoRelativePath
  );
}

// raw.githubusercontent.com/<owner>/<repo>/<commit>/<path> -- the same pinning,
// one path segment shorter (no "blob").
function rawPathMatches(decodedPath: string, expected: ExpectedSource): boolean {
  const [, urlRepo, urlCommit, ...sourceParts] = decodedPath.split("/");
  return (
    urlRepo === expected.repoSlug &&
    urlCommit === expected.commit &&
    sourceParts.join("/") === expected.repoRelativePath
  );
}

/**
 * Does the source URL actually point at the repo/path/commit it claims?
 *
 * Another predicate whose `false` is the reported outcome, surfaced by the
 * `.refine()` on the caller side, so the catch is not a swallowed failure.
 *
 * One case inside is worth naming: `decodeURIComponent` throws on a malformed
 * percent escape, which lands here as "does not match" -- the same answer a
 * genuinely mismatched pointer gets. The verdict is right either way (a URL
 * that cannot be decoded cannot be proven to match), but the two are not the
 * same fault, so the shape is recorded content-free below.
 */
export function sourceUrlMatchesSource(
  rawUrl: string,
  repo: string,
  path: string,
  commit: string,
): boolean {
  try {
    const parsed = new URL(rawUrl);
    const decodedPath = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    const normalizedPath = path.replace(/^\/+/, "");
    const repoSlug =
      repo
        .replace(/^\/+|\/+$/g, "")
        .split("/")
        .at(-1) ?? repo;
    const pathParts = normalizedPath.split("/");
    const repoRelativePath =
      pathParts[0] === repoSlug && pathParts.length > 1
        ? pathParts.slice(1).join("/")
        : normalizedPath;

    const expected = { repoSlug, commit, repoRelativePath };
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "github.com") {
      return blobPathMatches(decodedPath, expected);
    }
    if (hostname === "raw.githubusercontent.com") {
      return rawPathMatches(decodedPath, expected);
    }
    return false;
  } catch (error) {
    // A malformed percent escape (URIError) is a different fault from an honest
    // mismatch, and the boolean cannot say which. Recorded content-free -- the
    // error class only, never the caller's URL -- so a pointer that is being
    // rejected for a decoding reason is diagnosable instead of just "wrong".
    logger.debug("repo_fact_source_url_undecodable", {
      error_name: error instanceof Error ? error.name : typeof error,
    });
    return false;
  }
}
