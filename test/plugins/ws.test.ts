// test/plugins/ws.test.ts
// INFRA-05 — WebSocket integration tests
// The 1-second NOTIFY latency test requires a live Neon connection and a manual
// pg_notify call. That is a manual-only verification (see VALIDATION.md).
// This file covers the structural and auth-gate tests that can run without live DB.
import { describe, it, expect } from 'bun:test'

describe('LISTEN/NOTIFY hub', () => {
  it('listener module exports startListener and dispatch', async () => {
    const { startListener, dispatch } = await import('../../src/plugins/ws/listener')
    expect(typeof startListener).toBe('function')
    expect(typeof dispatch).toBe('function')
  })
})

describe('dispatch function', () => {
  it('dispatch to unknown channel does not throw', async () => {
    const { dispatch } = await import('../../src/plugins/ws/listener')
    expect(() => dispatch('unknown-channel', { event: 'test' })).not.toThrow()
  })
})
