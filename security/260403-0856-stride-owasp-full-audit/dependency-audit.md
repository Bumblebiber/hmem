# Dependency Audit — hmem-mcp v6.0.2

**Date:** 2026-04-03
**Tool:** npm audit

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 4 |
| Medium | 0 |
| Low | 0 |

## Vulnerabilities

### 1. hono <=4.12.6 (4 advisories)

**Source:** Transitive dependency via `@modelcontextprotocol/sdk`

| Advisory | CVSS | Issue |
|----------|------|-------|
| GHSA-v8w9-8mx6-g223 | - | Prototype Pollution via `__proto__` key in parseBody({dot:true}) |
| GHSA-q5qw-h33p-qvwr | - | Arbitrary file access via serveStatic |
| GHSA-p6xx-57qc-3wxr | 6.5 | SSE Control Field Injection via CR/LF in writeSSE() |
| GHSA-5pq2-9x2x-5p6w | 5.4 | Cookie Attribute Injection via unsanitized domain/path |

**Fix:** `npm audit fix`

**Risk Assessment:** hmem uses MCP SDK via stdio transport only — hono's HTTP features are not directly exposed. Risk is indirect (MCP SDK could theoretically use hono internals).

### 2. @hono/node-server <1.19.10

| Advisory | CVSS | Issue |
|----------|------|-------|
| GHSA-wc8c-qw6v-h7f6 | 7.5 | Authorization bypass for protected static paths via encoded slashes |

**Fix:** `npm audit fix`

### 3. express-rate-limit 8.2.0-8.2.1

| Advisory | CVSS | Issue |
|----------|------|-------|
| GHSA-46wh-pxpv-q5gq | 7.5 | IPv4-mapped IPv6 addresses bypass per-client rate limiting |

**Fix:** `npm audit fix`

### 4. path-to-regexp 8.0.0-8.3.0

| Advisory | CVSS | Issue |
|----------|------|-------|
| GHSA-j3q9-mxjg-w52f | - | DoS via sequential optional groups |
| GHSA-27v5-c462-wpq7 | - | ReDoS via multiple wildcards |

**Fix:** `npm audit fix`

## Direct Dependencies

| Package | Version | Status |
|---------|---------|--------|
| @modelcontextprotocol/sdk | ^1.26.0 | Pulls vulnerable transitive deps |
| zod | ^4.3.6 | Clean |
| better-sqlite3 | ^12.6.2 (optional) | Clean |

## Recommendations

1. Run `npm audit fix` to update transitive dependencies
2. If MCP SDK doesn't release a fix, consider overriding hono version in package.json:
   ```json
   "overrides": {
     "hono": ">=4.12.7"
   }
   ```
3. Enable GitHub Dependabot alerts on the repository
