# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.3.x | Yes |
| 1.2.x | Security fixes only |
| < 1.2 | No |

## Reporting a vulnerability

Report privately. Email albyte.inc@gmail.com. Do not open a public issue.

- Response within 48 hours
- Fix or mitigation within 90 days

Include in your report:

- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Suggested fix (optional)

## Disclosure timeline

- Day 0: vulnerability reported
- Day 2: acknowledgment sent
- Day 7: triage complete, severity assigned
- Day 30: fix in development
- Day 60: fix in testing
- Day 90: fix released, public disclosure

## Scope

**In scope**: runtime vulnerabilities in `src/`, input validation bypasses, memory leaks or resource exhaustion, race conditions, supply chain issues in runtime dependencies.

**Out of scope**: devDependency vulnerabilities (report to upstream), performance issues without security impact, social engineering, physical security.

## Built-in hardening

- Key sanitisation: rejects prototype pollution, control chars, CRLF, oversized keys
- Numeric input caps via `LIMITS`
- Per-key rate limiter policy
- Per-key bulkhead (concurrency limit)
- Circuit breaker for cascading failure prevention
- Error sanitisation: HTML entity escaping and control char stripping for audit logs
- Per-tenant store isolation via `createTenantStore()`
- Audit logging: every `act()` call logged with key, traceId, result, timestamp

## Dependency policy

- Zero runtime dependencies
- DevDependencies kept minimal (typescript, vitest, @types/node)
- `npm audit` must pass before release
- `package-lock.json` committed for reproducible installs
