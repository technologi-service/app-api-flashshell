// src/plugins/ws/index.ts
// WebSocket hub plugin — /ws/:channel
// Authentication: Bearer token verified in beforeHandle before WS upgrade.
// If beforeHandle returns a non-2xx status, Elysia prevents the WS upgrade.
// Channel topology (from CONTEXT.md):
//   order:{orderId}  — consumer order tracking
//   kds              — chef broadcast
//   logistics        — delivery broadcast
//   control          — admin broadcast
import { Elysia } from 'elysia'
import { auth } from '../auth/better-auth'
import { startListener, registerSocket, unregisterSocket } from './listener'

export const wsPlugin = new Elysia({ name: 'ws-hub', prefix: '/ws' })
  .ws('/:channel', {
    async beforeHandle({ request, status }) {
      // Use request.headers (native Headers object) — Elysia's context `headers`
      // is a plain object that Better Auth's getSession() does not accept.
      //
      // Browsers cannot send custom headers in native WebSocket connections.
      // Fallback: accept the session token via ?token= query param.
      // Security trade-off: tokens in URLs appear in server logs and browser history.
      // Prefer cookie-based auth (sign-in with credentials:'include') when possible.
      let authHeaders = request.headers

      if (!request.headers.get('authorization')) {
        const tokenFromQuery = new URL(request.url).searchParams.get('token')
        if (tokenFromQuery) {
          authHeaders = new Headers(request.headers)
          authHeaders.set('authorization', `Bearer ${tokenFromQuery}`)
        }
      }

      const session = await auth.api.getSession({ headers: authHeaders })
      if (!session) return status(401, {
        error: 'UNAUTHORIZED',
        message: 'Valid authentication token required to open WebSocket connection'
      })
    },
    open(ws) {
      const channel = ws.data.params.channel
      registerSocket(channel, ws)
      ws.send(JSON.stringify({ event: 'connected', channel, message: `Subscribed to ${channel}` }))
      console.log(`[ws-hub] Client joined channel: ${channel}`)
    },
    close(ws) {
      const channel = ws.data.params.channel
      unregisterSocket(channel, ws)
      console.log(`[ws-hub] Client left channel: ${channel}`)
    },
    message(ws, message) {
      // Clients may send pings; echo to keep connection alive.
      // Business events are server-initiated via pg_notify — clients do not publish here.
      if (message === 'ping') ws.send('pong')
    }
  })

// Start the LISTEN/NOTIFY hub when this plugin is first loaded
startListener()
