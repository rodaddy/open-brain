/**
 * Server configuration boundary.
 *
 * Design authority: `docs/code-brain-design.md` R3 (canon outranks runtime
 * observation) and `docs/decisions/shared-kb-canonical-namespace.md` (the
 * public shared namespace is `shared-kb`). Environment input is validated once
 * here and passed inward as typed data.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  parseMaintenanceConfig,
  type MaintenanceConfig,
} from "./config/maintenance.ts";
import { parseNatsConfig, type NatsConfig } from "./config/nats.ts";
import {
  readDeployedRevision,
  resolveServerIdentity,
} from "./transport/server-identity.ts";

export type { MaintenanceConfig } from "./config/maintenance.ts";
export { parseMaintenanceConfig } from "./config/maintenance.ts";
export type { NatsConfig } from "./config/nats.ts";
export { natsHealthFromConfig, parseNatsConfig } from "./config/nats.ts";

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const ROLE_NAMES = [
  "admin",
  "agent",
  "discord",
  "ob-admin",
  "promoter",
  "readonly",
] as const;

export const roleSchema = z.enum(ROLE_NAMES);
export type Role = z.infer<typeof roleSchema>;

const positiveInteger = z.coerce.number().int().positive();
const nonEmpty = z.string().trim().min(1);
/**
 * Every field declared with the shared optional-secret schema below.
 *
 * Exported so the boundary tests can parameterize over the whole class rather
 * than the single field that happened to break a deploy.
 */
export const OPTIONAL_SECRET_KEYS = [
  "DB_PASSWORD",
  "EMBEDDING_API_KEY",
  "AUTH_TOKEN_ADMIN",
  "AUTH_TOKEN_AGENT",
  "AUTH_TOKEN_DISCORD",
  "AUTH_TOKEN_OB_ADMIN",
  "AUTH_TOKEN_PROMOTER",
  "AUTH_TOKEN_READONLY",
] as const;

/**
 * An optional secret: absent, or a non-empty value. **Present-and-empty counts
 * as absent.**
 *
 * The `z.preprocess` is the whole point and is not decoration. Without it,
 * `z.string().min(1).optional()` accepts an unset variable but REJECTS
 * `FOO=`, and those are the same thing to every consumer of these fields:
 * `src/auth.ts` skips a role token with `if (!token)`, `src/db/pool.ts` hands
 * `process.env.DB_PASSWORD` straight to pg, and `src/embedding.ts`'s
 * `embeddingApiKey()` returns the raw value. An empty string behaves as unset
 * in all three.
 *
 * Shell environments produce empty rather than absent as a matter of course, so
 * this is the normal case and not a malformed one. The local dogfood clone env
 * sets `EMBEDDING_API_KEY=` because the local MLX embedding server needs no
 * key; on 2026-08-02 that alone made the rewritten entrypoint throw
 * `server_configuration_invalid` at startup and launchd throttle-looped it,
 * while `src/index.ts` had always started fine on the identical environment.
 *
 * Normalizing HERE, at the parse boundary, rather than at each of the eight
 * declaration sites, is what makes the rule hold for a field added later:
 * everything typed `optionalSecret` gets it. Required fields keep rejecting
 * empty — see `nonEmpty` — because there an empty value is a real misconfiguration
 * rather than an omission.
 */
const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);
const userTokenValue = z
  .string()
  .transform((value) => {
    const separator = value.indexOf(":");
    return {
      role: separator < 0 ? "" : value.slice(0, separator),
      token: separator < 0 ? "" : value.slice(separator + 1),
    };
  })
  .pipe(z.object({ role: roleSchema, token: nonEmpty }));

const environmentSchema = z
  .object({
    DB_HOST: nonEmpty,
    DB_PORT: positiveInteger.default(5432),
    DB_NAME: nonEmpty,
    DB_USER: nonEmpty,
    DB_PASSWORD: optionalSecret,
    DB_POOL_MAX: positiveInteger.default(10),
    DB_CONNECTION_TIMEOUT_MS: positiveInteger.default(5_000),
    DB_STATEMENT_TIMEOUT_MS: positiveInteger.default(30_000),
    OPENBRAIN_MIGRATIONS_DIR: nonEmpty.default("src/db/migrations"),
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
    LOG_FILE: nonEmpty,
    SERVICE_NAME: nonEmpty.default("open-brain-server"),
    OPEN_BRAIN_WORKER_NAME: nonEmpty.default("worker"),
    OPEN_BRAIN_SERVER_IP: nonEmpty.optional(),
    OPEN_BRAIN_BIND_HOST: nonEmpty.optional(),
    OPEN_BRAIN_SESSION_TTL_SECONDS: positiveInteger.default(30),
    OPEN_BRAIN_MAX_SESSIONS: positiveInteger.default(100),
    OPEN_BRAIN_SESSION_RETRY_AFTER_SECONDS: positiveInteger.default(2),
    OPEN_BRAIN_SESSION_CLOSE_TIMEOUT_MS: positiveInteger.default(5_000),
    OPEN_BRAIN_SESSION_SWEEP_INTERVAL_MS: positiveInteger.default(30_000),
    OPEN_BRAIN_HEALTH_PROBE_TIMEOUT_MS: positiveInteger.default(3_000),
    EMBEDDING_BASE_URL: z.string().url().optional(),
    EMBEDDING_API_KEY: optionalSecret,
    SHARED_NAMESPACE_CANONICAL: z.literal("shared-kb").default("shared-kb"),
    AUTH_TOKEN_ADMIN: optionalSecret,
    AUTH_TOKEN_AGENT: optionalSecret,
    AUTH_TOKEN_DISCORD: optionalSecret,
    AUTH_TOKEN_OB_ADMIN: optionalSecret,
    AUTH_TOKEN_PROMOTER: optionalSecret,
    AUTH_TOKEN_READONLY: optionalSecret,
  })
  .catchall(z.string().optional());

export interface AuthTokenConfig {
  readonly token: string;
  readonly role: Role;
  readonly clientId: string;
}

export interface ServerConfig {
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password?: string;
    readonly maxConnections: number;
    readonly connectionTimeoutMs: number;
    readonly statementTimeoutMs: number;
    readonly migrationsDirectory: string;
  };
  readonly logging: {
    readonly level: (typeof LOG_LEVELS)[number];
    readonly file: string;
    readonly service: string;
    readonly workerName: string;
  };
  readonly authTokens: readonly AuthTokenConfig[];
  readonly transport: {
    /**
     * Host identity for `/health`, resolved from configuration rather than
     * guessed at request time. See `transport/server-identity.ts`: a client
     * asking `/health` is asking WHICH brain it reached, so a wildcard or
     * loopback bind is never the answer.
     */
    readonly hostname: string;
    readonly serverIp: string;
    readonly serverIps: readonly string[];
    /**
     * Short sha of the deployed tree, from the `.deployed-revision` stamp that
     * `scripts/local-clone-deploy.sh` writes. Read once at startup — a running
     * process does not change its own code — and absent on a dev tree that was
     * never deployed through the script.
     */
    readonly deployedRevision?: string;
    readonly sessionTtlMs: number;
    readonly maxSessions: number;
    readonly retryAfterSeconds: number;
    readonly closeTimeoutMs: number;
    readonly sweepIntervalMs: number;
    readonly healthProbeTimeoutMs: number;
    readonly embeddingBaseUrl?: string;
    readonly embeddingApiKey?: string;
  };
  readonly nats: NatsConfig;
  readonly maintenance: MaintenanceConfig;
  readonly sharedNamespace: "shared-kb";
}

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: ServerConfig }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

type Environment = Record<string, string | undefined>;
type ParsedEnvironment = z.infer<typeof environmentSchema>;

const ROLE_TOKEN_KEYS: ReadonlyArray<readonly [keyof ParsedEnvironment, Role]> = [
  ["AUTH_TOKEN_ADMIN", "admin"],
  ["AUTH_TOKEN_AGENT", "agent"],
  ["AUTH_TOKEN_DISCORD", "discord"],
  ["AUTH_TOKEN_OB_ADMIN", "ob-admin"],
  ["AUTH_TOKEN_PROMOTER", "promoter"],
  ["AUTH_TOKEN_READONLY", "readonly"],
];

function roleTokenConfig(parsed: ParsedEnvironment): AuthTokenConfig[] {
  return ROLE_TOKEN_KEYS.flatMap(([key, role]) => {
    const token = parsed[key];
    return typeof token === "string" ? [{ token, role, clientId: role }] : [];
  });
}

function parseUserTokens(environment: Environment): ConfigResult | AuthTokenConfig[] {
  const configured: AuthTokenConfig[] = [];
  const issues: ConfigIssue[] = [];
  for (const [key, value] of Object.entries(environment)) {
    if (!key.startsWith("AUTH_TOKEN_USER_") || value === undefined) continue;
    const parsed = userTokenValue.safeParse(value);
    if (!parsed.success) {
      issues.push({ path: key, message: parsed.error.issues[0]?.message ?? "invalid user token" });
      continue;
    }
    const clientId = key.slice("AUTH_TOKEN_USER_".length).toLowerCase().replaceAll("_", "-");
    configured.push({ ...parsed.data, clientId });
  }
  return issues.length > 0 ? { ok: false, issues } : configured;
}

function buildConfig(
  parsed: ParsedEnvironment,
  userTokens: AuthTokenConfig[],
  deployedRevision?: string,
): ServerConfig {
  const identity = resolveServerIdentity({
    configuredServerIp: parsed.OPEN_BRAIN_SERVER_IP,
    bindHost: parsed.OPEN_BRAIN_BIND_HOST,
  });
  return {
    database: {
      host: parsed.DB_HOST,
      port: parsed.DB_PORT,
      database: parsed.DB_NAME,
      user: parsed.DB_USER,
      ...(parsed.DB_PASSWORD ? { password: parsed.DB_PASSWORD } : {}),
      maxConnections: parsed.DB_POOL_MAX,
      connectionTimeoutMs: parsed.DB_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: parsed.DB_STATEMENT_TIMEOUT_MS,
      migrationsDirectory: parsed.OPENBRAIN_MIGRATIONS_DIR,
    },
    logging: {
      level: parsed.LOG_LEVEL,
      file: parsed.LOG_FILE,
      service: parsed.SERVICE_NAME,
      workerName: parsed.OPEN_BRAIN_WORKER_NAME,
    },
    authTokens: [...roleTokenConfig(parsed), ...userTokens],
    transport: {
      hostname: identity.hostname,
      serverIp: identity.serverIp,
      serverIps: identity.serverIps,
      ...(deployedRevision ? { deployedRevision } : {}),
      sessionTtlMs: parsed.OPEN_BRAIN_SESSION_TTL_SECONDS * 1_000,
      maxSessions: parsed.OPEN_BRAIN_MAX_SESSIONS,
      retryAfterSeconds: parsed.OPEN_BRAIN_SESSION_RETRY_AFTER_SECONDS,
      closeTimeoutMs: parsed.OPEN_BRAIN_SESSION_CLOSE_TIMEOUT_MS,
      sweepIntervalMs: parsed.OPEN_BRAIN_SESSION_SWEEP_INTERVAL_MS,
      healthProbeTimeoutMs: parsed.OPEN_BRAIN_HEALTH_PROBE_TIMEOUT_MS,
      ...(parsed.EMBEDDING_BASE_URL
        ? { embeddingBaseUrl: parsed.EMBEDDING_BASE_URL }
        : {}),
      ...(parsed.EMBEDDING_API_KEY
        ? { embeddingApiKey: parsed.EMBEDDING_API_KEY }
        : {}),
    },
    // The schema's `.catchall` keeps every unlisted key as an optional string,
    // so the NATS variables survive parsing and this reads them from the SAME
    // validated object rather than reaching back into `process.env`. That is
    // the whole point of the config boundary: one env read, at the composition
    // root, and no module behind it touching global state.
    nats: parseNatsConfig(parsed as Record<string, string | undefined>),
    maintenance: parseMaintenanceConfig(
      parsed as Record<string, string | undefined>,
    ),
    sharedNamespace: parsed.SHARED_NAMESPACE_CANONICAL,
  };
}

/**
 * Validate an explicit environment-shaped input without reading global state.
 *
 * `deployedRevision` is passed IN rather than read here: this function is the
 * pure half of the boundary, and touching the filesystem would break that. The
 * composition root below supplies it.
 */
export function parseServerConfig(
  environment: Environment,
  deployedRevision?: string,
): ConfigResult {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }
  const userTokens = parseUserTokens(environment);
  if (!Array.isArray(userTokens)) return userTokens;
  return {
    ok: true,
    config: buildConfig(parsed.data, userTokens, deployedRevision),
  };
}

/**
 * The deploy stamp lives beside the running tree, so it is read relative to
 * this module rather than the process cwd — a service started from anywhere
 * still identifies its own code correctly.
 */
function readDeployStamp(): string | undefined {
  return readDeployedRevision(() => {
    const stamp = new URL("../.deployed-revision", import.meta.url);
    return readFileSync(stamp, "utf8");
  });
}

/** Composition-root environment read. No other `server/` module reads it. */
export function loadServerConfig(): ServerConfig {
  const result = parseServerConfig(process.env, readDeployStamp());
  if (result.ok) return result.config;
  const summary = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  throw new Error(`server_configuration_invalid: ${summary}`);
}
