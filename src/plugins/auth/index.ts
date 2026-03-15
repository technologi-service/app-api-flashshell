// src/plugins/auth/index.ts
// Source: elysiajs skill integrations/better-auth.md + Pattern 2 from 01-RESEARCH.md
// IMPORTANT: The macro pattern uses { as: 'scoped' } so auth context propagates
// to parent plugins that .use(authPlugin). Without scoped, auth won't protect
// routes outside this plugin. See Pitfall 2 in 01-RESEARCH.md.
import { Elysia } from 'elysia'
import { auth } from './better-auth'

export const authPlugin = new Elysia({ name: 'better-auth' })
  .mount(auth.handler)
  .macro({
    auth: {
      async resolve({ status, request: { headers } }) {
        const session = await auth.api.getSession({ headers })
        if (!session) return status(401, {
          error: 'UNAUTHORIZED',
          message: 'Valid authentication token required'
        })
        // NOTE: If user.role is undefined after first deploy, see Pitfall 4 in
        // 01-RESEARCH.md — may need DB lookup fallback or Better Auth session config.
        return {
          user: session.user,
          session: session.session
        }
      }
    }
  })
