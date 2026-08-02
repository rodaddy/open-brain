/**
 * Server configuration boundary.
 *
 * Design authority: `docs/code-brain-design.md` R3 (canon outranks runtime
 * observation) and `docs/decisions/shared-kb-canonical-namespace.md` (the
 * public shared namespace is `shared-kb`). Environment input is validated once
 * here and passed inward as typed data.
 */
import { z } from "zod";

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
const optionalSecret = z.string().min(1).optional();
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

function buildConfig(parsed: ParsedEnvironment, userTokens: AuthTokenConfig[]): ServerConfig {
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
    sharedNamespace: parsed.SHARED_NAMESPACE_CANONICAL,
  };
}

/** Validate an explicit environment-shaped input without reading global state. */
export function parseServerConfig(environment: Environment): ConfigResult {
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
  return { ok: true, config: buildConfig(parsed.data, userTokens) };
}

/** Composition-root environment read. No other `server/` module reads it. */
export function loadServerConfig(): ServerConfig {
  const result = parseServerConfig(process.env);
  if (result.ok) return result.config;
  const summary = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  throw new Error(`server_configuration_invalid: ${summary}`);
}
