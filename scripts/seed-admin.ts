// scripts/seed-admin.ts
// Usage: bun run db:seed:admin
// Requires env vars: SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL
import { auth } from '../src/plugins/auth/better-auth'
import { db } from '../src/db/client'
import { user as userTable } from '../src/db/schema'
import { eq } from 'drizzle-orm'

async function seedAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL
  const password = process.env.SEED_ADMIN_PASSWORD

  if (!email || !password) {
    console.error('[seed-admin] SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set')
    process.exit(1)
  }

  // Sign up the admin user via Better Auth
  const result = await auth.api.signUpEmail({
    body: { email, password, name: 'Admin' }
  })

  if (!result) {
    console.error('[seed-admin] Sign-up failed — user may already exist')
    process.exit(1)
  }

  // Update role to 'admin' directly in the users table
  // (role is input: false so it cannot be set via signup)
  await db.update(userTable).set({ role: 'admin' }).where(eq(userTable.email, email))

  console.log(`[seed-admin] Admin user created: ${email}`)
  process.exit(0)
}

seedAdmin().catch((err) => {
  console.error('[seed-admin] Error:', err)
  process.exit(1)
})
