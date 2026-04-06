# Search Guide

## Search Modes

| Mode | How It Works | Best For |
|------|-------------|----------|
| **hybrid** (default) | Runs vector + FTS in parallel, merges with RRF (k=60) | General queries -- best recall |
| **vector** | Semantic similarity via embedding cosine distance | Conceptual/fuzzy queries |
| **keyword** | PostgreSQL full-text search (`tsvector`/`tsquery`) | Exact term matching |

```bash
# Default hybrid
mcp2cli open-brain search_brain --params '{"query": "authentication patterns"}'

# Force vector-only
mcp2cli open-brain search_brain --params '{"query": "how we handle auth", "search_mode": "vector"}'

# Force keyword-only
mcp2cli open-brain search_brain --params '{"query": "JWT token", "search_mode": "keyword"}'
```

## Federated Search (search_all)

`search_all` searches both Open Brain and qmd file index, merging results with RRF:

```bash
# Search everywhere
mcp2cli open-brain search_all --params '{"query": "deployment process"}'

# Brain only (skip qmd)
mcp2cli open-brain search_all --params '{"query": "deployment", "sources": "brain"}'

# qmd only (skip brain)
mcp2cli open-brain search_all --params '{"query": "deployment", "sources": "qmd"}'
```

## Output Format

### search_brain Response

```json
[
  {
    "source_type": "thought",
    "id": "uuid",
    "content_preview": "The content...",
    "tags": ["tag1", "tag2"],
    "tier": "warm",
    "created_at": "2026-04-06T...",
    "distance": 0.12,
    "usefulness": 0.8
  }
]
```

### search_all Response

```json
{
  "total": 15,
  "brain_hits": 10,
  "qmd_hits": 5,
  "results": [
    { "source": "brain", "type": "thought", "content": "...", "score": 0.85, "id": "uuid", "tags": ["..."], "tier": "hot" },
    { "source": "qmd", "type": "file", "content": "...", "score": 0.72, "path": "/path/to/file" }
  ]
}
```

### Recommended Display Format

```
## Brain Search: "<query>"

### Decisions (N found)
- **Title** -- rationale summary
  Tags: tag1, tag2

### Thoughts/Learnings (N found)
- Content preview
  Tags: tag1, tag2

### Sessions (N found)
- **Project** (date) -- summary
```

## Auto-Tagging Guidelines

When logging thoughts/decisions, include contextual tags:

| Context | Auto-Tags |
|---------|-----------|
| In a king repo | `["king", "<repo-name>"]` |
| Infrastructure work | `["infra", "<service-name>"]` |
| Personal/career | `["personal"]` |
| Financial | `["personal", "finance"]` |
| Session wrap | `["session", "<project>"]` |

Tags are additive -- merge with any user-provided tags.
