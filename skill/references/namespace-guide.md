# Brain Namespace Guide

## Host Detection

| Hostname Pattern | Type | Default Namespace | Example |
|-----------------|------|-------------------|---------|
| `cc-*` | LXC container | `collab` | cc-king, cc-kevin, cc-geetesh |
| `*.local` | Personal machine | `<caller_identity>` | Mini-M4-Pro.local, rodaddy-air-2.local |
| Other | Unknown | `<caller_identity>` | |

## Known Hosts

| Hostname | Owner | Location |
|----------|-------|----------|
| `Mini-M4-Pro.local` | Rico | Local Mac Mini |
| `rodaddy-air-2.local` | Rico/Skippy | MacBook Air |
| `cc-king` | King (collab) | LXC 10.71.20.120 |
| `cc-kevin` | Kevin | LXC 10.71.20.121 |
| `cc-geetesh` | Geetesh | LXC 10.71.20.122 |

## Directory-Based Override (Personal Machines Only)

On `*.local` hosts, the working directory overrides the default:

| Directory Pattern | Namespace | Why |
|-------------------|-----------|-----|
| `*/king*` or `*/King*` | `collab` | King Capital work is shared |
| Everything else | `<caller_identity>` | Personal by default |

LXC boxes do NOT use directory detection -- they default to `collab` regardless of cwd.

## Intent Keywords

These phrases override all host/directory detection:

### Personal Override
- "my brain", "my ob"
- "personal", "private"
- "save to my ..."
- "this is personal"
- "keep this private"

Result: `namespace = <caller_identity>`

### Collab Override
- "collab", "shared", "team"
- "king", "push to collab"
- "this is for the team"

Result: `namespace = "collab"`

## Resolution Order

1. **Explicit intent** -- user says "personal" or "collab" -> use that
2. **Host type** -- `cc-*` -> collab default; `*.local` -> identity default
3. **Directory** -- only on personal machines; `king*` -> collab
4. **Fallback** -- `<caller_identity>`

## Examples

### Rico on local Mac, in ~/Development/king-trading
```
Host: Mini-M4-Pro.local (personal machine)
CWD: king-trading (matches king*)
-> namespace: "collab"
```

### Rico on local Mac, in ~/Development/tax-strategy
```
Host: Mini-M4-Pro.local (personal machine)
CWD: tax-strategy (no king match)
-> namespace: "rico"
```

### Rico on local Mac, in ~/Development/tax-strategy, says "push this to collab"
```
Host: Mini-M4-Pro.local (personal machine)
CWD: tax-strategy (no king match)
Intent: "collab" override
-> namespace: "collab" (intent wins)
```

### Kevin on cc-kevin LXC, working on anything
```
Host: cc-kevin (LXC)
-> namespace: "collab"
```

### Kevin on cc-kevin LXC, says "save this to my brain"
```
Host: cc-kevin (LXC)
Intent: "my brain" -> personal override
-> namespace: "kevin" (intent wins)
```

### Skippy on rodaddy-air-2.local, in ~/Development/open-brain
```
Host: rodaddy-air-2.local (personal machine)
CWD: open-brain (no king match)
Caller: skippy
-> namespace: "skippy"
```

### Skippy on rodaddy-air-2.local, says "this is for the team"
```
Host: rodaddy-air-2.local (personal machine)
Intent: "team" -> collab override
-> namespace: "collab" (intent wins)
```
