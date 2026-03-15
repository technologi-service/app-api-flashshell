// src/plugins/auth/require-role.ts
// Source: elysiajs skill references/plugin.md (scope casting + .as('scoped'))
// Factory: returns a scoped Elysia plugin that enforces role access.
// Usage: .use(requireRole('chef')) or .use(requireRole('chef', 'admin'))
import { Elysia } from 'elysia'

type Role = 'customer' | 'chef' | 'delivery' | 'admin'

export const requireRole = (...roles: Role[]) =>
  new Elysia({ name: `require-role-${roles.join('-')}` })
    .derive({ as: 'scoped' }, ({ user, status }: any) => {
      // Only enforce role when user is present (auth macro has resolved).
      // Routes without { auth: true } won't have user set — requireRole is a no-op for them.
      if (!user) return
      const userRole = (user as any).role
      if (!roles.includes(userRole)) {
        return status(403, {
          error: 'FORBIDDEN',
          message: `Requires role: ${roles.join(' or ')}`,
          required: roles
        })
      }
    })
