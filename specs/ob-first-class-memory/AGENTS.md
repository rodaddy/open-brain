# Agent Briefs

## Implementation

Responsibilities: modify only `python/openbrain-memory/**` and this packet; reuse package clients/helpers; add functional boundary tests; run the validation ladder.

Must challenge:

- Whether a receipt proves durable save versus merely attempted write
- Whether exact runtime scope reaches every lifecycle call
- Whether fallback can leak secrets or interpolate shell input
- Whether raw/oversized content can bypass enforcement
- Whether recall failure can break the caller

Success criteria: all task acceptance criteria have observable tests and required validation passes.

## Review

Review only the scoped diff. Prioritize correctness, data-loss truthfulness, auth/scope isolation, secret redaction, bounded input, fallback argv shape, and compatibility with existing package APIs. Findings require severity and file/line references. Do not redesign unrelated package surfaces.
