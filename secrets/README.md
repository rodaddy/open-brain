# `secrets/` — file-based config layers

**Structure is tracked. Values are not.**

```bash
cp secrets/config.example.json secrets/config.json
$EDITOR secrets/config.json
```

`config.example.json` carries every key with a placeholder value, so a fresh
clone shows exactly what is configurable without a real value ever entering git.

## What is tracked, and what is ignored

| file | tracked | purpose |
|---|---|---|
| `config.example.json` | **yes** | the full key structure, placeholder values |
| `README.md` | **yes** | this file |
| `config.json` | no | shared values for this machine |
| `config.<env>.json` | no | per-environment layer, e.g. `config.prod.json` |
| anything else here | no | ignored by default |

The `.gitignore` rule is an **allowlist**: `secrets/*` is ignored and named
exceptions are re-admitted. A blocklist of known-bad names only ever catches the
spellings someone thought of, and the first file named something new lands in
git.

**An ignored file is still a file on disk.** Check what is already sitting here
before assuming the gitignore has covered you.

## Precedence, highest first

1. **Environment variables** — the flat `DB_HOST`, or nested
   `OPENBRAIN_DATABASE__HOST`
2. `secrets/config.<env>.json` — the per-environment layer
3. `secrets/config.json` — the shared base layer
4. Field defaults in `python/openbrain/src/openbrain/config.py`

**An exported variable beats a committed file.** That direction is deliberate:
an operator overriding a setting on the command line should not lose to a file
on disk.

It is also load-bearing rather than assumed. `docs/standards/STANDARDS-python.md`
records this exact order being silently inverted in the reference project, and it
was inverted here too during development — measured 2026-07-30, a `config.json`
naming `database.host` beat an exported `DB_HOST`, with nothing logged. The cause
was each config section being its own `BaseSettings`, so each ran an independent
environment source *during construction*, before the parent consulted its chain.
Sections are now plain `BaseModel`; the environment is read by one source in one
place. `tests/test_settings.py::TestFileLayers::test_environment_beats_a_file`
pins it.

## Layers deep-merge

`config.<env>.json` may set a single key and leave its siblings intact:

```json
{ "log": { "level": "ERROR" } }
```

That changes the level and keeps every other `log` setting from `config.json`.
The merge is `pydantic-settings`' own `deep_merge`, not a hand-written one —
the hand-written version is what caused the inversion above.

## Both files are optional

A deployment configured entirely through the environment is valid and is how the
current service runs: `.env` carries `DB_HOST`, `PORT`, `EMBEDDING_BASE_URL` and
the rest. A missing layer is not an error.

## Unknown keys are rejected

A typo fails at startup naming the key, rather than sitting inert while the
process runs on defaults:

```
database.hsot  Extra inputs are not permitted
```

The same applies to prefixed environment variables — `OPENBRAIN_DB_TYPPO=1` is
reported by name, because `extra="forbid"` does *not* catch it on its own
(pydantic-settings only collects variables matching a declared field, so a typo
is invisible to the model).

## Never commit a credential

`config.example.json` uses `REPLACE_ME`. Passwords and API keys load as
`SecretStr`, so they do not appear in a repr, a log line, or a traceback —
verified by `tests/test_settings.py::test_password_does_not_appear_in_repr`.
That protects them in output; it does not protect them in git.

---

**See Also:**
- `docs/CONFIG_REFERENCE.md` — every variable and where it is read today
- `python/openbrain/src/openbrain/config.py` — the keystone, and the load order
- `docs/standards/STANDARDS-python.md` — the `secrets/` and `config.py` sections
