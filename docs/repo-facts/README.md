# qmd-Derived Repo Fact Promotion

Open Brain stores curated qmd-derived repo facts as graph entities through
`upsert_repo_fact`. It does not mirror raw qmd chunks or source files.

Use the promotion command with an explicit curated manifest:

```bash
bun run promote:qmd-facts -- --file docs/repo-facts/king-capital.qmd-facts.json --namespace collab --dry-run
bun run promote:qmd-facts -- --file docs/repo-facts/king-capital.qmd-facts.json --namespace collab
```

The command reports `would_promote`, `promoted`, `updated`, `skipped`,
`unchanged`, `stale`, and `failed` counts. If a hosted write times out but the
fact lands, the command verifies the result through `list_repo_facts` and counts
it as `verified_after_timeout`.

The King Capital pilot manifest was curated from `qmd context list` on the local
GPU machine's `king` collection. Each fact includes a GitHub source pointer,
commit stamp, verification timestamp, confidence, and staleness policy.
