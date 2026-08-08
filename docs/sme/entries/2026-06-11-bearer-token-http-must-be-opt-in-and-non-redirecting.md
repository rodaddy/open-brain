---
lane: security
order: 3
---
## [2026-06-11] Bearer-token HTTP must be opt-in and non-redirecting

**Severity:** HIGH
**Source:** PR #72 review, PR #76 docs review
**Scope:** `python/openbrain-memory/src/openbrain_memory/client.py`, README
**Status:** active

### Pattern

Bearer-token MCP calls over non-local HTTP or through redirects leak credentials.
PR #72 fixed HTTPS enforcement and redirect disabling. PR #76 hardened docs to
default to HTTPS and require `OPENBRAIN_ALLOW_INSECURE_HTTP=1` for trusted lab
HTTP.

### Review Questions

- Are non-local `http://` URLs rejected unless explicitly allowed?
- Are redirects disabled for auth-bearing requests?
- Do docs avoid making plaintext HTTP the default copy-paste path?
