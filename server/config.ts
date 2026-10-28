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
  MaintenanceConfigError,
  parseMaintenanceConfig,
  type MaintenanceConfig,
} from "./config/maintenance.ts";
import { parseNatsConfig, type NatsConfig } from "./config/nats.ts";
import {
  captureHealthGroup,
  extendedEnvironmentFields,
  ftsGroup,
  httpGroup,
  qmdGroup,
  recoveryGroup,
  searchGroup,
  sharedNamespaceGroup,
  tracingGroup,
  type CaptureHealthGroup,
  type FtsConfigGroup,
  type HttpConfigGroup,
  type QmdConfigGroup,
  type RecoveryConfigGroup,
  type SearchConfigGroup,
  type SharedNamespaceGroup,
  type TracingConfigGroup,
} from "./config/env-groups.ts";
import {
  doctorGroup,
  dropCollectorGroup,
  embeddingGroup,
  loggerIdentityGroup,
  mcpAuditGroup,
  promotionGroup,
  consumerEnvironmentFields,
  type DoctorConfigGroup,
  type DropCollectorBounds,
  type EmbeddingConfigGroup,
  type LoggerIdentityGroup,
  type McpAuditConfigGroup,
  type PromotionConfigGroup,
} from "./config/consumer-env-fields.ts";
import type { SharedNamespaceEnv } from "./security/shared-namespace.ts";
import {
  readDeployedRevision,
  resolveServerIdentity,
} from "./transport/server-identity.ts";

export type { MaintenanceConfig } from "./config/maintenance.ts";
export { parseMaintenanceConfig } from "./config/maintenance.ts";
export type { NatsConfig } from "./config/nats.ts";
export { natsHealthFromConfig, parseNatsConfig } from "./config/nats.ts";
export type {
  CaptureHealthGroup,
  FtsConfigGroup,
  HttpConfigGroup,
  QmdConfigGroup,
  RecoveryConfigGroup,
  SearchConfigGroup,
  SharedNamespaceGroup,
  TracingConfigGroup,
} from "./config/env-groups.ts";
export type {
  DoctorConfigGroup,
  EmbeddingConfigGroup,
  EmbeddingWatchdogGroup,
  McpAuditConfigGroup,
  PromotionConfigGroup,
} from "./config/consumer-env-fields.ts";

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
 * An optional secret: absent, or a value with content. **Present-but-BLANK
 * counts as absent**, where blank means empty OR whitespace-only.
 *
 * The `z.preprocess` is the whole point and is not decoration. Without it,
 * `z.string().min(1).optional()` accepts an unset variable but REJECTS
 * `FOO=`, and those are the same thing to every consumer of these fields:
 * auth skips a role token with `if (!token)`, the pool hands `DB_PASSWORD`
 * straight to pg, and the embedding provider's `embeddingApiKey()` returns the
 * raw value. An empty string behaves as unset in all three.
 *
 * Shell environments produce empty rather than absent as a matter of course, so
 * this is the normal case and not a malformed one. The local dogfood clone env
 * sets `EMBEDDING_API_KEY=` because the local MLX embedding server needs no
 * key; on 2026-08-02 that alone made the rewritten entrypoint throw
 * `server_configuration_invalid` at startup and launchd throttle-looped it,
 * while the previous entrypoint had always started fine on the same environment.
 *
 * WHY WHITESPACE IS ALSO ABSENT (#548). `EMBEDDING_API_KEY=" "` used to survive
 * this schema and arrive downstream as a real value, because `min(1)` counts a
 * space as a character. `server/transport/health.ts` then takes the truthy
 * branch and sends `Authorization: Bearer  ` — a header whose value is one
 * space — on every embedding probe. The launcher that starts this same process
 * already disagreed: `scripts/local-clone.ts` reads
 * `env.EMBEDDING_API_KEY?.trim()` before its own truthiness check, so preflight
 * saw "no key" and sent no header while the server saw "key" and sent a blank
 * one. Two components deciding the same question differently off one variable
 * is the defect; this makes the config boundary agree with the launcher rather
 * than adding a third opinion downstream. A key is normalized for the DECISION
 * only — a value with content is passed through byte-for-byte, because altering
 * a real secret would silently corrupt a credential whose padding is genuine.
 *
 * Normalizing HERE, at the parse boundary, rather than at each of the eight
 * declaration sites, is what makes the rule hold for a field added later:
 * everything typed `optionalSecret` gets it. Required fields keep rejecting
 * empty — see `nonEmpty` — because there an empty value is a real misconfiguration
 * rather than an omission.
 */
const optionalSecret = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
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
    OPENBRAIN_MIGRATIONS_DIR: nonEmpty.default("server/db/migrations"),
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
    // Every remaining variable any non-test `server/` module reads, typed here
    // so a consumer can be handed a value instead of reaching for
    // `process.env`. Declarations and the reasoning behind each parser live in
    // `./config/env-groups.ts`; the readers themselves are rewired by L2b/L2c.
    ...extendedEnvironmentFields,
    // The keys the remaining non-`server/` modules read. Declared so an L5
    // move lane can hand the module a value instead of leaving it reaching for
    // `process.env` behind the door. See `./config/consumer-env-fields.ts`.
    ...consumerEnvironmentFields,
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
     * the deployment scripts write. Read once at startup — a running process
     * does not change its own code — and absent on a dev tree that was never
     * deployed through one of those scripts.
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
  readonly search: SearchConfigGroup;
  readonly fts: FtsConfigGroup;
  readonly qmd: QmdConfigGroup;
  readonly recovery: RecoveryConfigGroup;
  /**
   * Physical and legacy shared-namespace names. The CANONICAL name is
   * `sharedNamespace` above and stays there — these are the migration
   * coordinates that may point away from it.
   */
  readonly sharedNamespaceNames: SharedNamespaceGroup;
  readonly tracing: TracingConfigGroup;
  readonly captureHealth: CaptureHealthGroup;
  readonly http: HttpConfigGroup;
  readonly embedding: EmbeddingConfigGroup;
  readonly promotion: PromotionConfigGroup;
  readonly mcpAudit: McpAuditConfigGroup;
  readonly doctor: DoctorConfigGroup;
  /** Scan bounds for the drop-folder collector — `server/capture/`. */
  readonly dropCollector: DropCollectorBounds;
  /**
   * The `HOSTNAME`/`HOST` identity the legacy logger stamps.
   * Absent here does NOT mean unidentified: `server/main.ts` falls back to the
   * transport identity, which is the `/health` name.
   */
  readonly loggerIdentity: LoggerIdentityGroup;
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
      issues.push({
        path: key,
        message: parsed.error.issues[0]?.message ?? "invalid user token",
      });
      continue;
    }
    const clientId = key
      .slice("AUTH_TOKEN_USER_".length)
      .toLowerCase()
      .replaceAll("_", "-");
    configured.push({ ...parsed.data, clientId });
  }
  return issues.length > 0 ? { ok: false, issues } : configured;
}

/**
 * `environment` is the RAW input alongside the parsed one, not a duplicate of
 * it: `SHARED_NAMESPACE_CANONICAL` is declared as a literal with a default
 * (`:167`), so `parsed` can never say "the operator did not set this" — and the
 * reader `sharedNamespaceConfig` (`server/tools/shared-namespace.ts:79-82`)
 * decides precedence on exactly that distinction.
 */
function buildConfig(
  parsed: ParsedEnvironment,
  environment: Environment,
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
    maintenance: parseMaintenanceConfig(parsed as Record<string, string | undefined>),
    sharedNamespace: parsed.SHARED_NAMESPACE_CANONICAL,
    search: searchGroup(parsed),
    fts: ftsGroup(parsed),
    qmd: qmdGroup(parsed),
    recovery: recoveryGroup(parsed),
    sharedNamespaceNames: sharedNamespaceGroup(
      parsed,
      environment.SHARED_NAMESPACE_CANONICAL,
    ),
    tracing: tracingGroup(parsed),
    captureHealth: captureHealthGroup(parsed),
    http: {
      ...httpGroup(parsed),
      bindHost: parsed.OPEN_BRAIN_BIND_HOST,
    },
    embedding: embeddingGroup(parsed),
    promotion: promotionGroup(parsed),
    mcpAudit: mcpAuditGroup(parsed),
    doctor: doctorGroup(parsed),
    dropCollector: dropCollectorGroup(parsed),
    loggerIdentity: loggerIdentityGroup(parsed),
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
  try {
    return {
      ok: true,
      config: buildConfig(parsed.data, environment, userTokens, deployedRevision),
    };
  } catch (error: unknown) {
    if (error instanceof MaintenanceConfigError) {
      return { ok: false, issues: [{ path: error.path, message: error.message }] };
    }
    throw error;
  }
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

/**
 * The raw shared-namespace values, owned by this module (operator ruling
 * 2026-08-30: the env reads the retired adapters were doing belong in
 * `server/config.ts`, "much like we use config.py in Python applications").
 *
 * These are the RAW strings rather than a resolved name set, because
 * `server/security/shared-namespace.ts` owns the resolution and the precedence
 * between `SHARED_NAMESPACE_*` and `OPENBRAIN_*` is a security-relevant detail
 * that must keep exactly one implementation. Handing that module the same eight
 * strings the retired adapter handed it makes the relocation byte-identical:
 * the parsing moves house, the derivation does not move at all.
 *
 * Read per call, not memoized, because the adapter this replaces read
 * `process.env` per call and the existing tests set these variables per case.
 */
export function sharedNamespaceEnvironment(): SharedNamespaceEnv {
  return {
    sharedNamespaceCanonical: process.env["SHARED_NAMESPACE_CANONICAL"],
    sharedNamespacePhysical: process.env["SHARED_NAMESPACE_PHYSICAL"],
    openbrainSharedNamespace: process.env["OPENBRAIN_SHARED_NAMESPACE"],
    sharedNamespaceLegacy: process.env["SHARED_NAMESPACE_LEGACY"],
    openbrainLegacySharedNamespace: process.env["OPENBRAIN_LEGACY_SHARED_NAMESPACE"],
    legacySharedFallback: process.env["OPENBRAIN_LEGACY_SHARED_FALLBACK"],
    sharedFallbackMinResults: process.env["OPENBRAIN_SHARED_FALLBACK_MIN_RESULTS"],
    allowLegacySharedWrites: process.env["OPENBRAIN_ALLOW_LEGACY_SHARED_WRITES"],
  };
}

/**
 * The promotion kill switch, read at call time — `=== "1"` exactly, as the
 * retired promotion-service adapter read it before the L5 move (issue 864).
 */
export function promotionKillSwitch(): boolean {
  return process.env["OPENBRAIN_PROMOTION_KILL_SWITCH"] === "1";
}

/**
 * The container role selector, read by server/entry.ts before either process
 * is loaded (issue 1594). Raw on purpose: entry.ts owns the allowed set and
 * refuses anything outside it, so nothing here defaults or coerces.
 */
export function openBrainRoleEnvironment(): { OPEN_BRAIN_ROLE: string | undefined } {
  return { OPEN_BRAIN_ROLE: process.env["OPEN_BRAIN_ROLE"] };
}

/**
 * The MCP audit environment, handed to `readMcpAuditConfig` unchanged.
 *
 * The audit reader owns its own bounds and defaults; this only supplies the
 * variables, so the retired adapter's `env = process.env` default becomes an
 * explicit read owned by the config module.
 */
export function mcpAuditEnvironment(): Record<string, string | undefined> {
  return process.env;
}

/**
 * The doctor's ambient coordinates, in the shape
 * `server/application/operator-doctor.ts` takes them as options.
 *
 * Reproduces the retired operator-doctor adapter's `ambientOptions()` value for
 * value, including the three-way `NODE_ENV` narrowing, the `!== undefined`
 * (not truthiness) tests on the two QMD paths, and the `qmdIndexPathSource`
 * marker that distinguishes an env-sourced index path from a caller-supplied
 * one. Read per call, because the doctor's tests flip these variables per case.
 *
 * `rawTurnTtlSeconds` is NOT recomputed here: the same derivation already lives
 * in `./config/consumer-env-fields.ts` and is applied by `doctorGroup`, so the caller
 * threads that one in rather than this module growing a second opinion.
 */
export function doctorAmbientEnvironment(): {
  serviceVersionFallback: string;
  nodeEnvironment: "production" | "development" | "test" | "unknown";
  fileLogConfigured: boolean;
  rotationConfigured: boolean;
  qmdPath?: string;
  qmdIndexPath?: string;
  qmdIndexPathSource?: "env";
} {
  const nodeEnv = process.env["NODE_ENV"];
  const qmdPath = process.env["QMD_PATH"];
  const qmdIndexPath = process.env["QMD_INDEX_PATH"];
  return {
    serviceVersionFallback: process.env["npm_package_version"] ?? "unknown",
    nodeEnvironment:
      nodeEnv === "production" || nodeEnv === "development" || nodeEnv === "test"
        ? nodeEnv
        : "unknown",
    fileLogConfigured: Boolean(process.env["LOG_FILE"]?.trim()),
    rotationConfigured:
      Boolean(process.env["LOG_MAX_BYTES"]) || Boolean(process.env["LOG_MAX_FILES"]),
    ...(qmdPath !== undefined ? { qmdPath } : {}),
    ...(qmdIndexPath !== undefined
      ? { qmdIndexPath, qmdIndexPathSource: "env" as const }
      : {}),
  };
}

/**
 * The raw-turn retention seconds the distillation-lag alarm divides by.
 *
 * `Number(...)` rather than `parseInt`, so a trailing suffix is `NaN` and falls
 * back and only a positive integer wins — the same test
 * `readDistillationLagTtlSeconds` applied in the retired adapter.
 */
export function rawTurnTtlSecondsFromEnvironment(): number {
  const configured = Number(process.env["OPENBRAIN_RAW_TURN_TTL_SECONDS"]);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_RAW_TURN_TTL_SECONDS;
}

/** The documented one-week raw-turn retention window. */
const DEFAULT_RAW_TURN_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Composition-root environment read. No other `server/` module reads it. */
export function loadServerConfig(): ServerConfig {
  const result = parseServerConfig(process.env, readDeployStamp());
  if (result.ok) return result.config;
  const summary = result.issues
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ");
  throw new Error(`server_configuration_invalid: ${summary}`);
}
