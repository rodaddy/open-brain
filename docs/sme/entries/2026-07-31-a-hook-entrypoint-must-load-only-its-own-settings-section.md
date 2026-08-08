---
lane: domain-backend
order: 22
---
## [2026-07-31] A hook entrypoint must load only its own settings section

**Severity:** HIGH
**Source:** Step-8 review swarm (Sol terminal audit), fixed in `967a3be`
**Scope:** `python/openbrain/src/openbrain/config.py`,
`python/openbrain/src/openbrain/apps/hooks/`
**Status:** active

### Pattern

The Stop entrypoint called the full `load_settings()`, which constructs
required Database/Embedding sections. A hook environment sets only the two
capture vars, so every invocation failed validation on config it never uses --
and the entrypoint's swallow turned that into SILENT zero capture on every
turn. A swallow-everything contract makes config coupling invisible; the
loader an entrypoint uses must resolve only the section it needs
(`load_capture_settings`), with a functional test running the real loading
path on the minimal environment.

### Review Questions

- Does any entrypoint (which swallows failures by contract) load settings
  sections it does not use?
- Is there a test that loads settings with ONLY that entrypoint's documented
  env vars set, everything else scrubbed?
