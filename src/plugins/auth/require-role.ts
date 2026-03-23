// src/plugins/auth/require-role.ts
// Factory: returns a scoped Elysia plugin that enforces role access.
// Usage: .use(requireRole('chef')) or .use(requireRole('chef', 'admin'))
//
// IMPORTANT: onBeforeHandle runs BEFORE the auth macro's resolve phase,
// so `user` is not yet available in context. We must resolve the session
// here independently to check the role before the handler runs.
import { Elysia } from 'elysia'
import { auth } from './better-auth'

type Role = 'customer' | 'chef' | 'delivery' | 'admin'

export const requireRole = (...roles: Role[]) =>
  new Elysia({ name: `require-role-${roles.join('-')}` })
    .onBeforeHandle({ as: 'scoped' }, async ({ request, status }: any) => {
      const session = await auth.api.getSession({ headers: request.headers })
      if (!session) return  // auth macro will return 401 in its resolve phase
      if (!roles.includes(session.user.role as Role)) {
        return status(403, {
          error: 'FORBIDDEN',
          message: `Requires role: ${roles.join(' or ')}`,
          required: roles
        })
      }
    })
