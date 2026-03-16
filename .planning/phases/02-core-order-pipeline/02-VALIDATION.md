---
phase: 2
slug: core-order-pipeline
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-16
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | bun:test |
| **Config file** | `package.json` (scripts.test) |
| **Quick run command** | `bun test --testPathPattern="consumer\|kds\|ws"` |
| **Full suite command** | `bun test` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `bun test --testPathPattern="consumer\|kds\|ws"`
- **After every plan wave:** Run `bun test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 0 | CONS-01 | migration | `bun run db:migrate && bun test --testPathPattern="migration"` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 1 | CONS-01 | integration | `bun test --testPathPattern="consumer.menu"` | ❌ W0 | ⬜ pending |
| 02-01-03 | 01 | 1 | CONS-02, CONS-03 | integration | `bun test --testPathPattern="consumer.orders"` | ❌ W0 | ⬜ pending |
| 02-01-04 | 01 | 1 | CONS-03 | concurrency | `bun test --testPathPattern="consumer.orders.race"` | ❌ W0 | ⬜ pending |
| 02-02-01 | 02 | 1 | KDS-01, KDS-02 | integration | `bun test --testPathPattern="kds.orders"` | ❌ W0 | ⬜ pending |
| 02-02-02 | 02 | 1 | KDS-03, KDS-04 | integration | `bun test --testPathPattern="kds.items"` | ❌ W0 | ⬜ pending |
| 02-02-03 | 02 | 1 | KDS-05, CONS-06 | integration | `bun test --testPathPattern="kds.menu"` | ❌ W0 | ⬜ pending |
| 02-03-01 | 03 | 2 | CONS-07, KDS-01 | integration | `bun test --testPathPattern="ws"` | ❌ W0 | ⬜ pending |
| 02-03-02 | 03 | 2 | KDS-03, CONS-07 | integration | `bun test --testPathPattern="ws.status"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/consumer/consumer.test.ts` — stubs for CONS-01, CONS-02, CONS-03, CONS-06, CONS-07
- [ ] `src/kds/kds.test.ts` — stubs for KDS-01, KDS-02, KDS-03, KDS-04, KDS-05
- [ ] `src/ws/ws.test.ts` — stubs for WebSocket channel integration
- [ ] DB migration for `item_status` pgEnum column applied before tests run
- [ ] Test helper for creating authenticated test requests (customer + chef roles)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| WebSocket push latency < 500ms | KDS-01 | Timing measurement requires live environment | Connect WS client, POST order, measure time-to-receipt |
| Concurrent stock reservation (2 requests, 1 success) | CONS-03 | Race condition needs real DB concurrency | Send 2 simultaneous requests for last stock unit; verify exactly 1 success |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
