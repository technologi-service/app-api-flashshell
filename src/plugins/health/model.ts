import { t } from 'elysia'

export const HealthResponse = t.Object({
  status: t.Union([t.Literal('ok'), t.Literal('degraded')]),
  db: t.Union([t.Literal('ok'), t.Literal('degraded')]),
  uptime: t.Number()
})
export type HealthResponse = typeof HealthResponse.static
