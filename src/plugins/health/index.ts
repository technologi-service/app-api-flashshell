// src/plugins/health/index.ts
// GET /health — UNPROTECTED (no authPlugin, no requireRole)
// Returns Neon connectivity status (SELECT 1 probe) and process uptime.
import { Elysia } from 'elysia'
import { db } from '../../db/client'
import { HealthResponse } from './model'

export const healthPlugin = new Elysia({ name: 'health', prefix: '/health' })
  .get('/', async () => {
    let dbStatus: 'ok' | 'degraded' = 'ok'
    try {
      // 3-second timeout so health check never hangs in degraded environments
      await Promise.race([
        db.execute('SELECT 1'),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('DB probe timeout')), 3000)
        )
      ])
    } catch {
      dbStatus = 'degraded'
    }
    return {
      status: dbStatus,
      db: dbStatus,
      uptime: process.uptime()
    }
  }, {
    response: HealthResponse,
    tags: ['health'],
    summary: 'Health check',
    description: 'Returns the server and database status. Probes Neon with `SELECT 1` (3 s timeout) — returns `degraded` if the probe fails. Safe to call without authentication; suitable for load-balancer liveness checks.',
    detail: { security: [] }
  })
