---
phase: 3
slug: logistics
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-18
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Bun test (built-in) |
| **Config file** | none — `bun test` discovers `test/**/*.test.ts` automatically |
| **Quick run command** | `bun test test/plugins/logistics.test.ts test/plugins/couriers.test.ts` |
| **Full suite command** | `bun test` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `bun test test/plugins/logistics.test.ts test/plugins/couriers.test.ts`
- **After every plan wave:** Run `bun test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 3-01-01 | 01 | 0 | LOGI-01, LOGI-02, LOGI-03, LOGI-04 | unit stubs | `bun test test/plugins/logistics.test.ts test/plugins/couriers.test.ts` | ❌ W0 | ⬜ pending |
| 3-01-02 | 01 | 1 | LOGI-01, LOGI-04 | unit | `bun test test/plugins/logistics.test.ts` | ❌ W0 | ⬜ pending |
| 3-01-03 | 01 | 1 | LOGI-04 | unit + integration | `bun test test/plugins/logistics.test.ts test/integration/logistics-concurrency.test.ts` | ❌ W0 | ⬜ pending |
| 3-02-01 | 02 | 2 | LOGI-02, LOGI-03 | unit | `bun test test/plugins/couriers.test.ts` | ❌ W0 | ⬜ pending |
| 3-02-02 | 02 | 2 | LOGI-02, LOGI-03 | unit | `bun test test/plugins/couriers.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/plugins/logistics.test.ts` — stubs for LOGI-01, LOGI-04
- [ ] `test/plugins/couriers.test.ts` — stubs for LOGI-02, LOGI-03
- [ ] `test/integration/logistics-concurrency.test.ts` — concurrent assignment race for LOGI-04

*No new framework install needed — bun:test is already in use.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Customer sees live GPS updates in real WebSocket session | LOGI-03 | End-to-end WebSocket stream is complex to automate without a browser client | Connect WS client to `/ws`, subscribe to `order:{id}`, push GPS coordinates, verify event received |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
