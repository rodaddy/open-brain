# Phase 5: Consumer Integration - Research

**Researched:** 2026-03-13
**Domain:** MCP consumer registration, Claude Code hooks, Discord-to-n8n thought capture, token management
**Confidence:** HIGH

## Summary

Phase 5 connects all PAI consumers to the running Open Brain MCP server. There are four distinct integration domains: (1) mcp2cli registration for CLI access, (2) Claude Code MCP server configuration for direct AI access, (3) Discord thought capture through an n8n webhook pipeline, and (4) Claude Code PreCompact/SessionStart hooks for automatic session continuity.

The mcp2cli integration is straightforward -- Open Brain is an HTTP-backend MCP server on port 3100, and `services.json` already has the pattern for HTTP services (see `vaultwarden-secrets` and `homekit`). Skill files are auto-generated with `mcp2cli generate-skills`. Token generation and storage in vaultwarden is the standard credential management pattern. The Claude Code hooks are well-documented -- `PreCompact` fires before context compaction (matcher: `manual|auto`) and receives `session_id`, `transcript_path`, `cwd`, `trigger`, and `custom_instructions` on stdin. `SessionStart` fires with matcher `startup|resume|clear|compact`. The existing `inject-brain-context.ts` hook reads from flat file exports and should be replaced/augmented with a hook that calls Open Brain's `session_load` tool. Discord thought capture requires an n8n workflow with a webhook trigger that receives Discord messages and calls Open Brain's `log_thought` via HTTP POST to `/mcp`.

**Primary recommendation:** Use HTTP hooks for the PreCompact session_save (fires directly to the Open Brain server endpoint) and command hooks for SessionStart session_load (needs to output context to stdout for Claude). Generate per-consumer tokens via `openssl rand -hex 32`, store in vaultwarden, and configure each consumer with its scoped token.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INT-01 | mcp2cli registration for CLI access | HTTP backend config in services.json + `generate-skills` auto-generates SKILL.md. Pattern proven with vaultwarden-secrets and homekit services |
| INT-02 | Discord thought capture -- Discord bot sends messages to n8n workflow which INSERTs to thoughts table | n8n webhook trigger + HTTP Request node to POST `/mcp` with Bearer auth. Existing "Skippy - Discord Classification" and "Universal Capture v3" workflows provide reference patterns |
</phase_requirements>

## Standard Stack

### Core

| Component | Version/Tool | Purpose | Why Standard |
|-----------|-------------|---------|--------------|
| mcp2cli | v0.2.0 (custom) | CLI bridge to MCP servers | Already in use for 14 services; HTTP backend natively supported |
| Claude Code hooks | native | PreCompact + SessionStart lifecycle events | Official hook system, already extensively used (20+ hooks configured) |
| n8n | self-hosted | Discord-to-Open-Brain webhook pipeline | Already running at n8n.rodaddy.live with Discord workflows active |
| vaultwarden-secrets | MCP via mcp2cli | Per-consumer token storage | Standard credential store for PAI infrastructure |
| openssl | system | Token generation | `openssl rand -hex 32` -- standard for Bearer tokens |

### Supporting

| Component | Purpose | When to Use |
|-----------|---------|-------------|
| jq | JSON parsing in command hooks | SessionStart hook to parse session_load response |
| curl | HTTP calls from hooks | PreCompact hook calling Open Brain API directly (alternative to HTTP hook type) |
| n8n-discord-trigger (community node) | Discord message listener | If not already installed; "Discord Interactions" workflow (48 nodes) suggests it's available |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| HTTP hook for PreCompact | Command hook with curl | HTTP hooks are cleaner (no shell script), but command hooks give more control over error handling. HTTP hooks cannot block (PreCompact doesn't support blocking anyway). **Use HTTP hook -- simpler.** |
| Command hook for SessionStart | HTTP hook | SessionStart output goes to Claude's context via stdout. HTTP hooks can also return context via response body. **Use command hook -- more flexibility for formatting output** |
| n8n webhook for Discord | Direct Discord bot | n8n already has Discord integration, avoids managing a separate bot process. **Use n8n.** |

## Architecture Patterns

### Recommended Project Structure

New files for Phase 5:

```
scripts/
  generate-tokens.sh           # Generate per-consumer Bearer tokens
hooks/
  pre-compact-session-save.ts  # PreCompact hook: calls session_save
  session-start-load.ts        # SessionStart hook: calls session_load, outputs context
deploy/
  open-brain.service           # Already exists
```

External config changes (not in this repo):

```
~/.config/mcp2cli/services.json         # Add open-brain HTTP service
~/.config/mcp2cli/skills/open-brain/    # Auto-generated by generate-skills
~/.claude/settings.json                 # Add PreCompact + update SessionStart hooks
vaultwarden                             # Store per-consumer tokens
```

### Pattern 1: mcp2cli HTTP Service Registration

**What:** Register Open Brain as an HTTP-backend service in mcp2cli
**When to use:** Any HTTP-transport MCP server

The services.json config pattern for HTTP backends is established by vaultwarden-secrets and homekit:

```json
{
  "open-brain": {
    "backend": "http",
    "url": "http://10.71.20.49:3100/mcp",
    "headers": {
      "Authorization": "Bearer <agent-token-from-vaultwarden>"
    }
  }
}
```

After adding the service entry, run `mcp2cli generate-skills open-brain` to auto-generate the SKILL.md and references directory. Then verify with `mcp2cli open-brain --help`.

**Important:** The Open Brain MCP server uses StreamableHTTPServerTransport which requires session management (session ID headers). mcp2cli must support this -- verify that the HTTP backend handles the MCP session initialization handshake (POST with initialize request, receiving session ID in response headers, then including `mcp-session-id` in subsequent requests).

### Pattern 2: Claude Code PreCompact Hook (HTTP type)

**What:** Auto-save session state before context compaction
**When to use:** Every time context compacts (manual or auto)

The PreCompact hook receives JSON input on stdin with these fields:
- `session_id` -- current session identifier
- `transcript_path` -- path to conversation JSONL
- `cwd` -- current working directory
- `permission_mode` -- current permission mode
- `hook_event_name` -- "PreCompact"
- `trigger` -- "manual" or "auto"
- `custom_instructions` -- user text from /compact (empty for auto)

PreCompact has **no decision control** -- it's fire-and-forget for side effects only. Only `type: "command"` hooks are supported (NOT http/prompt/agent).

The hook should:
1. Read stdin JSON to get `session_id` and `cwd`
2. Determine project name from `cwd` (basename of directory)
3. Construct a session summary from available context
4. POST to Open Brain's `/mcp` endpoint calling `session_save`

```json
{
  "hooks": {
    "PreCompact": [
      {
        "matcher": "auto|manual",
        "hooks": [
          {
            "type": "command",
            "command": "bun run ~/.config/pai/hooks/open-brain-session-save.ts",
            "timeout": 15,
            "async": true
          }
        ]
      }
    ]
  }
}
```

**CRITICAL CORRECTION:** PreCompact only supports `type: "command"` hooks, NOT HTTP hooks. The official docs state: "ConfigChange, InstructionsLoaded, Notification, PreCompact, SessionEnd, SessionStart, SubagentStart, TeammateIdle, WorktreeCreate, WorktreeRemove" only support `type: "command"` hooks.

The command hook must make an HTTP call itself (via fetch/curl) to the Open Brain server's `/mcp` endpoint.

### Pattern 3: Claude Code SessionStart Hook (command type)

**What:** Load last session context when starting/resuming
**When to use:** On startup and resume (matchers: `startup|resume|compact`)

The hook should:
1. Determine project from `cwd`
2. Call Open Brain's `session_load` tool via HTTP POST to `/mcp`
3. Output the session summary to stdout (Claude Code injects stdout into context)

The existing `inject-brain-context.ts` reads flat file exports. The new hook replaces/supplements this with a live query to Open Brain.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|compact",
        "hooks": [
          {
            "type": "command",
            "command": "bun run ~/.config/pai/hooks/open-brain-session-load.ts",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

**Key detail:** SessionStart hooks must be fast. The existing hook chain already has 6 hooks. Keep the session_load hook under 5 seconds -- the Open Brain server is on the local network so latency should be minimal.

### Pattern 4: n8n Discord Thought Capture Workflow

**What:** Discord messages in a designated channel trigger `log_thought`
**When to use:** Passive thought capture from Discord

The n8n workflow pattern:
1. **Trigger:** Webhook node (or Discord trigger community node) listens for messages
2. **Filter:** Check if message is from designated channel/user
3. **Transform:** Extract message content, construct `log_thought` params
4. **Call:** HTTP Request node POSTs to `http://10.71.20.49:3100/mcp` with:
   - Headers: `Authorization: Bearer <discord-token>`, `Content-Type: application/json`
   - Body: MCP initialize request first (for session), then tool call
5. **Respond:** Optional confirmation back to Discord

Existing reference workflows:
- `pgbQNuPnzoQa6ir5` -- "Skippy - Discord Classification (Webhook)" (11 nodes, active)
- `4Qz6V6xWFmSJyAz9` -- "Universal Capture v3 (with Classification)" (10 nodes, active)
- `YFqiu1IBlzgei8F2` -- "Discord Interactions" (48 nodes, active)

**Important consideration:** The MCP protocol requires session initialization before tool calls. The n8n workflow needs to handle the two-step flow: (1) POST initialize request to get session ID, (2) POST tool call with session ID header. Alternatively, consider adding a simplified REST endpoint (non-MCP) to Open Brain for n8n -- e.g., `POST /api/thoughts` -- to avoid MCP protocol complexity in n8n.

### Anti-Patterns to Avoid

- **Hardcoding tokens in hook scripts:** Store tokens in vaultwarden, retrieve at runtime or inject via environment variables
- **Making hooks synchronous when they don't need to be:** The PreCompact hook should be `async: true` -- it shouldn't block compaction
- **Duplicating session_save logic:** The hooks call the existing MCP tool, they don't replicate the SQL/embedding logic
- **Skipping the MCP session handshake in n8n:** StreamableHTTPServerTransport requires initialize -> tool call flow. Don't just POST a raw tool call

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Token generation | Custom token format | `openssl rand -hex 32` | Cryptographically secure, standard 256-bit tokens |
| Token storage | .env files or hardcoded | vaultwarden-secrets MCP | Centralized, auditable, supports per-consumer isolation |
| Skill file generation | Manual SKILL.md | `mcp2cli generate-skills open-brain` | Auto-generates from live schema introspection |
| Discord bot process | Custom Discord.js bot | n8n webhook + Discord nodes | Already running, managed, monitored |
| Session context formatting | Custom transcript parser | `session_load` tool response | Tool already returns structured JSON with all fields |

**Key insight:** Every integration point has an established pattern in the existing PAI infrastructure. mcp2cli, vaultwarden, n8n, and Claude Code hooks are all proven. The work is configuration and wiring, not building new infrastructure.

## Common Pitfalls

### Pitfall 1: MCP Session Initialization in n8n
**What goes wrong:** POSTing a tool call directly to `/mcp` without first initializing a session results in a 400 error ("Bad request: missing session or not an initialize request").
**Why it happens:** StreamableHTTPServerTransport requires initialize -> session ID -> tool call flow.
**How to avoid:** Either (a) implement the two-step MCP handshake in n8n (initialize, extract session ID from response headers, use in subsequent requests), or (b) add a simple REST endpoint (`POST /api/thoughts`) that bypasses MCP protocol for machine-to-machine integrations.
**Warning signs:** 400 errors from `/mcp` endpoint in n8n execution logs.

### Pitfall 2: PreCompact Hook Reliability
**What goes wrong:** The PreCompact hook doesn't fire, so session state is lost on compaction.
**Why it happens:** There's a known bug (GitHub issue #13572) where PreCompact hooks may not trigger reliably. Also, hooks that are too slow get killed by timeout.
**How to avoid:** (a) Set `async: true` so it doesn't block, (b) set reasonable timeout (15s), (c) add fallback -- also hook `Stop` event to save session state as a backup, (d) test manually with `/compact` command.
**Warning signs:** No session records appearing in DB after compaction events.

### Pitfall 3: Token Mismatch Between Consumers
**What goes wrong:** A consumer (mcp2cli, Claude Code, n8n) uses the wrong token, gets 401 errors or wrong permissions.
**Why it happens:** Multiple tokens for multiple roles; easy to mix up admin/agent/discord/n8n/readonly.
**How to avoid:** Store each token in vaultwarden with clear naming (e.g., "open-brain-agent-token", "open-brain-discord-token"). Document the mapping in agent-reference.md.
**Warning signs:** 401 errors in server logs, permission denied responses from tools.

### Pitfall 4: Hook Script Path Resolution
**What goes wrong:** Hook command can't find the script because of path resolution issues.
**Why it happens:** Hooks run in the project's cwd, not the script's directory. Relative paths break.
**How to avoid:** Always use absolute paths in hook commands (`~/.config/pai/hooks/...`). The existing hooks all follow this pattern.
**Warning signs:** Hook errors about "command not found" or "no such file".

### Pitfall 5: SessionStart Hook Adding Too Much Context
**What goes wrong:** The session_load hook injects a massive session summary into context, wasting tokens.
**Why it happens:** session_load returns the full summary with all structured fields.
**How to avoid:** Format the output concisely. Only include: project, key_decisions, blockers, next_steps. Skip the full summary text unless it's short.
**Warning signs:** Large context injection messages at session start.

## Code Examples

### mcp2cli services.json entry

```json
{
  "open-brain": {
    "backend": "http",
    "url": "http://10.71.20.49:3100/mcp",
    "headers": {
      "Authorization": "Bearer <AGENT_TOKEN>"
    }
  }
}
```

### PreCompact Hook (command type -- the only supported type)

```typescript
#!/usr/bin/env bun
// ~/.config/pai/hooks/open-brain-session-save.ts
// Fires before context compaction to save session state

const input = await Bun.stdin.json();
const { session_id, cwd, trigger } = input;
const project = cwd.split("/").pop() || "unknown";

const OPEN_BRAIN_URL = "http://10.71.20.49:3100/mcp";
const TOKEN = Bun.env.OPEN_BRAIN_AGENT_TOKEN;

if (!TOKEN) process.exit(0); // Silent exit if not configured

// Step 1: Initialize MCP session
const initResp = await fetch(OPEN_BRAIN_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${TOKEN}`,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "claude-code-hook", version: "1.0.0" },
    },
  }),
});

const mcpSessionId = initResp.headers.get("mcp-session-id");
if (!mcpSessionId) process.exit(0);

// Step 2: Call session_save tool
await fetch(OPEN_BRAIN_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${TOKEN}`,
    "mcp-session-id": mcpSessionId,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "session_save",
      arguments: {
        summary: `Auto-saved before ${trigger} compaction. Session: ${session_id}`,
        project,
        tags: ["auto-save", "pre-compact"],
        next_steps: [],
        key_decisions: [],
      },
    },
  }),
});
```

### SessionStart Hook

```typescript
#!/usr/bin/env bun
// ~/.config/pai/hooks/open-brain-session-load.ts
// Fires at session start to load previous session context

const input = await Bun.stdin.json();
const { cwd } = input;
const project = cwd.split("/").pop() || "unknown";

const OPEN_BRAIN_URL = "http://10.71.20.49:3100/mcp";
const TOKEN = Bun.env.OPEN_BRAIN_AGENT_TOKEN;

if (!TOKEN) process.exit(0);

try {
  // Initialize MCP session
  const initResp = await fetch(OPEN_BRAIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "claude-code-hook", version: "1.0.0" },
      },
    }),
  });

  const mcpSessionId = initResp.headers.get("mcp-session-id");
  if (!mcpSessionId) process.exit(0);

  // Call session_load
  const loadResp = await fetch(OPEN_BRAIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TOKEN}`,
      "mcp-session-id": mcpSessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "session_load",
        arguments: { project },
      },
    }),
  });

  const result = await loadResp.json();
  const content = result?.result?.content?.[0]?.text;
  if (!content || content.startsWith("No sessions")) process.exit(0);

  const session = JSON.parse(content);

  // Output concise context to stdout (injected into Claude's context)
  console.log("<!-- Open Brain: Previous Session Context -->");
  console.log(`## Last Session: ${session.project || "global"}`);
  if (session.key_decisions?.length) {
    console.log("\n### Key Decisions");
    session.key_decisions.forEach((d: string) => console.log(`- ${d}`));
  }
  if (session.blockers?.length) {
    console.log("\n### Blockers");
    session.blockers.forEach((b: string) => console.log(`- ${b}`));
  }
  if (session.next_steps?.length) {
    console.log("\n### Next Steps");
    session.next_steps.forEach((s: string) => console.log(`- ${s}`));
  }
  console.log("<!-- End Open Brain Context -->");
} catch {
  // Silent failure -- don't block session start
  process.exit(0);
}
```

### Token Generation Script

```bash
#!/usr/bin/env bash
# scripts/generate-tokens.sh
# Generate per-consumer Bearer tokens for Open Brain

set -euo pipefail

echo "Generating Open Brain consumer tokens..."
echo ""

for role in admin agent discord n8n readonly; do
  token=$(openssl rand -hex 32)
  echo "AUTH_TOKEN_${role^^}=${token}"
done

echo ""
echo "Add these to /opt/open-brain/.env on the deployment host."
echo "Store each token in vaultwarden under 'open-brain-<role>-token'."
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Flat file brain exports | MCP server with semantic search | This project | Session hooks query live DB instead of parsing markdown exports |
| Manual `/checkpoint` | PreCompact auto-save hooks | Claude Code hooks (2025) | Zero manual intervention for session continuity |
| No Discord capture | n8n webhook pipeline | Phase 5 | Thoughts captured passively from Discord |
| Individual MCP configs | mcp2cli centralized CLI | Rico's mcp2cli v0.2.0 | Single CLI for all 14+ MCP services |

**Deprecated/outdated:**
- `inject-brain-context.ts` reads flat file exports from `/Volumes/ThunderBolt/Exports/pai`. Should be replaced/augmented with live Open Brain session_load query.

## Open Questions

1. **MCP Session Handshake in n8n HTTP Request Node**
   - What we know: StreamableHTTPServerTransport requires initialize -> session ID -> tool call. n8n HTTP Request nodes can chain requests.
   - What's unclear: Whether the response header extraction (`mcp-session-id`) is straightforward in n8n's HTTP Request node. May need a Code node to parse headers.
   - Recommendation: Build the workflow and test. If header extraction is painful, consider adding a `POST /api/thoughts` REST endpoint to Open Brain that bypasses MCP protocol.

2. **PreCompact Hook Transcript Parsing**
   - What we know: The `transcript_path` field points to a JSONL file with the full conversation. Parsing this could provide a rich session summary.
   - What's unclear: How large the transcript is and whether parsing it in a 15s timeout is feasible.
   - Recommendation: Start with a simple summary (project + trigger + timestamp). Enhance later with transcript parsing if needed. The requirement says "active files, tasks, decisions, errors" -- this level of detail may require reading the transcript.

3. **mcp2cli HTTP Backend Session Support**
   - What we know: mcp2cli's HTTP backend connects to MCP servers. Open Brain uses StreamableHTTPServerTransport with session management.
   - What's unclear: Whether mcp2cli's HTTP backend properly handles the initialize -> session ID -> tool call flow with session headers.
   - Recommendation: Test with `mcp2cli open-brain --help` after registration. If it fails, may need to verify mcp2cli handles MCP session negotiation.

4. **Hook Placement: Global vs Project**
   - What we know: PreCompact and SessionStart hooks should apply to ALL projects (Open Brain is a universal brain).
   - What's unclear: Whether the hooks should go in `~/.claude/settings.json` (global) or project-level.
   - Recommendation: Global (`~/.claude/settings.json`). These hooks benefit every project, not just open-brain.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Bun test (built-in) |
| Config file | None -- Bun test works with zero config |
| Quick run command | `bun test` |
| Full suite command | `bun test` |

### Phase Requirements to Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INT-01 | mcp2cli returns tool list for open-brain | smoke | `mcp2cli open-brain --help` | N/A (CLI test) |
| INT-01 | search_brain returns results via mcp2cli | smoke | `mcp2cli open-brain search_brain --params '{"query":"test"}'` | N/A (CLI test) |
| INT-02 | Discord webhook triggers log_thought | integration | Manual -- send Discord message, verify in DB | N/A (manual) |
| INT-02 | n8n workflow executes successfully | smoke | `mcp2cli n8n n8n_test_workflow --params '{"workflowId":"<id>"}'` | N/A (CLI test) |
| SC-01 | PreCompact hook saves session | smoke | Manual -- run `/compact`, verify session in DB | N/A (manual) |
| SC-02 | SessionStart hook loads context | smoke | Manual -- start new session, verify context injected | N/A (manual) |

### Sampling Rate

- **Per task commit:** `bun test` (existing tests still pass -- no server code changes expected)
- **Per wave merge:** `bun test` + manual smoke tests for each consumer
- **Phase gate:** All consumers verified end-to-end

### Wave 0 Gaps

- [ ] No new test files needed in src/ -- Phase 5 is configuration/integration, not server code changes
- [ ] Smoke test checklist for manual verification of each consumer
- [ ] If REST endpoint added for n8n, needs unit test for the new route

## Sources

### Primary (HIGH confidence)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) -- Complete hook event list, PreCompact input schema, matcher patterns, command-only limitation for PreCompact/SessionStart
- mcp2cli `services.json` at `~/.config/mcp2cli/services.json` -- HTTP backend pattern from vaultwarden-secrets and homekit entries
- Open Brain source code: `src/transport.ts` (StreamableHTTPServerTransport session management), `src/auth.ts` (token-based auth), `src/tools/session-save.ts`, `src/tools/session-load.ts`
- `~/.claude/settings.json` -- Existing hook configuration (20+ hooks), confirming patterns for SessionStart/PreCompact integration
- n8n workflow list via mcp2cli -- Confirmed existing Discord workflows: "Skippy - Discord Classification", "Universal Capture v3", "Discord Interactions"

### Secondary (MEDIUM confidence)
- [Claude Code Hooks Guide 2026](https://dev.to/serenitiesai/claude-code-hooks-guide-2026-automate-your-ai-coding-workflow-dde) -- Additional hook examples and patterns
- [n8n Discord integration guide](https://www.eesel.ai/blog/discord-integrations-with-n8n) -- Webhook-based Discord trigger patterns

### Tertiary (LOW confidence)
- [GitHub Issue #13572](https://github.com/anthropics/claude-code/issues/13572) -- PreCompact hook reliability bug. Needs validation on current Claude Code version. Mitigated by also hooking Stop event as fallback.

## Metadata

**Confidence breakdown:**
- mcp2cli registration: HIGH -- proven pattern with 14 existing services, HTTP backend documented
- Claude Code hooks: HIGH -- official docs read, PreCompact schema verified, command-only limitation confirmed
- Discord/n8n integration: MEDIUM -- existing workflows confirm pattern works, but MCP session handshake in n8n untested
- Token management: HIGH -- openssl + vaultwarden is the standard PAI pattern
- Session continuity hooks: MEDIUM -- PreCompact has a known reliability bug; Stop event fallback mitigates

**Research date:** 2026-03-13
**Valid until:** 2026-04-13 (stable -- MCP protocol and hook API unlikely to change)
