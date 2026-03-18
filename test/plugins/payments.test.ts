// test/plugins/payments.test.ts
// Tests for CONS-04 (webhook flow), CONS-05 (idempotency), signature rejection
import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Elysia } from 'elysia'

const ORDER_UUID = '33333333-3333-3333-3333-333333333333'
const PI_ID = 'pi_test_abc123'

// Mock handlePaymentSucceeded
const mockHandlePaymentSucceeded = mock(async () => ({
  ok: true as const,
  orderId: ORDER_UUID
}))

// Mock stripe object with constructEventAsync
const mockConstructEventAsync = mock(async () => ({
  type: 'payment_intent.succeeded',
  data: {
    object: {
      id: PI_ID,
      metadata: { orderId: ORDER_UUID, customerId: 'user-1' }
    }
  }
}))

mock.module('../../src/plugins/payments/service', () => ({
  stripe: {
    webhooks: {
      constructEventAsync: mockConstructEventAsync
    }
  },
  handlePaymentSucceeded: mockHandlePaymentSucceeded
}))

const { paymentsPlugin } = await import('../../src/plugins/payments/index')
const testApp = new Elysia().use(paymentsPlugin)

beforeEach(() => {
  mockHandlePaymentSucceeded.mockClear()
  mockConstructEventAsync.mockClear()
  // Reset to default success behavior
  mockConstructEventAsync.mockImplementation(async () => ({
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: PI_ID,
        metadata: { orderId: ORDER_UUID, customerId: 'user-1' }
      }
    }
  }))
  mockHandlePaymentSucceeded.mockImplementation(async () => ({
    ok: true as const,
    orderId: ORDER_UUID
  }))
})

describe('POST /webhooks/stripe — signature verification (CONS-04)', () => {
  it('returns 400 when stripe-signature header is invalid', async () => {
    mockConstructEventAsync.mockImplementationOnce(async () => {
      throw new Error('No signatures found matching the expected signature')
    })
    const res = await testApp.handle(
      new Request('http://localhost/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': 'invalid_sig', 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'payment_intent.succeeded' })
      })
    )
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toBe('INVALID_SIGNATURE')
    expect(mockHandlePaymentSucceeded).not.toHaveBeenCalled()
  })

  it('returns 400 when stripe-signature is missing (constructEventAsync throws)', async () => {
    mockConstructEventAsync.mockImplementationOnce(async () => {
      throw new Error('No stripe-signature header value was provided')
    })
    const res = await testApp.handle(
      new Request('http://localhost/webhooks/stripe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
    )
    expect(res.status).toBe(400)
    expect(mockHandlePaymentSucceeded).not.toHaveBeenCalled()
  })
})

describe('POST /webhooks/stripe — payment_intent.succeeded (CONS-04)', () => {
  it('calls handlePaymentSucceeded and returns 200 with received: true', async () => {
    const res = await testApp.handle(
      new Request('http://localhost/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': 'valid_sig', 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'payment_intent.succeeded' })
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.received).toBe(true)
    expect(mockHandlePaymentSucceeded).toHaveBeenCalledTimes(1)
  })
})

describe('POST /webhooks/stripe — idempotency (CONS-05)', () => {
  it('returns 200 with duplicate: true when event already processed', async () => {
    mockHandlePaymentSucceeded.mockImplementationOnce(async () => ({
      ok: false as const,
      error: 'ALREADY_PROCESSED' as const
    }))
    const res = await testApp.handle(
      new Request('http://localhost/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': 'valid_sig', 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'payment_intent.succeeded' })
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.received).toBe(true)
    expect(body.duplicate).toBe(true)
  })
})

describe('POST /webhooks/stripe — unhandled event types', () => {
  it('returns 200 for unknown event types without calling handler', async () => {
    mockConstructEventAsync.mockImplementationOnce(async () => ({
      type: 'charge.refunded',
      data: { object: {} }
    }))
    const res = await testApp.handle(
      new Request('http://localhost/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': 'valid_sig', 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'charge.refunded' })
      })
    )
    expect(res.status).toBe(200)
    expect(mockHandlePaymentSucceeded).not.toHaveBeenCalled()
  })
})
