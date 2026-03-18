---
phase: 5
slug: payments
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-18
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | bun test (built-in) |
| **Config file** | package.json `"test"` script |
| **Quick run command** | `bun test test/plugins/payments.test.ts` |
| **Full suite command** | `bun test` |
| **Estimated runtime** | ~12 seconds |

---

## Sampling Rate

- **After every task commit:** Run `bun test test/plugins/payments.test.ts`
- **After every plan wave:** Run `bun test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 5-01-01 | 05-01 | 1 | CONS-04 | unit | `bun test test/plugins/payments.test.ts --grep "create payment intent"` | ❌ W0 | ⬜ pending |
| 5-01-02 | 05-01 | 1 | CONS-04 | migration | `bun run db:migrate` | ✅ | ⬜ pending |
| 5-02-01 | 05-02 | 2 | CONS-05 | unit | `bun test test/plugins/payments.test.ts --grep "webhook"` | ❌ W0 | ⬜ pending |
| 5-02-02 | 05-02 | 2 | CONS-05 | unit | `bun test test/plugins/payments.test.ts --grep "idempotency"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/plugins/payments.test.ts` — stubs for CONS-04, CONS-05
- [ ] `.env.example` updated with `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CURRENCY`

*Existing bun test infrastructure covers framework; only test files need creation.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live Stripe checkout flow end-to-end | CONS-04 | Requires real Stripe test keys and frontend | Use Stripe test card 4242 4242 4242 4242, verify order transitions to confirmed |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
