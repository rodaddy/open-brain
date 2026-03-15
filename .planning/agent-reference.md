# Open Brain -- Agent Reference

Non-secret reference data for agent prompts. Paste relevant sections into agent context.

## Service Endpoints

| Endpoint | URL |
|----------|-----|
| Server | http://10.71.20.49:3100 |
| MCP | http://10.71.20.49:3100/mcp |
| Health | http://10.71.20.49:3100/health |

## Database

| Field | Value |
|-------|-------|
| Host | 10.71.20.49 |
| Port | 5432 |
| Database | open_brain |
| User | open_brain |

## Auth Tokens

| Field | Source |
|-------|--------|
| Vaultwarden entry | "Open Brain - Auth Tokens" |
| Roles | admin, agent, discord, n8n, readonly |
| Env vars | AUTH_TOKEN_ADMIN, AUTH_TOKEN_AGENT, AUTH_TOKEN_DISCORD, AUTH_TOKEN_N8N, AUTH_TOKEN_READONLY |
| Fetch command | `./fetch-secrets.sh AUTH_TOKEN_<ROLE>` |

## mcp2cli

| Field | Value |
|-------|-------|
| Service name | open-brain |
| Backend | http |
| Config | ~/.config/mcp2cli/services.json |
| Skills | ~/.config/mcp2cli/skills/open-brain/SKILL.md |
| CLI role | agent (AUTH_TOKEN_AGENT) |

### Tools (6 total)

| Tool | Description |
|------|-------------|
| log_thought | Log a thought with semantic embedding |
| log_decision | Log a decision with title and rationale |
| search_brain | Cross-table semantic search across all context |
| find_person | Search people by name or semantic context |
| session_save | Save session context for a project |
| session_load | Load session context (project or global) |

### Example Commands

```bash
# List tools
mcp2cli open-brain --help

# Search across all context
mcp2cli open-brain search_brain --params '{"query":"authentication patterns"}'

# Log a thought
mcp2cli open-brain log_thought --params '{"thought":"Considering event-driven architecture for webhooks"}'

# Find a person
mcp2cli open-brain find_person --params '{"query":"Rico"}'

# Save session
mcp2cli open-brain session_save --params '{"project":"my-project","context":"Implemented auth layer","tags":["auth","security"]}'

# Load session
mcp2cli open-brain session_load --params '{"project":"my-project"}'
```

## Consumer Integrations

### Claude Code Hooks

| Hook | Event | Script |
|------|-------|--------|
| Session Save | PreCompact (auto\|manual) | `/Volumes/ThunderBolt/Development/open-brain/hooks/open-brain-session-save.ts` |
| Session Load | SessionStart (startup\|resume\|compact) | `/Volumes/ThunderBolt/Development/open-brain/hooks/open-brain-session-load.ts` |

Env var required: `OPEN_BRAIN_AGENT_TOKEN` (from vaultwarden "Open Brain - Auth Tokens" AUTH_TOKEN_AGENT)

### n8n Workflows

| Workflow | ID | Trigger | Status |
|----------|----|---------|--------|
| Open Brain - Discord Thought Capture | n3BDmv0iqbG470wy | Webhook POST `/open-brain-thought` | active |

Webhook URL: `https://n8n.rodaddy.live/webhook/open-brain-thought`

## Infrastructure

| Field | Value |
|-------|-------|
| Port | 3100 |
| Runtime | Bun |
| Server framework | Express.js |
| MCP SDK | @modelcontextprotocol/sdk ^1.27.0 |
| Transport | StreamableHTTPServerTransport |
| Embeddings | gemini-embedding-001 via LiteLLM (10.71.20.53:4000) |
| Vector store | pgvector (halfvec) on PostgreSQL 16 |
