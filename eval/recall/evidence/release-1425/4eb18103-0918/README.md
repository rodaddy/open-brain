# Release 1425 focused verification receipts

These receipts were produced from product source `4eb1810316c68b711df9b6cbeec68c50db73f2ee` by two disposable runner jobs:

- `ob-1425-heldout-dream-release-4eb18103-0918a`
- `ob-1425-dream-client-continuation-4eb18103-0918b`

The held-out recall report passed its frozen thresholds: recall@5 `1.0`, precision@5 `0.4`, MRR `1.0`, zero namespace leaks, a denied negative control, and teardown of all 10 seeded rows. The continuation reports DREAM Light `1` file / `5` tests, reviewed-candidate chain `2` files / `8` tests, TypeScript client `6` files / `58` tests, and Python client `43` cases. Command and cleanup exits were zero, with zero owned databases remaining before parent cleanup.

`heldout-receipt-sha256.txt` and `continuation-artifact-sha256.txt` are the runners' original external manifests and retain their `/work/out/...` names. `custody.sha256` covers the files actually retained here.

The original DREAM Light stdout printed a generated disposable database-role password. `continuation-dream-light.stdout.redacted` preserves the output with only that value replaced by `[REDACTED]`; its local custody hash therefore intentionally differs from the runner manifest. The other selected runner artifacts are retained byte-for-byte, including the three zero-byte stderr receipts.

## Limits

This is focused release evidence. The held-out test is valid, but there is no direct post-drop catalog query proving teardown beyond the report's recorded teardown result. It does not verify the full DREAM issue 758 model comparison, hosted/live clients, deployment, or complete release acceptance. Full runner outputs remain external on the collaboration share; raw agent and service logs are excluded from Git.

The local scribe remained unusable for this repository because its backend route defaulted to frozen GitHub rather than Forgejo. No scribe event or fallback comment was posted.
