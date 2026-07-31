# secrets/

`config.json` and `config.{env}.json` are read from here by `src/exemplar/config.ts`.

**Neither is committed.** `.gitignore` excludes them; only `config.example.json`
is tracked, and it holds no real value -- every field in it is either a default
or an obvious placeholder.

Start from the example:

    cp secrets/config.example.json secrets/config.json

## What goes here and what does not

A value belongs here when it is **per-deployment**: a URL, a port base, a log
level, a target list.

A value does NOT belong here when it is a **credential in a shared or long-lived
deployment**. Use the environment for those:

    export EXEMPLAR_HOOK__SIGNING_SECRET='...'

The reason is not that env vars are inherently safer -- it is that a file is
easy to copy, easy to `cat` into a terminal that is being recorded, and easy to
include in a tarball by accident. `hook.signingSecret` is in the schema because
the receiver needs it, and it is documented here as the field most likely to be
mishandled.

## Precedence

Highest wins:

1. explicit overrides passed to `loadSettings()` (tests)
2. `EXEMPLAR_*` environment variables
3. `secrets/config.{env}.json`
4. `secrets/config.json`
5. schema defaults

That order is asserted in `tests/config.test.ts`, one test per layer. It is
written down here too, but the tests are what make it true.
