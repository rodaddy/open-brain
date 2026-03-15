#!/usr/bin/env bash
# Fetch secrets from vaultwarden for Open Brain
# Called by varlock via: @secret(exec(./fetch-secrets.sh FIELD))

set +e

FIELD="$1"

case "$FIELD" in
  DB_PASSWORD)
    mcp2cli vaultwarden-secrets get_credential --params '{"query":"PostgreSQL - Open Brain"}' 2>/dev/null | jq -r '.result.fields.password // empty'
    ;;
  AUTH_TOKEN_ADMIN)
    mcp2cli vaultwarden-secrets get_secret_fields --params '{"name":"Open Brain - Auth Tokens"}' 2>/dev/null | jq -r '.result.AUTH_TOKEN_ADMIN // empty'
    ;;
  AUTH_TOKEN_AGENT)
    mcp2cli vaultwarden-secrets get_secret_fields --params '{"name":"Open Brain - Auth Tokens"}' 2>/dev/null | jq -r '.result.AUTH_TOKEN_AGENT // empty'
    ;;
  AUTH_TOKEN_DISCORD)
    mcp2cli vaultwarden-secrets get_secret_fields --params '{"name":"Open Brain - Auth Tokens"}' 2>/dev/null | jq -r '.result.AUTH_TOKEN_DISCORD // empty'
    ;;
  AUTH_TOKEN_N8N)
    mcp2cli vaultwarden-secrets get_secret_fields --params '{"name":"Open Brain - Auth Tokens"}' 2>/dev/null | jq -r '.result.AUTH_TOKEN_N8N // empty'
    ;;
  AUTH_TOKEN_READONLY)
    mcp2cli vaultwarden-secrets get_secret_fields --params '{"name":"Open Brain - Auth Tokens"}' 2>/dev/null | jq -r '.result.AUTH_TOKEN_READONLY // empty'
    ;;
  LITELLM_API_KEY)
    mcp2cli vaultwarden-secrets get_credential --params '{"query":"LiteLLM"}' 2>/dev/null | jq -r '.result.fields.password // empty'
    ;;
  *)
    echo "Unknown field: $FIELD" >&2
    exit 1
    ;;
esac
