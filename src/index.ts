// src/index.ts
// RULE: This file mounts plugins only. No routes, no business logic, no DB queries.
// All domain logic lives in src/plugins/ subdirectories.
// Plugin registration order matters in Elysia — onError must be registered before plugins.
import { Elysia } from 'elysia'
import { authPlugin } from './plugins/auth/index'
import { healthPlugin } from './plugins/health/index'
import { wsPlugin } from './plugins/ws/index'
import { consumerPlugin } from './plugins/consumer/index'
import { kdsPlugin } from './plugins/kds/index'

const app = new Elysia()
  .onError(({ code, error, set }) => {
    if (code === 'VALIDATION') {
      set.status = 422
      return {
        error: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: (error as any).all ?? []
      }
    }
    if (code === 'NOT_FOUND') {
      set.status = 404
      return { error: 'NOT_FOUND', message: 'Resource not found' }
    }
    console.error('[server-error]', error)
    set.status = 500
    return { error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }
    // IMPORTANT: Never expose (error as any).stack in production responses
  })
  .use(authPlugin)    // Better Auth at /auth/**, session macro available to all child plugins
  .use(healthPlugin)  // GET /health — unprotected
  .use(wsPlugin)      // WebSocket at /ws/:channel — auth-gated
  .use(consumerPlugin)
  .use(kdsPlugin)
  // Phase 3+ plugins registered here: .use(logisticsPlugin), etc.
  .listen(3000)

console.log(`FlashShell Engine running at ${app.server?.hostname}:${app.server?.port}`)

/**
 * Eden Treaty type export.
 * The frontend's src/lib/api.ts imports this type via the @backend/index path alias.
 * This is a type-only export — no runtime code is included in the frontend bundle.
 */
export type App = typeof app
