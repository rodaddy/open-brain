#!/usr/bin/env bash
# Open Brain -- Token Reference & Verification Script
#
# Tokens are stored in vaultwarden under "Open Brain - Auth Tokens".
# This script retrieves and displays them for deployment to server .env.
#
# Usage:
#   ./scripts/generate-tokens.sh           # Show all tokens
#   ./scripts/generate-tokens.sh --verify  # Verify all tokens are present
#   ./scripts/generate-tokens.sh --rotate  # Generate new tokens (destructive)
#
# Roles: admin, agent, discord, ob-admin, readonly
# Server expects: AUTH_TOKEN_ADMIN, AUTH_TOKEN_AGENT, AUTH_TOKEN_DISCORD, AUTH_TOKEN_OB_ADMIN, AUTH_TOKEN_READONLY
#
# #168: the vaultwarden secret field "Open Brain - Auth Tokens" -> AUTH_TOKEN_N8N
# must be renamed to AUTH_TOKEN_OB_ADMIN as a deploy-time step (see PR body).
# This script reads the new field name; run it only after the vault field rename.

set -euo pipefail

VAULT_NAME="Open Brain - Auth Tokens"
ROLES=("ADMIN" "AGENT" "DISCORD" "OB_ADMIN" "READONLY")

fetch_tokens() {
  mcp2cli vaultwarden-secrets get_secret_fields \
    --params "{\"name\":\"${VAULT_NAME}\"}" 2>/dev/null
}

show_tokens() {
  local result
  result=$(fetch_tokens)

  if [[ -z "$result" ]] || echo "$result" | jq -e '.error' &>/dev/null; then
    echo "ERROR: Could not retrieve tokens from vaultwarden" >&2
    echo "Ensure '${VAULT_NAME}' exists in vaultwarden." >&2
    exit 1
  fi

  echo "# Open Brain Auth Tokens"
  echo "# Copy these to your server's .env file"
  echo ""
  for role in "${ROLES[@]}"; do
    local key="AUTH_TOKEN_${role}"
    local val
    val=$(echo "$result" | jq -r ".result.${key} // empty")
    if [[ -n "$val" ]]; then
      echo "${key}=${val}"
    else
      echo "# MISSING: ${key}" >&2
    fi
  done
}

verify_tokens() {
  local result
  result=$(fetch_tokens)
  local missing=0

  echo "Verifying tokens in vaultwarden..."
  for role in "${ROLES[@]}"; do
    local key="AUTH_TOKEN_${role}"
    local val
    val=$(echo "$result" | jq -r ".result.${key} // empty")
    if [[ -n "$val" ]]; then
      echo "  OK: ${key} (${#val} chars)"
    else
      echo "  MISSING: ${key}" >&2
      missing=$((missing + 1))
    fi
  done

  if [[ $missing -gt 0 ]]; then
    echo ""
    echo "FAIL: ${missing} token(s) missing"
    exit 1
  else
    echo ""
    echo "ALL tokens present and retrievable"
  fi
}

rotate_tokens() {
  echo "Generating new tokens for all roles..."
  echo "WARNING: This will invalidate all existing tokens!"
  echo ""
  read -rp "Continue? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 0
  fi

  local fields="{"
  for role in "${ROLES[@]}"; do
    local key="AUTH_TOKEN_${role}"
    local token
    token=$(openssl rand -hex 32)
    if [[ "$fields" != "{" ]]; then fields+=","; fi
    fields+="\"${key}\":\"${token}\""
  done
  fields+="}"

  mcp2cli vaultwarden-secrets update_secret \
    --params "{\"name\":\"${VAULT_NAME}\",\"fields\":${fields}}" 2>/dev/null

  echo "Tokens rotated. Run with --verify to confirm."
  echo "IMPORTANT: Redeploy server .env and restart the service."
}

case "${1:-}" in
  --verify)
    verify_tokens
    ;;
  --rotate)
    rotate_tokens
    ;;
  *)
    show_tokens
    ;;
esac
