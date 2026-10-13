# Brain Skill -- Agent Usage Guide

Instructions for autonomous agents (a personal assistant agent, n8n-spawned agents, etc.) using Open Brain.

## Before ANY OB Write

You MUST resolve the namespace. Do NOT default to omitting it.

### Quick Resolution

```bash
# 1. Detect host type
HOST=$(hostname)

# 2. Detect directory context
CWD_BASE=$(basename "$PWD")

# 3. Resolve
if [[ "$HOST" == team-* ]]; then
  # shared container -- default shared-kb
  NS="shared-kb"
elif [[ "$CWD_BASE" == acme* ]] || [[ "$CWD_BASE" == Acme* ]]; then
  # Personal machine + acme directory
  NS="shared-kb"
else
  # Personal machine + non-acme directory
  # Use your authenticated identity (from your auth token)
  NS="<your_client_id>"
fi
```

### For a Personal Assistant Agent

- You run on `notebook.local` or `desktop.local`
- Your `clientId` is `assistant`
- Default: `namespace = "assistant"` (unless in a acme dir -> "shared-kb")
- If a user explicitly tells you "this is for the team" or "push to shared-kb" -> use "shared-kb"
- If a user says "save this to Jane's brain" or "this is personal for me" -> use that user's identity, NOT "assistant"

### For Shared-Container Agents (team-shared, team-alex, team-sam)

- Default: `namespace = "shared-kb"` (you're doing team work)
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
| Acme Co code | `["acme", "<repo-name>"]` |
| Infrastructure | `["infra", "<service>"]` |
| Agent tooling | `["agents", "<component>"]` |
| Agent/OC work | `["oc", "<task-domain>"]` |
| User-requested personal | `["personal"]` |
| Session summaries | `["session", "<project>"]` |

## Common Mistakes

1. **Omitting namespace** -- the server defaults to your `clientId`, which may be wrong for shared work
2. **Hardcoding a user name** -- use the authenticated identity, not a hardcoded string
3. **Ignoring user intent** -- "save this to my brain" means THEIR namespace, not yours
4. **No tags** -- always tag with at least the project context for traceability

## Example: An Assistant Agent Logging a Thought from Acme Work

```bash
# On notebook.local, in ~/Development/acme-trading
mcp2cli open-brain log_thought --params '{
  "content": "The RRF fusion weights need tuning -- k=60 is too aggressive for short queries",
  "tags": ["acme", "acme-trading", "search", "rrf"],
  "namespace": "shared-kb"
}'
```

## Example: An Assistant Agent Logging a Personal Observation

```bash
# On notebook.local, in ~/Development/agent-skills
mcp2cli open-brain log_thought --params '{
  "content": "Skill enforcement hooks should check recent messages deeper than 20",
  "tags": ["agents", "hooks", "skills"],
  "namespace": "assistant"
}'
```

## Example: User Says "Save This to My Brain"

```bash
# User = Jane, on any host
mcp2cli open-brain log_thought --params '{
  "content": "Whatever the user asked to save",
  "tags": ["personal"],
  "namespace": "jane"
}'
```
