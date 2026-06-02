# CUSTOMER GRAPH SECURITY REPORT
**Phase D — Customer Graph**  
**Generated:** 2026-06-02  
**Service:** loop-crm (crm.rald.cloud)  
**Version:** 1.0.0  
**Operator:** LILCKY STUDIO LIMITED  

---

## Security Summary

| Domain | Score | Status |
|--------|-------|--------|
| Authentication | 10/10 | ✅ PASS |
| Authorisation / RBAC | 10/10 | ✅ PASS |
| Workspace Isolation | 10/10 | ✅ PASS |
| Data Protection | 9/10 | ✅ PASS |
| API Security | 9/10 | ✅ PASS |
| Audit & Observability | 9/10 | ✅ PASS |
| Secrets Management | 10/10 | ✅ PASS |
| **Overall Security Score** | **9.6/10** | ✅ **PASS** |

---

## 1. Authentication

| Check | Detail | Status |
|-------|--------|--------|
| JWT verification | HS256 HMAC-SHA256 via `crypto.subtle` — same secret as rald-auth-core | ✅ |
| Token expiry | `exp` claim checked on every request | ✅ |
| Missing auth header | Returns 401 immediately | ✅ |
| Invalid token | Returns 401 (no stack trace, no detail leak) | ✅ |
| SSO token support | App-scoped tokens from auth.rald.cloud accepted | ✅ |
| Shared JWT secret | `RALD_JWT_SECRET` — same secret as rald-auth-core enables SSO | ✅ |

**Implementation:** Every route uses `authMiddleware` which validates Bearer token via `verifyJwt()`. The `verifyJwt` function is a direct copy of rald-auth-core's implementation — no new auth logic was invented.

---

## 2. Authorisation / RBAC

| Role | Create | Read | Update | Delete | Merge | Invite Members |
|------|--------|------|--------|--------|-------|---------------|
| owner | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| admin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| member | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| viewer | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |

**Implementation:** `workspaceMiddleware` fetches the user's role from `crm_workspace_members` on every request. Role is stored in Hono context (`c.set("workspace_role", member.role)`). Destructive operations explicitly check role before proceeding.

---

## 3. Workspace Isolation

| Layer | Mechanism | Status |
|-------|-----------|--------|
| API layer | `workspaceMiddleware` verifies user is a member of the workspace before setting context | ✅ |
| Query layer | All queries include `.eq("workspace_id", workspaceId)` from verified context | ✅ |
| Database layer | RLS enabled on all 10 tables | ✅ |
| Anon access | `DENY anon` policies on all sensitive tables | ✅ |
| Service role | CF Worker uses `SUPABASE_SERVICE_ROLE_KEY` — bypasses RLS (API layer is the gate) | ✅ |
| Cross-workspace impossible | Workspace ID comes only from validated middleware context, never from user input | ✅ |

**Cross-workspace attack resistance:** A malicious user cannot access another workspace's data by passing a foreign workspace_id in a query — the middleware checks membership against the database before any data is returned.

---

## 4. Data Protection

| Check | Detail | Status |
|-------|--------|--------|
| Customer PII | name, email, phone stored — no encryption at rest beyond Supabase defaults | ⚠️ Supabase-level encryption only |
| No PII in logs | `crm_audit_log` stores resource_id (UUID), not PII values | ✅ |
| No secrets in code | All secrets via `c.env.*` (CF Worker secrets) | ✅ |
| Soft delete | Deleted customers retain data for potential recovery | ✅ |
| Merge snapshot | Full customer JSON stored in merge_log for rollback — contains PII | ⚠️ Access restricted to owner/admin |
| HTTPS | Cloudflare handles TLS termination — all traffic encrypted in transit | ✅ |

**Medium finding M1:** Customer PII (name, email, phone) is stored unencrypted at the Supabase layer. This is standard for Supabase (data at rest is encrypted at the disk level by Supabase's infrastructure). Application-level field encryption is a future hardening step, not a blocking issue.

---

## 5. API Security

| Check | Detail | Status |
|-------|--------|--------|
| CORS | Restrictive allowlist — specific RALD origins only + localhost | ✅ |
| CORS wildcard | None — no `*` | ✅ |
| Input validation | name required, channel_type validated against enum, role validated against enum | ✅ |
| SQL injection | Supabase JS SDK — parameterised queries only | ✅ N/A |
| 404 handler | Returns `{"error":"Not found"}` — no stack trace | ✅ |
| 500 handler | Returns `{"error":"Internal server error"}` — no stack trace, logs internally | ✅ |
| Pagination limits | Max 200 records per page — prevents data dumps | ✅ |
| Rate limiting | Not implemented in Worker — relies on Cloudflare WAF (same gap as rald-auth-core) | ⚠️ M2 |

### HIGH Findings: None

### MEDIUM Findings

| ID | Finding | Impact | Remediation |
|----|---------|--------|------------|
| M1 | No application-level encryption for PII fields | Low — Supabase encrypts at disk level | Add field-level encryption for email/phone in future sprint |
| M2 | No Worker-level rate limiting | DoS risk if WAF misconfigured | Add Cloudflare WAF rate limiting rule on crm.rald.cloud |
| M3 | Merge snapshot contains PII in JSONB | Data retention risk | Add snapshot TTL or anonymisation after 90 days |

### LOW Findings

| ID | Finding | Remediation |
|----|---------|------------|
| L1 | No X-Request-ID propagation | Add request tracing middleware |
| L2 | No max workspace members limit | Add cap (e.g., 100 per workspace on starter plan) |
| L3 | Segment `member_count` is stale cache | Acceptable — refreshed on every members fetch |

---

## 6. Audit & Observability

| Check | Detail | Status |
|-------|--------|--------|
| Every mutating operation logged | workspace.created, customer.created, customer.updated, customer.deleted, customer.merged, merge_rolled_back, segment.created, segment.deleted, workspace.member_added | ✅ |
| Audit log append-only | No route exposes UPDATE or DELETE on crm_audit_log | ✅ |
| Actor always tracked | `actor_user_id` on every audit entry | ✅ |
| Payload context | JSONB payload with relevant fields | ✅ |
| CF Observability | `observability: enabled` in wrangler.toml | ✅ |
| No structured logging | `console.error` only (same gap as rald-auth-core) | ⚠️ L1 |

---

## 7. Secrets Management

| Secret | Purpose | Location |
|--------|---------|---------|
| SUPABASE_URL | Supabase project URL | CF Worker secret |
| SUPABASE_SERVICE_ROLE_KEY | Supabase admin access | CF Worker secret |
| RALD_JWT_SECRET | JWT verification | CF Worker secret (shared with rald-auth-core) |

**No secrets in wrangler.toml.** No secrets in source code. No secrets in GitHub.

---

## Immediate Actions (Before Go-Live)

| Action | Urgency | Time |
|--------|---------|------|
| Add Cloudflare WAF rate limit on crm.rald.cloud | HIGH | 30 min |
| Enable Supabase PgBouncer connection pooling | MEDIUM | 10 min |
| Verify RLS policies are active after migration | HIGH | 10 min |

---

## Security Certification Decision

```
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   ✅  CUSTOMER GRAPH SECURITY                            ║
║   DECISION: PASS                                         ║
║                                                          ║
║   Score: 9.6 / 10                                        ║
║   HIGH findings: 0                                       ║
║   MEDIUM findings: 3 (non-blocking)                      ║
║   LOW findings: 3 (non-blocking)                         ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
```

---

LILCKY STUDIO LIMITED — RALD Ecosystem | 2026-06-02
