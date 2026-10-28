/**
 * The template every test database is created from (issue 1667).
 *
 * Unset, the test tooling behaves exactly as before: `createdb -T template0`,
 * `CREATE DATABASE ... TEMPLATE template0`, or no TEMPLATE clause at all,
 * whichever each site already used. Set, OPENBRAIN_TEST_TEMPLATE_DB names a
 * template database that replaces that choice at every test-database creation
 * site. This exists for a shared server where the test role holds CREATEDB but
 * cannot `CREATE EXTENSION vector` (pgvector is not a trusted extension): the
 * operator pre-installs the extensions in the template, and the existing
 * `CREATE EXTENSION IF NOT EXISTS` statements then succeed as no-ops.
 *
 * The value is interpolated into SQL and a command line, so it is validated as
 * a plain lower-case Postgres identifier first and quoted in SQL. An empty
 * value counts as unset, so a CI variable that expands to nothing does not
 * change behaviour.
 *
 * Lives under `scripts/`: `.oxlintrc.json` scopes `node/no-process-env` to
 * `server/**` only.
 */

export const TEST_TEMPLATE_DB_ENV = "OPENBRAIN_TEST_TEMPLATE_DB";

/** Today's template for the createdb paths, kept when the env var is unset. */
const DEFAULT_CREATEDB_TEMPLATE = "template0";

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The configured template name, or `undefined` when unset or empty.
 *
 * @throws Error naming OPENBRAIN_TEST_TEMPLATE_DB when the value is not a valid identifier
 */
export function resolveTestTemplateDb(env: Env = process.env): string | undefined {
  const value = env[TEST_TEMPLATE_DB_ENV];
  if (value === undefined || value === "") return undefined;
  if (!IDENTIFIER.test(value)) {
    throw new Error(
      `${TEST_TEMPLATE_DB_ENV}=${JSON.stringify(value)} is not a valid Postgres identifier (expected ${IDENTIFIER.source}); refusing to create a test database from it`,
    );
  }
  return value;
}

/**
 * Supply the template from parsed `.env` values only when the caller's
 * environment omitted it — the same precedence `propagateClonePassword` uses —
 * so child processes inherit one resolved value.
 */
export function propagateTestTemplateDb(
  env: NodeJS.ProcessEnv,
  fileEnv: Readonly<Record<string, string>>,
): void {
  if (env[TEST_TEMPLATE_DB_ENV] !== undefined) return;
  if (!Object.hasOwn(fileEnv, TEST_TEMPLATE_DB_ENV)) return;
  env[TEST_TEMPLATE_DB_ENV] = fileEnv[TEST_TEMPLATE_DB_ENV];
}

/** The `createdb -T` argument: the configured template, else `template0`. */
export function createdbTemplate(env: Env = process.env): string {
  return resolveTestTemplateDb(env) ?? DEFAULT_CREATEDB_TEMPLATE;
}

/**
 * The TEMPLATE clause for a `CREATE DATABASE` statement.
 *
 * @param unsetClause the site's existing clause (for example `" TEMPLATE template0"`
 *   or `""`), returned unchanged when the env var is unset
 * @returns `unsetClause`, or ` TEMPLATE "<name>"` when a template is configured
 */
export function sqlTemplateClause(unsetClause: string, env: Env = process.env): string {
  const template = resolveTestTemplateDb(env);
  return template === undefined ? unsetClause : ` TEMPLATE "${template}"`;
}
