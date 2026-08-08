---
lane: security
order: 30
---
## PR #421 — validation errors quoting a credential-bearing URL

Severity: MEDIUM. Status: fixed in `0d110f1`. Provenance: PR #421, security lane.

`urlsplit` accepts userinfo, so `http://alice:supersecret@example.com` is a valid
base URL. Every validation branch quoted the offending value with `{value!r}`, so
a malformed secret-bearing `OPENBRAIN_BASE_URL` raised a `ConfigError` containing
the cleartext password.

Config errors at boot are precisely the strings that get printed to a terminal,
captured by a service manager, or pasted into a bug report. New validation is a
new disclosure surface: the code was added in the same PR to *improve* security.

Two implementation notes worth reusing. Redaction must operate on the raw string,
not parsed attributes, because it is called exactly when the value is too
malformed to parse — and reading `parsed.port` itself raises on the invalid-port
case being reported. And redaction must preserve the host, or an operator with
several configured URLs cannot tell which one was rejected.

### Review Questions

- Does any error message, log line, or exception interpolate a whole
  configuration value? Check whether that value can carry userinfo, a token, a
  query-string secret, or a DSN password.
- Does the redaction helper survive the malformed input it exists to handle, or
  does it assume a parseable value?
- Does redaction leave enough context to identify *which* value failed?
- Are secret-bearing fields redacted on **every** branch, or only the one that
  prompted the fix? Grep for the raw variable across all raise sites.
