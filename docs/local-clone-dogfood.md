# Local Clone Dogfood

This runbook creates and operates a loopback-only Open Brain clone from one
encrypted, verified backup set. It is an operator procedure, not replication:
the launcher never creates or drops a database, rotates tokens, reads a
production environment file, contacts a production host, or transfers a
backup.

The clone is disposable. Refresh it by restoring into another freshly created
database, verifying and launching that database, then stopping and retiring the
old clone. Never restore over or refresh the running clone in place.

## 1. Stage one encrypted backup set

Create the backup only when no migration or schema upgrade is running. Normal
application writes may continue: `backup.ts` holds one exported PostgreSQL
snapshot for both manifest facts and `pg_dump`. A set is coordinated only when
`openbrain.dump` and `manifest.json` came from the same successful run. Do not
mix files from different sets.

Transfer is an operator-owned step outside the launcher. On a trusted source
host, encrypt the complete set before it leaves that host:

```zsh
tar -C <backups-root> -cf - <set-dir> \
  | age -r <local-clone-recipient> > <set-dir>.tar.age
```

Move the encrypted artifact through an approved transfer channel. Do not give
the local-clone launcher network access to the source host. On the clone host,
decrypt it into a private directory beneath the configured clone root:

```zsh
umask 077
mkdir -p <clone-root>/backups
age -d <set-dir>.tar.age \
  | tar -C <clone-root>/backups -xf -
chmod -R go-rwx <clone-root>
```

Keep the encrypted artifact until the clone has passed verification. Do not
print encryption identities, database passwords, API keys, or bearer tokens in
the shell transcript.

## 2. Create a fresh local role and database

Use a local PostgreSQL 18 administrative role. Both commands prompt without
putting a password in argv:

```zsh
createuser -h 127.0.0.1 -p 5432 -U <local-admin-role> \
  --pwprompt --no-superuser --no-createdb --no-createrole \
  open_brain_local_clone

createdb -h 127.0.0.1 -p 5432 -U <local-admin-role> \
  --owner open_brain_local_clone open_brain_local_<clone-id>

# The database is fresh: bootstrap both source-required extensions once as the
# local administrator. Do not use IF NOT EXISTS; an existing extension means
# this was not a fresh target.
psql -h 127.0.0.1 -p 5432 -U <local-admin-role> \
  -d open_brain_local_<clone-id> -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION vector;' \
  -c 'CREATE EXTENSION pg_stat_statements;'
```

The role and database must be new. Do not point the procedure at a production
role, an existing application database, or a non-loopback PostgreSQL server.
The administrative `vector` and `pg_stat_statements` bootstrap is intentionally
limited to the new target database; these are the extensions created by the
repository migrations and therefore present in the source archive. The restore
still runs as `open_brain_local_clone`, which is a non-superuser with no database
or role creation privileges. The restore omits archive comments so it does not
need ownership of these administrator-created extensions.
The restore CLI refuses a non-empty target unless its separate destructive wipe
approval is supplied; this runbook does not use that escape hatch.

## 3. Verify the set, then restore it

From the exact repo revision that will run the clone, verify the backup before
any restore:

```zsh
bun run scripts/backup-verify.ts \
  --dir <clone-root>/backups/<set-dir>
```

The command emits one content-free
`openbrain.backup_verify_receipt.v1` line. Continue only when it exits `0` and
the receipt status is `passed` or `warned`. Do not use
`--allow-embedding-mismatch` for dogfood: the restored vectors must match the
runtime model and dimension.

Set the target password privately, then restore into the fresh database. Keep
the password out of the URL and shell history:

```zsh
read -s "DB_PASSWORD?Local clone database password: "
export DB_PASSWORD

bun run scripts/restore.ts \
  --dir <clone-root>/backups/<set-dir> \
  --target-db-url \
  postgres://open_brain_local_clone@127.0.0.1:5432/open_brain_local_<clone-id>

unset DB_PASSWORD
```

`restore.ts` reruns the full verification pass before touching the target,
restores through the existing `pg_restore` boundary, validates row and archive
counts, namespace predicates, migrations, pgvector, `halfvec(768)`, and
writability, and emits a content-free receipt. Do not launch unless it exits
`0`.

## 4. Create the private clone environment

Create `<clone-root>/local-clone.env` with `umask 077`, then enforce mode
`0600`:

```zsh
umask 077
touch <clone-root>/local-clone.env
chmod 600 <clone-root>/local-clone.env
```

Populate it locally without echoing values. The explicit local-clone boundary
requires at least:

```dotenv
OPENBRAIN_LOCAL_CLONE=1
OPENBRAIN_LOCAL_CLONE_ROOT=<absolute-clone-root>
OPEN_BRAIN_BIND_HOST=127.0.0.1
PORT=<unused-loopback-port>

DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=open_brain_local_<clone-id>
DB_USER=open_brain_local_clone
DB_PASSWORD=<local-only-password>
DB_POOL_MAX=10
OPEN_BRAIN_RUN_MIGRATIONS=0

EMBEDDING_BASE_URL=http://127.0.0.1:<local-embedding-port>/v1
EMBEDDING_API_KEY=<local-only-key-if-required>
EMBEDDING_MODEL=embeddinggemma-300m-8bit
EMBEDDING_DIMENSIONS=768
EMBEDDING_WATCHDOG_RESTART_SCRIPT=

QMD_PATH=
OPENBRAIN_TRANSPORT=
ALLOWED_ORIGINS=

AUTH_TOKEN_ADMIN=<unique-local-token>
AUTH_TOKEN_AGENT=<unique-local-token>
AUTH_TOKEN_DISCORD=<unique-local-token>
AUTH_TOKEN_OB_ADMIN=<unique-local-token>
AUTH_TOKEN_PROMOTER=<unique-local-token>
AUTH_TOKEN_READONLY=<unique-local-token>
```

All six tokens must be non-empty and mutually unique. Any
`AUTH_TOKEN_USER_*` value must also carry a non-empty token unique across the
complete set. Generate local-only values into the file; never copy or rotate
production tokens. Leave every `OPENBRAIN_NATS_*` variable unset. If configured,
`OPENBRAIN_RECOVERY_WAL_PATH` and `LOG_FILE` must be absolute paths strictly
beneath `OPENBRAIN_LOCAL_CLONE_ROOT`.

Before each launch, confirm the file remains private:

```zsh
test "$(stat -f '%Lp' <clone-root>/local-clone.env)" = 600
```

## 5. Verify and launch

Run the launcher from a shell that explicitly loads only the private clone
environment:

```zsh
set -a
source <clone-root>/local-clone.env
set +a

# Read-only preflight only:
bun run scripts/local-clone.ts --verify

# Preflight, then launch src/index.ts:
bun run scripts/local-clone.ts --start
```

The read-only preflight must succeed before the server child starts. Its single
content-free JSON line has schema
`openbrain.local_clone_verify_receipt.v1`, operation `local_clone_verify`, and
status `verified`. It proves:

- `current_database`, `current_user`, `inet_server_addr`, and
  `inet_server_port` match the explicit clone environment;
- PostgreSQL major version is 18;
- pgvector is available and installed in the target;
- the configured embedding provider is healthy and returns the configured
  model/dimension.

The launcher passes the child only its allowlisted clone environment and
forwards `SIGINT` and `SIGTERM`. It does not load an env file itself.

## 6. Health, socket status, and stop

In another shell, load the same private environment as above. Normalize the
literal loopback host for an HTTP URL and the exact macOS `lsof` socket form:

```zsh
case "${OPEN_BRAIN_BIND_HOST}" in
  127.0.0.1)
    health_host="127.0.0.1"
    expected_socket="127.0.0.1:${PORT}"
    ;;
  ::1)
    health_host="[::1]"
    expected_socket="[::1]:${PORT}"
    ;;
  *)
    echo "OPEN_BRAIN_BIND_HOST is not a literal loopback address" >&2
    exit 1
    ;;
esac

health_body="$(curl --fail --silent --show-error \
  "http://${health_host}:${PORT}/health")" || exit 1
printf '%s' "${health_body}" | bun -e '
  const health = JSON.parse(await Bun.stdin.text());
  if (
    health.database?.connected !== true ||
    health.embedding?.configured !== true ||
    health.embedding?.connected !== true
  ) {
    console.error("health body does not prove database and embedding readiness");
    process.exit(1);
  }
'
```

HTTP success alone is insufficient: `/health` can return `200` while an
embedding provider is disconnected. Continue only when all three structured
fields above are `true`.

Prove the application has exactly one listener and that its address and port
equal the configured literal loopback endpoint. macOS `lsof` renders an IPv6
loopback listener as `[::1]:<port>`:

```zsh
actual_sockets="$(
  lsof -nP -a -iTCP:"${PORT}" -sTCP:LISTEN -Fn 2>/dev/null \
    | sed -n 's/^n//p'
)"

if [ "${actual_sockets}" != "${expected_socket}" ]; then
  echo "listener is absent, duplicated, wildcard, or non-loopback" >&2
  exit 1
fi
```

This equality check deliberately rejects `*:<port>`, `0.0.0.0:<port>`,
`[::]:<port>`, every non-loopback address, and multiple newline-separated
listeners. Do not replace it with visual inspection.

Prove PostgreSQL resolved to the intended local socket from the clone
credentials:

```zsh
PGPASSWORD="${DB_PASSWORD}" psql \
  -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" \
  -XAtc \
  "select current_database(), current_user, inet_server_addr(), inet_server_port();"
```

Expected fields are the configured clone database,
`open_brain_local_clone`, a literal loopback address, and the configured
PostgreSQL port. Do not use `pg_isready` alone: it does not prove the database,
role, or resolved server address.

For foreground operation, status is the structured `/health` proof above plus
the exact listener check above. When another supervisor records the foreground
launcher PID, prove both launcher and child are present:

```zsh
ps -p <launcher-pid> -o pid=,ppid=,command=
pgrep -P <launcher-pid> -fl 'src/index.ts'
```

Stop with `Ctrl-C`; the launcher forwards `SIGINT` and waits for `src/index.ts`
to shut down. For a managed foreground process, send `SIGTERM` to the launcher
PID and wait for it to exit:

```zsh
kill -TERM <launcher-pid>
```

After stop, `ps -p <launcher-pid>` must fail and
`pgrep -P <launcher-pid>` must return no child. Prove the application port has
no remaining listener:

```zsh
if lsof -nP -a -iTCP:"${PORT}" -sTCP:LISTEN -Fn 2>/dev/null \
  | sed -n 's/^n//p' | grep -q .; then
  echo "application listener remains after stop" >&2
  exit 1
fi
```

The health request must also fail. Do not kill PostgreSQL or the embedding
provider as part of stopping the clone.

## Refresh and cleanup

Never refresh in place. Stage and verify a new coordinated backup set, create a
new `open_brain_local_<clone-id>` database, restore and preflight it, launch it
on a different loopback port, and verify health/socket identity. Only then stop
the old launcher. Database retirement is an explicit operator action outside
the launcher; re-check the exact local target before dropping it.
