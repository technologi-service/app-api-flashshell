// src/index.ts
// RULE: This file mounts plugins only. No routes, no business logic, no DB queries.
// All domain logic lives in src/plugins/ subdirectories.
// Plugin registration order matters in Elysia — onError must be registered before plugins.
import { Elysia } from 'elysia'
import { openapi } from '@elysiajs/openapi'
import { cors } from '@elysiajs/cors'
import { authPlugin } from './plugins/auth/index'
import { healthPlugin } from './plugins/health/index'
import { wsPlugin } from './plugins/ws/index'
import { consumerPlugin } from './plugins/consumer/index'
import { kdsPlugin } from './plugins/kds/index'
import { logisticsPlugin } from './plugins/logistics/index'
import { couriersPlugin } from './plugins/couriers/index'
import { controlPlugin } from './plugins/control/index'
import { paymentsPlugin } from './plugins/payments/index'

const isDev = process.env.NODE_ENV !== 'production'

// CORS origins from env — supports comma-separated list for multiple frontends
const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

const app = new Elysia()
  .use(cors({
    origin: corsOrigins,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  }))
  .use(openapi({
    enabled: isDev,
    documentation: {
      info: {
        title: 'FlashShell Engine API',
        version: '0.1.0',
        description: 'Dark Kitchen order pipeline API — only visible in development'
      },
      tags: [
        { name: 'auth', description: 'Authentication (Better Auth) — /api/auth/*' },
        { name: 'health', description: 'Server health' },
        { name: 'consumer', description: 'Consumer order endpoints' },
        { name: 'kds', description: 'Kitchen Display System endpoints' },
        { name: 'logistics', description: 'Courier delivery logistics' },
        { name: 'couriers', description: 'Courier GPS tracking' },
        { name: 'control', description: 'Admin order dashboard and reports' },
        { name: 'payments', description: 'Stripe payment webhooks' }
      ]
    }
  }))
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
  .use(authPlugin)    // Better Auth at /api/auth/**, session macro available to all child plugins
  .use(healthPlugin)  // GET /health — unprotected
  .use(wsPlugin)      // WebSocket at /ws/:channel — auth-gated
  .use(consumerPlugin)
  .use(kdsPlugin)
  .use(logisticsPlugin)
  .use(couriersPlugin)
  .use(controlPlugin)
  .use(paymentsPlugin)   // POST /webhooks/stripe — no auth (Stripe calls directly)
  .listen(3000)

console.log(`FlashShell Engine running at ${app.server?.hostname}:${app.server?.port}`)

/**
 * Eden Treaty type export.
 * The frontend's src/lib/api.ts imports this type via the @backend/index path alias.
 * This is a type-only export — no runtime code is included in the frontend bundle.
 */
export type App = typeof app
