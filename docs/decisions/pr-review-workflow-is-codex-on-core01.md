# PR review runs as Codex on core01

**Scope key:** `architecture.pr_review_workflow_is_codex_on_core01`
**Source:** https://github.com/rodaddy/open-brain/issues/231
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Automated PR review runs as a Codex workflow on the core01 macOS runner using cached ChatGPT-login auth, not the Anthropic/LiteLLM action: gpt-5.5 at low effort for normal review, gpt-5.4 at medium for deep review triggered by `/codex-deep` or a PR-scope threshold. The step must `unset OPENAI_API_KEY CODEX_API_KEY` so a stray env var cannot force API-key auth. Note the coupling: if the ChatGPT session on core01 lapses, the check fails until a human re-auths — CI cannot self-heal it.

## Verbatim, from the source

> replace the Anthropic/LiteLLM Claude review action with a local Codex review workflow ... normal review: gpt-5.5, effort low; deep review: gpt-5.4, effort medium when explicitly requested with /codex-deep ... The step explicitly `unset OPENAI_API_KEY CODEX_API_KEY` so a stray env var cannot force API-key auth or leak a key.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
