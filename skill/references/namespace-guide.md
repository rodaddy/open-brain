# Brain Namespace Guide

## Host Detection

| Hostname Pattern | Type | Default Namespace | Example |
|-----------------|------|-------------------|---------|
| `cc-*` | LXC container | `shared-kb` | cc-team, cc-alex, cc-sam |
| `*.local` | Personal machine | `<caller_identity>` | mini.local, laptop.local |
| Other | Unknown | `<caller_identity>` | |

## Known Hosts

| Hostname | Owner | Location |
|----------|-------|----------|
| `mini.local` | Rico | Local Mac Mini |
| `laptop.local` | Rico/Skippy | MacBook Air |
| `cc-team` | Acme (shared-kb) | LXC container |
| `cc-alex` | Alex | LXC container |
| `cc-sam` | Sam | LXC container |

## Directory-Based Override (Personal Machines Only)

On `*.local` hosts, the working directory overrides the default:

| Directory Pattern | Namespace | Why |
|-------------------|-----------|-----|
| `*/acme*` or `*/Acme*` | `shared-kb` | Acme Co work is shared |
| Everything else | `<caller_identity>` | Personal by default |

LXC boxes do NOT use directory detection -- they default to `shared-kb` regardless of cwd.

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
2. **Host type** -- `cc-*` -> shared-kb default; `*.local` -> identity default
3. **Directory** -- only on personal machines; `acme*` -> shared-kb
4. **Fallback** -- `<caller_identity>`

## Examples

### Rico on local Mac, in ~/Development/acme-trading
```
Host: mini.local (personal machine)
CWD: acme-trading (matches acme*)
-> namespace: "shared-kb"
```

### Rico on local Mac, in ~/Development/tax-strategy
```
Host: mini.local (personal machine)
CWD: tax-strategy (no acme match)
-> namespace: "rico"
```

### Rico on local Mac, in ~/Development/tax-strategy, says "push this to shared-kb"
```
Host: mini.local (personal machine)
CWD: tax-strategy (no acme match)
Intent: "shared-kb" override
-> namespace: "shared-kb" (intent wins)
```

### Alex on cc-alex LXC, working on anything
```
Host: cc-alex (LXC)
-> namespace: "shared-kb"
```

### Alex on cc-alex LXC, says "save this to my brain"
```
Host: cc-alex (LXC)
Intent: "my brain" -> personal override
-> namespace: "alex" (intent wins)
```

### Skippy on laptop.local, in ~/Development/open-brain
```
Host: laptop.local (personal machine)
CWD: open-brain (no acme match)
Caller: skippy
-> namespace: "skippy"
```

### Skippy on laptop.local, says "this is for the team"
```
Host: laptop.local (personal machine)
Intent: "team" -> shared-kb override
-> namespace: "shared-kb" (intent wins)
```
