---
lane: domain-backend
order: 16
---
## [2026-07-08] Launchd updates must reload desired state, not only kickstart

**Severity:** MEDIUM
**Source:** PR #283 initial swarm for Issue #282
**Scope:** launchd service templates and deployment_host deploy/runbook instructions
**Status:** fixed in PR #283

### Pattern

Copying an updated plist and running `launchctl kickstart -k` can restart the
currently loaded job definition without reloading changed `ProgramArguments`,
environment, log paths, or resource limits. A deploy can look restarted while
live launchd state still differs from the repo template.

### Review Questions

- For plist changes, does the update path boot out and bootstrap the service
  before kickstart?
- Does verification print the loaded job after bootstrap so desired state can be
  compared to live state?
- Does the launch command fail fast when its env file is missing or unreadable?
- Does the runbook validate the env file before installing/restarting the
  service, especially when the worker env sources a shared production env?
