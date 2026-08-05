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

## Deployment boundary

The repository ships a script and a launchd template only. It does **not**
install, load, bootstrap, or run the job automatically. An operator performs
installation after the deployed app at `/Volumes/ThunderBolt/open-brain/app`
contains `scripts/qmd-sync.sh`.

The sync script writes its durable primary log to:

```text
/Volumes/ThunderBolt/open-brain/logs/qmd-sync.log
```

launchd also reserves these files for startup errors that occur before the
script opens its primary log:

```text
/Volumes/ThunderBolt/open-brain/logs/qmd-sync.launchd.out.log
/Volumes/ThunderBolt/open-brain/logs/qmd-sync.launchd.err.log
```

## Install and load

Run these commands as the logged-in macOS user, not as root:

```bash
mkdir -p /Volumes/ThunderBolt/open-brain/logs
cp /Volumes/ThunderBolt/open-brain/app/docs/deploy/com.rico.qmd-sync.plist.template \
  "$HOME/Library/LaunchAgents/com.rico.qmd-sync.plist"
plutil -lint "$HOME/Library/LaunchAgents/com.rico.qmd-sync.plist"
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.rico.qmd-sync.plist"
launchctl print "gui/$(id -u)/com.rico.qmd-sync"
```

The template deliberately omits `RunAtLoad`, so loading it registers the 04:00
schedule without immediately starting a full sync. To replace an already loaded
copy, boot it out first, copy the updated template, and bootstrap it again:

```bash
launchctl bootout "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.rico.qmd-sync.plist"
```

## Verify the next scheduled run

After the next 04:00 local run:

1. Confirm launchd still has the job and inspect its last exit status:

   ```bash
   launchctl print "gui/$(id -u)/com.rico.qmd-sync"
   ```

2. In at least one active Development repository, confirm `Updated` is within
   24 hours:

   ```bash
   cd /Volumes/ThunderBolt/Development/open-brain
   qmd status
   ```

3. Confirm the shared index is also within 24 hours:

   ```bash
   qmd status --index global_docs_instructions
   ```

4. Search for an exact symbol added during the previous day. Run this from the
   repository that owns the symbol and confirm its file is returned:

   ```bash
   qmd search "ExactSymbolAddedYesterday" --format files
   ```

A successful primary-log line for each index includes an absolute last-run
start time, total files indexed, new and updated files from `qmd update`, chunks
embedded during this run, and total vectors after embedding:

```text
index=open-brain status=completed last_run=... files_indexed=... files_new=... files_updated=... vectors_embedded=... vectors_total=...
```

The final run line reports `status=completed`, the number of indexes attempted,
and zero failures.

## Diagnose a failure

Read the primary log first:

```bash
tail -n 200 /Volumes/ThunderBolt/open-brain/logs/qmd-sync.log
```

Search for `status=failed`. The line names the index, failed step (`update`,
`embed`, `status`, or metric parsing), and command exit code when available. The
script continues to the remaining indexes, then exits non-zero if any index
failed, so launchd retains a visible failed exit status.

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

If launchd could not start the script at all, read the two
`qmd-sync.launchd.*.log` files and verify that the deployed script exists and is
executable:

```bash
ls -l /Volumes/ThunderBolt/open-brain/app/scripts/qmd-sync.sh
```
