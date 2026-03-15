---
phase: 1
slug: foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-15
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | bun test (built-in) |
| **Config file** | `package.json` (test script) |
| **Quick run command** | `bun test` |
| **Full suite command** | `bun test --coverage` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `bun test`
- **After every plan wave:** Run `bun test --coverage`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 1-01-01 | 01 | 1 | INFRA-01 | migration | `bun run db:migrate` | ❌ W0 | ⬜ pending |
| 1-01-02 | 01 | 1 | INFRA-01 | unit | `bun test src/db` | ❌ W0 | ⬜ pending |
| 1-02-01 | 02 | 2 | INFRA-02 | integration | `bun test src/auth` | ❌ W0 | ⬜ pending |
| 1-02-02 | 02 | 2 | INFRA-03 | integration | `bun test src/middleware` | ❌ W0 | ⬜ pending |
| 1-03-01 | 03 | 3 | INFRA-04 | integration | `bun test src/ws` | ❌ W0 | ⬜ pending |
| 1-03-02 | 03 | 3 | INFRA-05 | e2e | `bun test src/health` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/db/client.test.ts` — stubs for INFRA-01 (Drizzle connection, migration idempotency)
- [ ] `src/auth/auth.test.ts` — stubs for INFRA-02 (Better Auth session, 401 on missing token)
- [ ] `src/middleware/role.test.ts` — stubs for INFRA-03 (403 on wrong role)
- [ ] `src/ws/hub.test.ts` — stubs for INFRA-04 (LISTEN/NOTIFY hub connects, logs events)
- [ ] `src/health/health.test.ts` — stubs for INFRA-05 (GET /health returns 200)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| LISTEN/NOTIFY latency < 1s | INFRA-04 | Requires live Neon psql session | Run `NOTIFY test_channel` in psql, observe hub logs within 1s |
| WS upgrade blocked on 401 | INFRA-02 | WebSocket HTTP upgrade behavior varies | Hit WS endpoint without token, confirm HTTP 401 before upgrade |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
