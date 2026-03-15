// test/plugins/health.test.ts
import { describe, it, expect } from 'bun:test'
import { Elysia } from 'elysia'
import { healthPlugin } from '../../src/plugins/health/index'

// Isolated test app — does not require full index.ts
const testApp = new Elysia().use(healthPlugin)

describe('GET /health', () => {
  it('returns 200 without Authorization header (unprotected)', async () => {
    const res = await testApp.handle(new Request('http://localhost/health'))
    expect(res.status).toBe(200)
  })

  it('response body has status field set to ok or degraded', async () => {
    const res = await testApp.handle(new Request('http://localhost/health'))
    const body = await res.json() as { status: string; db: string; uptime: number }
    expect(['ok', 'degraded']).toContain(body.status)
  })

  it('response body has db field set to ok or degraded', async () => {
    const res = await testApp.handle(new Request('http://localhost/health'))
    const body = await res.json() as { status: string; db: string; uptime: number }
    expect(['ok', 'degraded']).toContain(body.db)
  })

  it('response body has uptime as a non-negative number', async () => {
    const res = await testApp.handle(new Request('http://localhost/health'))
    const body = await res.json() as { status: string; db: string; uptime: number }
    expect(typeof body.uptime).toBe('number')
    expect(body.uptime).toBeGreaterThanOrEqual(0)
  })
})
