// src/plugins/health/index.ts
// GET /health — UNPROTECTED (no authPlugin, no requireRole)
// Returns Neon connectivity status (SELECT 1 probe) and process uptime.
// Required by Phase 1 success criteria item 1.
import { Elysia } from 'elysia'
import { db } from '../../db/client'

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
  })
