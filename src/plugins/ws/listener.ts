// src/plugins/ws/listener.ts
// IMPORTANT: Uses pg.Client on DATABASE_DIRECT_URL — NOT the pooled @neondatabase/serverless.
// Neon's pooler kills idle connections; LISTEN requires a persistent dedicated pg.Client.
// See Pitfall 1 in 01-RESEARCH.md.
//
// pg (npm v8.x) is Node.js compatible and works in Bun via Node.js compat layer.
// If pg cannot be imported, verify Bun version supports Node.js compat for native modules.
import { Client } from 'pg'

const CHANNEL = 'flashshell_events'

// In-memory channel registry: channelName → Set of WebSocket connections
// This map is populated by wsPlugin (index.ts) and read by dispatch()
const channels = new Map<string, Set<{ send: (data: string) => void }>>()

let pgClient: Client | null = null

function createClient(): Client {
  return new Client({ connectionString: process.env.DATABASE_DIRECT_URL })
}

async function connect(): Promise<void> {
  pgClient = createClient()
  await pgClient.connect()
  await pgClient.query(`LISTEN ${CHANNEL}`)
  console.log(`[ws-listener] Connected to Neon LISTEN channel: ${CHANNEL}`)

  pgClient.on('notification', (msg) => {
    if (!msg.payload) return
    try {
      const payload = JSON.parse(msg.payload) as { channel: string; [key: string]: unknown }
      dispatch(payload.channel, payload)
    } catch (err) {
      console.error('[ws-listener] Failed to parse notification payload:', err)
    }
  })

  pgClient.on('error', (err) => {
    console.error('[ws-listener] pg connection error:', err.message)
    reconnect(1000)
  })
}

function reconnect(delayMs: number): void {
  // Exponential backoff: 1s → 2s → 4s → ... → max 30s
  console.log(`[ws-listener] Reconnecting in ${delayMs}ms...`)
  setTimeout(async () => {
    try {
      if (pgClient) {
        pgClient.removeAllListeners()
        try { await pgClient.end() } catch { /* ignore */ }
        pgClient = null
      }
      await connect()
    } catch (err) {
      console.error('[ws-listener] Reconnect attempt failed:', err)
      reconnect(Math.min(delayMs * 2, 30_000))
    }
  }, delayMs)
}

export function startListener(): void {
  if (!process.env.DATABASE_DIRECT_URL) {
    console.warn('[ws-listener] DATABASE_DIRECT_URL not set — LISTEN/NOTIFY hub disabled')
    return
  }
  connect().catch((err) => {
    console.error('[ws-listener] Initial connect failed:', err)
    reconnect(1000)
  })
}

export function dispatch(channel: string, payload: unknown): void {
  const sockets = channels.get(channel)
  if (!sockets || sockets.size === 0) return
  const msg = JSON.stringify(payload)
  for (const ws of sockets) {
    try {
      ws.send(msg)
    } catch (err) {
      console.error(`[ws-listener] Failed to send to channel ${channel}:`, err)
    }
  }
}

export function registerSocket(channel: string, ws: { send: (data: string) => void }): void {
  if (!channels.has(channel)) channels.set(channel, new Set())
  channels.get(channel)!.add(ws)
}

export function unregisterSocket(channel: string, ws: { send: (data: string) => void }): void {
  channels.get(channel)?.delete(ws)
}
