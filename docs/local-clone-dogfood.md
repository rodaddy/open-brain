# Local Clone Dogfood

This runbook creates and operates a local Open Brain clone from one
encrypted, verified backup set. It is an operator procedure, not replication:
the launcher never creates or drops a database, rotates tokens, reads a
production environment file, contacts a production host, or transfers a
backup.

The clone binds to loopback by default. `OPEN_BRAIN_BIND_HOST=0.0.0.0` is the
one allowed non-loopback value: the LAN opt-in
(`server/config/local-clone-mode.ts:111-120`, Rico, 2026-07-31). The Mini's
dogfood service runs with it so other devices can reach this brain; do not
reset it to loopback. Every other clone-mode guard (database, embeddings) stays
loopback-locked. See
[Reaching this brain from another device](#reaching-this-brain-from-another-device).

The clone is disposable. Refresh it by restoring into another freshly created
database, verifying and launching that database, then stopping and retiring the
old clone. Never restore over or refresh the running clone in place.

## Installed release

- RUNNING as of 2026-09-28, dogfood-v1.0.0-rc.2 (e9ecb8c8) on
  `*:3100` (all interfaces, the `OPEN_BRAIN_BIND_HOST=0.0.0.0` LAN opt-in;
  LAN clients use `10.0.1.20:3100`). `/health` reports `revision` `e9ecb8c8`.
- Deploy a release with:

  ```zsh
  OPENBRAIN_NATS_WORKER_LABEL=com.rico.open-brain-local-nats-worker \
    OPENBRAIN_SERVICE_LABEL=com.rico.open-brain-local-clone \
    scripts/local-clone-deploy.sh <tag>
  ```

- Release tags for this clone use the `dogfood-v<version>` prefix. A pushed
  `v*` tag runs only the `.forgejo/workflows/ci.yml` validation jobs and
  deploys nothing: no workflow in `.forgejo/workflows/` deploys this clone.
  See `docs/GOTCHAS.md`, section "2026-09-27 release traps".
- Server child output goes through the rotating sink; see the log bound in
  section 5.
- The daily V1 window check is `bash scripts/done-means/1593-window-day.sh`.
  It is read-only. A FAIL on any clause means filing a new issue before the
  day is recorded.

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
node scripts/backup-verify.ts \
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

node --env-file-if-exists=.env scripts/restore.ts \
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
# LAN opt-in: 0.0.0.0 is the only non-loopback value clone mode accepts. The Mini's running service uses it on purpose (Rico, 2026-07-31); do not reset it to loopback.
PORT=<unused-loopback-port>

DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=open_brain_local_<clone-id>
DB_USER=open_brain_local_clone
DB_PASSWORD=<local-only-password>
DB_POOL_MAX=10
OPEN_BRAIN_RUN_MIGRATIONS=0

EMBEDDING_BASE_URL=https://llm.example.internal/v1
# The fleet embedder is non-loopback, so clone mode admits it only through
# this allowlist (#757, #759):
OPEN_BRAIN_EMBEDDING_HOST_ALLOW=llm.example.internal
EMBEDDING_API_KEY=<local-only-key-if-required>
EMBEDDING_MODEL=embed-gemma-dense
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
node scripts/local-clone.ts --verify

# Preflight, then launch server/main.ts:
node scripts/local-clone.ts --start
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

Log bound (issues 1526 and 754): under the autostart wrapper
(`scripts/local-clone-autostart.sh`), which sets `OPENBRAIN_LOCAL_CLONE_LOG_DIR`
(default `~/Library/Logs/open-brain-local`), the launcher pipes the server
child's stdout and stderr through the app's rotating file sink into
`autostart.out.log` and `autostart.err.log`: 1 MB per file, 3 rolled files
(`.1` to `.3`), so each stream is bounded at about 4 MB. The wrapper's and the
launcher's own few lines still go to launchd's redirect. A hand-run `--start`
without that variable keeps the child on the terminal.

## 6. Health, socket status, and stop

In another shell, load the same private environment as above. Normalize the
bind host (a literal loopback address, or the `0.0.0.0` LAN opt-in) to a
loopback host for the HTTP URL and the exact macOS `lsof` socket form:

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
  0.0.0.0)
    health_host="127.0.0.1"
    expected_socket="*:${PORT}"
    ;;
  *)
    echo "OPEN_BRAIN_BIND_HOST is not loopback or the 0.0.0.0 LAN opt-in" >&2
    exit 1
    ;;
esac

health_body="$(curl --fail --silent --show-error \
  "http://${health_host}:${PORT}/health")" || exit 1
printf '%s' "${health_body}" | node -e '
  const health = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
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
equal the expected endpoint from the case block above. macOS `lsof` renders an
IPv6 loopback listener as `[::1]:<port>` and the `0.0.0.0` LAN opt-in as
`*:<port>`:

```zsh
actual_sockets="$(
  lsof -nP -a -iTCP:"${PORT}" -sTCP:LISTEN -Fn 2>/dev/null \
    | sed -n 's/^n//p'
)"

if [ "${actual_sockets}" != "${expected_socket}" ]; then
  echo "listener is absent, duplicated, or not the expected endpoint" >&2
  exit 1
fi
```

The wildcard `*:<port>` listener is expected exactly when
`OPEN_BRAIN_BIND_HOST=0.0.0.0`. For a loopback bind this equality check
deliberately rejects `*:<port>`, `0.0.0.0:<port>`, `[::]:<port>`, and every
non-loopback address; for either bind it rejects `[::]:<port>` and multiple
newline-separated listeners. Do not replace it with visual inspection.

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
pgrep -P <launcher-pid> -fl 'server/main.ts'
```

Stop with `Ctrl-C`; the launcher forwards `SIGINT` and waits for `server/main.ts`
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

## Reaching this brain from another device

Server side, on the Mini: set `OPEN_BRAIN_BIND_HOST=0.0.0.0` in
`local-clone.env`, then restart the service:

```zsh
launchctl kickstart -k gui/$(id -u)/com.rico.open-brain-local-clone
```

Check it: `lsof -nP -iTCP:<port> -sTCP:LISTEN` shows `*:<port>`, and from the
other device `curl http://<mini-lan-address>:<port>/health` returns `healthy`.

Client side, in the other device's
`~/.local/share/openbrain-memory/env/openbrain.env`, set both lines or neither:

```dotenv
OPENBRAIN_BASE_URL=http://<mini-lan-address>:<port>
OPENBRAIN_ALLOW_INSECURE_HTTP=1
```

Without the second line the Python client refuses plain `http` to a
non-loopback host (`python/openbrain-memory/src/openbrain_memory/client.py:1806-1816`).
Install the client stack with `scripts/client-bundle.sh` (run on the Mini) and
`scripts/setup-client.sh` (run on the device); `setup-client.sh` already refuses
a loopback URL on a client.

The Mini itself keeps `OPENBRAIN_BASE_URL=http://127.0.0.1:<port>` for its own
hooks (the loopback allowlist). Do not point the Mini's own client at its LAN
address.

Preferred, from any device including off the LAN: the TLS name
`openbrain.example.internal` already routes through the k3s edge to this service, so a
client needs only `OPENBRAIN_BASE_URL=https://openbrain.example.internal` and no
insecure-http flag. The older name `openbrain-old.example.internal` still routes to
a retired host, which runs nothing, and returns 502 until the edge route is repointed
(tracked in rtech-infra issue 1900).
