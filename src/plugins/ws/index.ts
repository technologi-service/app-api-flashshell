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
    async beforeHandle({ headers, status }) {
      // Verify Bearer token before the WebSocket upgrade handshake.
      // Returning a status response here aborts the upgrade with HTTP 401.
      const session = await auth.api.getSession({ headers })
      if (!session) return status(401, {
        error: 'UNAUTHORIZED',
        message: 'Valid authentication token required to open WebSocket connection'
      })
      // NOTE: Open question from 01-RESEARCH.md — verify in test that returning
      // status(401) from beforeHandle on a WS route actually produces HTTP 401
      // and not a WS handshake. See open question 2.
    },
    open(ws) {
      const channel = ws.data.params.channel
      registerSocket(channel, ws)
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
