# Brain Skill -- Agent Usage Guide

Instructions for autonomous agents (Skippy OC, n8n-spawned agents, etc.) using Open Brain.

## Before ANY OB Write

You MUST resolve the namespace. Do NOT default to omitting it.

### Quick Resolution

```bash
# 1. Detect host type
HOST=$(hostname)

# 2. Detect directory context
CWD_BASE=$(basename "$PWD")

# 3. Resolve
if [[ "$HOST" == cc-* ]]; then
  # LXC -- default collab
  NS="collab"
elif [[ "$CWD_BASE" == king* ]] || [[ "$CWD_BASE" == King* ]]; then
  # Personal machine + king directory
  NS="collab"
else
  # Personal machine + non-king directory
  # Use your authenticated identity (from your auth token)
  NS="<your_client_id>"
fi
```

### For Skippy OC Specifically

- You run on `rodaddy-air-2.local` (Air) or `Mini-M4-Pro.local` (local)
- Your `clientId` is `skippy`
- Default: `namespace = "skippy"` (unless in a king dir -> "collab")
- If a user explicitly tells you "this is for the team" or "push to collab" -> use "collab"
- If a user says "save this to Rico's brain" or "this is personal for me" -> use that user's identity, NOT "skippy"

### For LXC Agents (cc-king, cc-kevin, cc-geetesh)

- Default: `namespace = "collab"` (you're doing team work)
- Only switch to personal namespace if the user explicitly asks
- Your `clientId` from the auth token tells OB who you are for audit purposes

## Mandatory Parameters on Writes

Every `log_thought`, `log_decision`, `session_save`, `upsert_person` call MUST include:

```json
{
  "namespace": "<resolved_namespace>",
  "tags": ["<contextual_tags>"]
}
```

Never omit namespace. Never omit tags. Empty tags array `[]` is acceptable if genuinely no tags apply, but try to include at least the project/repo name.

## Tag Conventions

| Working On | Tags to Include |
|-----------|-----------------|
| King Capital code | `["king", "<repo-name>"]` |
| Infrastructure | `["infra", "<service>"]` |
| PAI system itself | `["pai", "<component>"]` |
| Agent/OC work | `["oc", "<task-domain>"]` |
| User-requested personal | `["personal"]` |
| Session summaries | `["session", "<project>"]` |

## Common Mistakes

1. **Omitting namespace** -- the server defaults to your `clientId`, which may be wrong for collab work
2. **Hardcoding "rico"** -- use the authenticated identity, not a hardcoded string
3. **Ignoring user intent** -- "save this to my brain" means THEIR namespace, not yours
4. **No tags** -- always tag with at least the project context for traceability

## Example: Skippy OC Logging a Thought from King Work

```bash
# On rodaddy-air-2.local, in ~/Development/king-trading
mcp2cli open-brain log_thought --params '{
  "content": "The RRF fusion weights need tuning -- k=60 is too aggressive for short queries",
  "tags": ["king", "king-trading", "search", "rrf"],
  "namespace": "collab"
}'
```

## Example: Skippy OC Logging a Personal Observation

```bash
# On rodaddy-air-2.local, in ~/Development/pai-skills
mcp2cli open-brain log_thought --params '{
  "content": "Skill enforcement hooks should check recent messages deeper than 20",
  "tags": ["pai", "hooks", "skills"],
  "namespace": "skippy"
}'
```

## Example: User Says "Save This to My Brain"

```bash
# User = Rico, on any host
mcp2cli open-brain log_thought --params '{
  "content": "Whatever the user asked to save",
  "tags": ["personal"],
  "namespace": "rico"
}'
```
