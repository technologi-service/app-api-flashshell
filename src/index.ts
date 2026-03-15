// src/index.ts
// RULE: This file mounts plugins only. No routes, no business logic, no DB queries.
// All domain logic lives in src/plugins/ subdirectories.
import { Elysia } from 'elysia'
import { authPlugin } from './plugins/auth/index'
// wsPlugin and healthPlugin are wired in Plan 01-03

const app = new Elysia()
  .use(authPlugin)
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
  .listen(3000)

console.log(`FlashShell Engine running at ${app.server?.hostname}:${app.server?.port}`)
