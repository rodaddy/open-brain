# Scheduled qmd sync

`com.rico.qmd-sync` refreshes the machine's existing qmd indexes every day at
04:00 local time. It is independent of agent sessions and runs all indexes
sequentially because embedding is GPU-bound.

The job updates:

- every project-local `.qmd/index.yml` owned by the Development root or an
  immediate child Git repository under `/Volumes/ThunderBolt/Development`;
- the separate `global_docs_instructions` named index.

It does not create or regenerate index configurations. Adding, removing, or
triaging collections is separate work.

## Installed artifacts

The repository owns the source and installer. The installer copies the sync
script to a stable machine-owned runtime and renders the LaunchAgent template:

```text
/Volumes/ThunderBolt/open-brain-local/qmd-sync/qmd-sync.sh
~/Library/LaunchAgents/com.rico.qmd-sync.plist
```

This keeps the scheduled job independent of a development checkout or temporary
worktree. Re-run the installer after changing `scripts/qmd-sync.sh` or the plist
template; it replaces the installed script, boots out an existing registration,
and bootstraps the rendered plist again.

The sync script writes its durable primary log to:

```text
/Volumes/ThunderBolt/open-brain-local/log/qmd-sync.log
```

launchd also reserves these boot-volume files for startup errors that occur
before the script opens its primary log, including when the ThunderBolt volume
is unavailable:

```text
~/Library/Logs/open-brain-local/qmd-sync.out.log
~/Library/Logs/open-brain-local/qmd-sync.err.log
```

## Watchdog behavior

Every qmd subprocess runs through a watchdog backed by GNU `timeout`, which is
provided by Homebrew coreutils on this Mac. The sync wrapper disables qmd's own
nested timeout for these calls so one process group contains the command and its
children.

Defaults:

- `qmd embed`: 1,800 seconds;
- complete nightly run: 21,600 seconds;
- TERM-to-KILL grace: 20 seconds.

The complete-run watchdog is enforced by passing the remaining run time to each
`qmd update`, `qmd embed`, and `qmd status` command. The embed command receives
the shorter of its own watchdog or the remaining run time. When a watchdog
fires, the wrapper sends a final KILL to the command's process group after GNU
`timeout` returns. This removes children that ignored TERM or outlived an early-
exiting parent instead of leaving an orphaned CPU-bound process.

A watchdog failure exits non-zero and writes a line such as:

```text
index=open-brain status=failed step=embed reason=watchdog scope=embed watchdog_seconds=1800 exit_code=124
```

The settings can be changed for a controlled run with
`QMD_EMBED_WATCHDOG_SECONDS`, `QMD_RUN_WATCHDOG_SECONDS`, and
`QMD_WATCHDOG_KILL_AFTER_SECONDS`. All three values must be positive whole
seconds. A missing GNU timeout executable is a visible failure; the scheduled
job never silently runs without its watchdog. The LaunchAgent places
`/opt/homebrew/bin` before `~/.local/bin` so qmd selects the Homebrew Node
runtime that matches its installed `better-sqlite3` native module rather than an
older user-local Node symlink.

## Install and load

Run the installer as the logged-in macOS user, not as root:

```bash
cd /Volumes/ThunderBolt/Development/open-brain
scripts/install-qmd-sync-launchagent.sh
```

The installer:

1. copies the executable sync script into the stable runtime;
2. renders and lints `com.rico.qmd-sync.plist`;
3. boots out an already registered copy when present;
4. bootstraps the rendered plist into `gui/$(id -u)`;
5. prints the registered job.

The template deliberately omits `RunAtLoad`, so installation registers the
04:00 schedule without immediately starting a full sync.

## Force and observe a run

Capture the index timestamp before the run:

```bash
/usr/bin/stat -f '%m %Sm' \
  /Volumes/ThunderBolt/Development/open-brain/.qmd/index.sqlite
```

Force the registered job to run:

```bash
launchctl kickstart -k "gui/$(id -u)/com.rico.qmd-sync"
```

Observe state and the durable log:

```bash
launchctl print "gui/$(id -u)/com.rico.qmd-sync"
tail -n 200 /Volumes/ThunderBolt/open-brain-local/log/qmd-sync.log
```

A successful primary-log line for each index includes an absolute last-run
start time, total files indexed, new and updated files from `qmd update`, chunks
embedded during this run, and total vectors after embedding:

```text
index=open-brain status=completed last_run=... files_indexed=... files_new=... files_updated=... vectors_embedded=... vectors_total=...
```

The final run line reports `status=completed`, the number of indexes attempted,
and zero failures. After it appears, verify the index timestamp advanced and
check qmd's own status from the repository:

```bash
/usr/bin/stat -f '%m %Sm' \
  /Volumes/ThunderBolt/Development/open-brain/.qmd/index.sqlite
cd /Volumes/ThunderBolt/Development/open-brain
qmd status
```

The operator doctor also reports qmd freshness for its configured index through
the privileged doctor surface. The repository-local `qmd status` and SQLite
mtime remain the direct receipt for this repo's scheduled refresh.

## Diagnose a failure

Read the primary log first:

```bash
tail -n 200 /Volumes/ThunderBolt/open-brain-local/log/qmd-sync.log
```

Search for `status=failed`. The line names the index, failed step (`update`,
`embed`, `status`, or metric parsing), and command exit code when available. A
watchdog line also names its scope and elapsed setting. The script continues to
the remaining indexes after an index-local failure, but stops scheduling new
indexes when the complete-run watchdog expires. Either path exits non-zero so
launchd retains a visible failed exit status.

For a project-local failure, inspect that repository directly:

```bash
cd /Volumes/ThunderBolt/Development/<repo>
qmd status
qmd update
qmd embed
```

For the shared index:

```bash
qmd status --index global_docs_instructions
qmd update --index global_docs_instructions
qmd embed --index global_docs_instructions
```

If launchd could not start the script at all, read its boot-volume fallback
logs, then verify that the installed script exists and is executable:

```bash
tail -n 200 "$HOME/Library/Logs/open-brain-local/qmd-sync.out.log"
tail -n 200 "$HOME/Library/Logs/open-brain-local/qmd-sync.err.log"
ls -l /Volumes/ThunderBolt/open-brain-local/qmd-sync/qmd-sync.sh
```

## Uninstall

Boot out the job, then remove the two installed files with Finder or another
approved file-removal workflow:

```bash
launchctl bootout "gui/$(id -u)/com.rico.qmd-sync"
```

The files are:

```text
~/Library/LaunchAgents/com.rico.qmd-sync.plist
/Volumes/ThunderBolt/open-brain-local/qmd-sync/qmd-sync.sh
```

The durable log is intentionally retained for diagnosis.

## Test the parsers and watchdog

Run the sourceable parser functions and the functional hung-process test:

```bash
BUN_TMPDIR=/Volumes/ThunderBolt/_tmp/open-brain/_scratch/bun-tmp \
  /opt/homebrew/bin/bash scripts/qmd-sync.test.sh
```

The functional test starts a fake embed command with a TERM-ignoring child,
asserts the watchdog returns within the expected wall-clock, verifies the child
process is gone, and checks the failure line written to the captured log.
