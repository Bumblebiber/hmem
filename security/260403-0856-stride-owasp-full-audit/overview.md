# Security Audit — stride-owasp-full-audit

**Date:** 2026-04-03 08:56
**Scope:** Full codebase (`src/**/*.ts`, `scripts/`, CI/CD, dependencies)
**Focus:** Comprehensive STRIDE + OWASP Top 10
**Iterations:** 15 (bounded)

## Summary

- **Total Findings:** 14
  - Critical: 0 | High: 5 | Medium: 7 | Low: 2 | Info: 0
- **STRIDE Coverage:** S[x] T[x] R[x] I[x] D[x] E[x] — 6/6
- **OWASP Coverage:** A01[x] A02[x] A03[x] A04[x] A05[x] A06[x] A07[x] A08[x] A09[x] A10[x] — 10/10
- **Confirmed:** 12 | Likely: 1 | Possible: 1

## Top 5 Findings

1. **[HIGH] Path Traversal in export_memory** — `output_path` allows writing to arbitrary filesystem locations ([findings.md#1](./findings.md))
2. **[HIGH] Path Traversal in import_memory** — `source_path` allows reading arbitrary SQLite files ([findings.md#2](./findings.md))
3. **[HIGH] Shell Injection in cli-checkpoint.ts** — `execSync` with string interpolation enables command injection ([findings.md#3](./findings.md))
4. **[HIGH] Shell Injection in cli-session-summary.ts** — Same `execSync` pattern ([findings.md#4](./findings.md))
5. **[HIGH] 4 Dependency Vulnerabilities** — hono, express-rate-limit, path-to-regexp via MCP SDK ([findings.md#5](./findings.md))

## Quick Fix Wins (< 30 min total)

| Fix | Effort | Impact |
|-----|--------|--------|
| `npm audit fix` | 2 min | Resolves all 4 dep vulns |
| Replace `execSync` → `execFileSync` | 15 min | Eliminates 2 shell injection vectors |
| Validate export/import paths | 20 min | Eliminates 2 path traversal vectors |
| Validate agent_name with regex | 5 min | Eliminates curator path traversal |

## Metric

```
metric = (10/10) * 50 + (6/6) * 30 + min(14, 20) = 50 + 30 + 14 = 94/100
```

## Coverage

```
=== Security Audit Complete (15 iterations) ===
STRIDE Coverage: S[x] T[x] R[x] I[x] D[x] E[x] — 6/6
OWASP Coverage:  A01[x] A02[x] A03[x] A04[x] A05[x] A06[x] A07[x] A08[x] A09[x] A10[x] — 10/10
Findings: 0 Critical, 5 High, 7 Medium, 2 Low
Confirmed: 12 | Likely: 1 | Possible: 1
```

## Files in This Report

- [Threat Model](./threat-model.md) — STRIDE analysis, assets, trust boundaries
- [Attack Surface Map](./attack-surface-map.md) — entry points, data flows, abuse paths
- [Findings](./findings.md) — all 14 findings ranked by severity
- [OWASP Coverage](./owasp-coverage.md) — per-category test results
- [Dependency Audit](./dependency-audit.md) — npm audit results
- [Recommendations](./recommendations.md) — prioritized mitigations with code snippets
- [Iteration Log](./security-audit-results.tsv) — raw data from every iteration

## Context

hmem-mcp is an MCP server running via stdio transport (single-agent, no HTTP). This significantly reduces the attack surface compared to a web application. The primary threat vectors are:

1. **Prompt injection** — A malicious prompt could instruct the agent to call `export_memory` or `import_memory` with crafted paths
2. **Multi-user risk** — If hmem is deployed on shared servers, the env-var auth and /tmp files become real attack vectors
3. **Supply chain** — Transitive dependencies from MCP SDK bring web-focused vulns that are likely not directly exploitable

The most impactful fixes are the path validation in export/import and replacing `execSync` with `execFileSync` — these are quick wins that eliminate the most serious vectors.
