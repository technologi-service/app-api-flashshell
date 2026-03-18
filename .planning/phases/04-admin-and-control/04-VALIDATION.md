---
phase: 4
slug: admin-and-control
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-18
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | bun test (built-in) |
| **Config file** | package.json `"test"` script |
| **Quick run command** | `bun test test/plugins/control.test.ts` |
| **Full suite command** | `bun test` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `bun test test/plugins/control.test.ts`
- **After every plan wave:** Run `bun test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 4-01-01 | 04-01 | 1 | CTRL-03 | unit | `bun test test/plugins/control.test.ts --grep "active orders"` | ❌ W0 | ⬜ pending |
| 4-01-02 | 04-01 | 1 | CTRL-04 | unit | `bun test test/plugins/control.test.ts --grep "cashflow"` | ❌ W0 | ⬜ pending |
| 4-02-01 | 04-02 | 2 | CTRL-01 | integration | `bun test test/integration/stock-trigger.test.ts` | ❌ W0 | ⬜ pending |
| 4-02-02 | 04-02 | 2 | CTRL-02 | integration | `bun test test/integration/low-stock-alert.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/plugins/control.test.ts` — stubs for CTRL-03, CTRL-04
- [ ] `test/integration/stock-trigger.test.ts` — stubs for CTRL-01
- [ ] `test/integration/low-stock-alert.test.ts` — stubs for CTRL-02

*Existing bun test infrastructure covers framework; only test files need creation.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| WebSocket alert arrives < 2s after stock drop | CTRL-02 | Timing guarantee requires real network | Connect WS client to /ws/control, trigger stock deduction via SQL UPDATE, observe alert latency |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
