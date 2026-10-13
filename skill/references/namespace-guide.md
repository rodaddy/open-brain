# Brain Namespace Guide

## Host Detection

| Hostname Pattern | Type | Default Namespace | Example |
|-----------------|------|-------------------|---------|
| `team-*` | shared container | `shared-kb` | team-shared, team-alex, team-sam |
| `*.local` | Personal machine | `<caller_identity>` | desktop.local, notebook.local |
| Other | Unknown | `<caller_identity>` | |

## Known Hosts

| Hostname | Owner | Location |
|----------|-------|----------|
| `desktop.local` | Jane | Desktop |
| `notebook.local` | Jane (assistant agent) | Laptop |
| `team-shared` | Acme (shared-kb) | shared container |
| `team-alex` | Alex | shared container |
| `team-sam` | Sam | shared container |

## Directory-Based Override (Personal Machines Only)

On `*.local` hosts, the working directory overrides the default:

| Directory Pattern | Namespace | Why |
|-------------------|-----------|-----|
| `*/acme*` or `*/Acme*` | `shared-kb` | Acme Co work is shared |
| Everything else | `<caller_identity>` | Personal by default |

Shared containers do NOT use directory detection -- they default to `shared-kb` regardless of cwd.

## Intent Keywords

These phrases override all host/directory detection:

### Personal Override
- "my brain", "my ob"
- "personal", "private"
- "save to my ..."
- "this is personal"
- "keep this private"

Result: `namespace = <caller_identity>`

### Shared-KB Override
- "shared-kb", "shared", "team"
- "acme", "push to shared-kb"
- "this is for the team"

Result: `namespace = "shared-kb"`

## Resolution Order

1. **Explicit intent** -- user says "personal" or "shared-kb" -> use that
2. **Host type** -- `team-*` -> shared-kb default; `*.local` -> identity default
3. **Directory** -- only on personal machines; `acme*` -> shared-kb
4. **Fallback** -- `<caller_identity>`

## Examples

### Jane on her desktop, in ~/Development/acme-trading
```
Host: desktop.local (personal machine)
CWD: acme-trading (matches acme*)
-> namespace: "shared-kb"
```

### Jane on her desktop, in ~/Development/tax-strategy
```
Host: desktop.local (personal machine)
CWD: tax-strategy (no acme match)
-> namespace: "jane"
```

### Jane on her desktop, in ~/Development/tax-strategy, says "push this to shared-kb"
```
Host: desktop.local (personal machine)
CWD: tax-strategy (no acme match)
Intent: "shared-kb" override
-> namespace: "shared-kb" (intent wins)
```

### Alex on team-alex container, working on anything
```
Host: team-alex (shared container)
-> namespace: "shared-kb"
```

### Alex on team-alex container, says "save this to my brain"
```
Host: team-alex (shared container)
Intent: "my brain" -> personal override
-> namespace: "alex" (intent wins)
```

### The assistant on notebook.local, in ~/Development/open-brain
```
Host: notebook.local (personal machine)
CWD: open-brain (no acme match)
Caller: assistant
-> namespace: "assistant"
```

### The assistant on notebook.local, says "this is for the team"
```
Host: notebook.local (personal machine)
Intent: "team" -> shared-kb override
-> namespace: "shared-kb" (intent wins)
```
