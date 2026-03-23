// src/plugins/auth/better-auth.ts
// Source: better-auth.com/docs/adapters/drizzle + /docs/concepts/database
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { bearer } from 'better-auth/plugins'
import { db } from '../../db/client'
import * as schema from '../../db/schema'

const apiUrl = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'

// Trusted origins: frontend(s) from CORS_ORIGINS + the API itself (for Swagger UI).
// Better Auth rejects requests whose Origin header is not in this list.
const trustedOrigins = [
  apiUrl,
  ...(process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean)
]

export const auth = betterAuth({
  baseURL: apiUrl,
  secret: process.env.BETTER_AUTH_SECRET!,
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: { enabled: true },
  plugins: [bearer()],
  trustedOrigins,
  user: {
    additionalFields: {
      role: {
        type: 'string',
        required: false,
        defaultValue: 'customer',
        input: false  // users CANNOT set role at signup — admin only via seed script
      }
    }
  }
})
