# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 1.2.x   | Security fixes only|
| < 1.2   | Not supported      |

## Reporting a Vulnerability

Report vulnerabilities privately.

- Email: security@example.com
- Do not open a public issue
- Response within 48 hours
- Fix or mitigation within 90 days

Include in your report:
- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Suggested fix (optional)

## Disclosure Timeline

1. **Day 0**: Vulnerability reported
2. **Day 2**: Acknowledgment sent
3. **Day 7**: Triage complete, severity assigned
4. **Day 30**: Fix in development
5. **Day 60**: Fix in testing
6. **Day 90**: Fix released, public disclosure

## Scope

### In Scope
- Runtime vulnerabilities in `src/`
- Input validation bypasses
- Memory leaks or resource exhaustion
- Race conditions
- Supply chain issues in runtime dependencies

### Out of Scope
- DevDependency vulnerabilities (report to upstream)
- Performance issues without security impact
- Social engineering attacks
- Physical security

## Hardening Features

The following security features are built in:

- **Key sanitization**: Rejects prototype pollution, control chars, CRLF, oversized keys
- **Numeric input caps**: All numeric inputs bounded by `LIMITS`
- **Rate limiting**: Per-key rate limiter policy
- **Bulkhead**: Per-key concurrency limiting
- **Circuit breaker**: Cascading failure prevention
- **Error sanitization**: HTML entity escaping + control char stripping for audit logs
- **Tenant isolation**: Per-tenant store management via `createTenantStore()`
- **Audit logging**: Every `act()` call logged with key, traceId, result, timestamp

## Dependency Policy

- Zero runtime dependencies
- DevDependencies kept minimal (typescript, vitest, @types/node)
- `npm audit` must pass before release
- `package-lock.json` committed for reproducible installs
