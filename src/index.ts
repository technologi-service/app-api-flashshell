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
import { startExpireOrdersJob } from './jobs/expire-orders'

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
        { name: 'payments', description: 'Stripe payment webhooks' },
        { name: 'websocket', description: 'Real-time WebSocket events — /ws/:channel' }
      ],
      // BearerAuth scheme — after sign-in, click "Authorize" in Swagger UI and paste the token
      components: {
        securitySchemes: {
          BearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'session-token',
            description: 'Paste the token returned by POST /api/auth/sign-in/email'
          }
        }
      },
      // Applied globally — all Elysia-generated routes show the lock icon.
      // Public routes (sign-up, sign-in, health, stripe webhook) override with security: [].
      security: [{ BearerAuth: [] }],
      // Better Auth routes are mounted via .mount() so Elysia cannot auto-generate them.
      // These path definitions are manual — they document the real Better Auth endpoints.
      paths: {
        '/api/auth/sign-up/email': {
          post: {
            tags: ['auth'],
            summary: 'Sign up',
            description: 'Create a new account. Role is always `customer` — use `bun run db:seed:roles` to create chef/delivery/admin test users.',
            security: [],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['email', 'password', 'name'],
                    properties: {
                      email:    { type: 'string', format: 'email', example: 'customer@test.com' },
                      password: { type: 'string', minLength: 8,    example: 'password123' },
                      name:     { type: 'string',                  example: 'Test Customer' }
                    }
                  }
                }
              }
            },
            responses: {
              '200': {
                description: 'Account created — session token in response body and Set-Cookie header.',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        token: { type: 'string', description: 'Copy this value and use it in the Authorize dialog above.' },
                        user: {
                          type: 'object',
                          properties: {
                            id:    { type: 'string' },
                            email: { type: 'string' },
                            name:  { type: 'string' },
                            role:  { type: 'string', enum: ['customer', 'chef', 'delivery', 'admin'], example: 'customer' }
                          }
                        }
                      }
                    }
                  }
                }
              },
              '422': { description: 'Validation error (missing fields, invalid email, etc.)' }
            }
          }
        },
        '/api/auth/sign-in/email': {
          post: {
            tags: ['auth'],
            summary: 'Sign in',
            description: '**Step 1 for E2E testing.** Returns a session token — copy it and paste it in the Authorize dialog (🔒) at the top of this page.',
            security: [],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['email', 'password'],
                    properties: {
                      email:    { type: 'string', format: 'email', example: 'chef@flashshell.test' },
                      password: { type: 'string',                  example: 'test-chef-pass' }
                    }
                  },
                  examples: {
                    customer: { summary: 'Customer',  value: { email: 'customer@test.com',      password: 'password123' } },
                    chef:     { summary: 'Chef',      value: { email: 'chef@flashshell.test',     password: 'test-chef-pass' } },
                    delivery: { summary: 'Delivery',  value: { email: 'delivery@flashshell.test', password: 'test-delivery-pass' } },
                    admin:    { summary: 'Admin',     value: { email: 'admin@flashshell.test',    password: 'test-admin-pass' } }
                  }
                }
              }
            },
            responses: {
              '200': {
                description: 'Authenticated — copy the `token` field and click 🔒 Authorize above.',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        token: { type: 'string', description: 'Session token — use as Bearer token for all protected routes.' },
                        user: {
                          type: 'object',
                          properties: {
                            id:    { type: 'string' },
                            email: { type: 'string' },
                            name:  { type: 'string' },
                            role:  { type: 'string', enum: ['customer', 'chef', 'delivery', 'admin'] }
                          }
                        }
                      }
                    }
                  }
                }
              },
              '401': { description: 'Invalid credentials' }
            }
          }
        },
        '/api/auth/get-session': {
          get: {
            tags: ['auth'],
            summary: 'Get current session',
            description: 'Verify your token is working — returns current user (including role) and session details.',
            responses: {
              '200': {
                description: 'Active session.',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        session: { type: 'object', properties: { id: { type: 'string' }, expiresAt: { type: 'string', format: 'date-time' } } },
                        user: {
                          type: 'object',
                          properties: {
                            id:    { type: 'string' },
                            email: { type: 'string' },
                            name:  { type: 'string' },
                            role:  { type: 'string', enum: ['customer', 'chef', 'delivery', 'admin'] }
                          }
                        }
                      }
                    }
                  }
                }
              },
              '401': { description: 'No active session' }
            }
          }
        },
        '/api/auth/sign-out': {
          post: {
            tags: ['auth'],
            summary: 'Sign out',
            description: 'Invalidates the current session token.',
            responses: {
              '200': { description: 'Signed out successfully.' }
            }
          }
        },
        '/ws/{channel}': {
          get: {
            tags: ['websocket'],
            summary: 'WebSocket — Real-time event stream',
            description: `**This is a WebSocket endpoint, not a regular HTTP route.** It cannot be tested from Swagger UI — use a WebSocket client (e.g. websocat, Postman, or browser JS).

## Connection

**Option 1 — Cookie (preferred, no security trade-off):**
Sign in with \`credentials: 'include'\` so the browser stores the session cookie. The WebSocket connection then authenticates automatically:
\`\`\`js
const ws = new WebSocket('ws://localhost:3001/ws/{channel}')
// Cookie is sent automatically — no token needed in the URL
\`\`\`

**Option 2 — Query param \`?token=\` (fallback for clients without cookie support):**
\`\`\`js
const ws = new WebSocket(\`ws://localhost:3001/ws/{channel}?token=<bearer-token>\`)
// ⚠ Token appears in server logs and browser history — use only when cookies are unavailable
\`\`\`

**Non-browser clients** (Postman, CLI tools) can use the Authorization header:
\`\`\`js
const ws = new WebSocket('ws://localhost:3001/ws/{channel}', {
  headers: { Authorization: 'Bearer <token>' }
})
\`\`\`

## Authentication
The server validates the session **before** the WebSocket upgrade via cookie, Authorization header, or \`?token=\` query param (checked in that order of preference). If no valid session is found, the connection is rejected with HTTP 401 — no WebSocket handshake occurs.

## Channels by role

| Channel | Role | Description |
|---------|------|-------------|
| \`order:{orderId}\` | customer | Track a specific order's status changes |
| \`kds\` | chef | Receive new confirmed orders in real time |
| \`logistics\` | delivery | Get notified when orders are ready for pickup |
| \`control\` | admin | Live dashboard feed (all order events) |

## Message format (server → client)
All messages are JSON with at least a \`channel\` and \`event\` field:
\`\`\`json
{
  "channel": "kds",
  "event": "new_order",
  "orderId": "uuid",
  "...": "event-specific data"
}
\`\`\`

## Client → server
The only supported client message is \`"ping"\` — the server replies \`"pong"\`. All business events are server-initiated via PostgreSQL LISTEN/NOTIFY.`,
            parameters: [
              {
                name: 'channel',
                in: 'path',
                required: true,
                description: 'Channel to subscribe to. Format: `order:{orderId}`, `kds`, `logistics`, or `control`.',
                schema: { type: 'string', example: 'kds' }
              },
              {
                name: 'token',
                in: 'query',
                required: false,
                description: 'Bearer session token as fallback for browser clients that cannot send Authorization headers. ⚠ Token will appear in server logs — prefer cookie auth when possible.',
                schema: { type: 'string' }
              }
            ],
            responses: {
              '101': { description: 'Switching Protocols — WebSocket connection established.' },
              '401': {
                description: 'Unauthorized — missing or invalid Bearer token. Connection rejected before WebSocket upgrade.',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        error:   { type: 'string', example: 'UNAUTHORIZED' },
                        message: { type: 'string', example: 'Valid authentication token required to open WebSocket connection' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
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
  .listen(3001, ({ hostname, port }) => {
    const baseUrl = `http://${hostname}:${port}`
    console.log(`✓ FlashShell Engine running at ${baseUrl}`)
    if (isDev) {
      console.log(`📖 Documentación: ${baseUrl}/openapi`)
    }
    startExpireOrdersJob()
  })

/**
 * Eden Treaty type export.
 * The frontend's src/lib/api.ts imports this type via the @backend/index path alias.
 * This is a type-only export — no runtime code is included in the frontend bundle.
 */
export type App = typeof app
