// scripts/seed-roles.ts
// Seeds one user per non-customer role for local E2E testing.
// Usage: bun run db:seed:roles
// Requires env vars: DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL
//
// Creates (idempotent — skips if email already exists):
//   chef@flashshell.test    / test-chef-pass     → role: chef
//   delivery@flashshell.test / test-delivery-pass → role: delivery
//   admin@flashshell.test   / test-admin-pass     → role: admin
//
// Customer users are created via normal signup — no seed needed.
import { auth } from '../src/plugins/auth/better-auth'
import { db } from '../src/db/client'
import { user as userTable } from '../src/db/schema'
import { eq } from 'drizzle-orm'

type Role = 'chef' | 'delivery' | 'admin'

const SEED_USERS: Array<{ email: string; password: string; name: string; role: Role }> = [
  { email: 'chef@flashshell.test',     password: 'test-chef-pass',     name: 'Chef Seed',     role: 'chef' },
  { email: 'delivery@flashshell.test', password: 'test-delivery-pass', name: 'Delivery Seed', role: 'delivery' },
  { email: 'admin@flashshell.test',    password: 'test-admin-pass',    name: 'Admin Seed',    role: 'admin' },
]

async function seedRoles() {
  for (const { email, password, name, role } of SEED_USERS) {
    // Check if user already exists
    const [existing] = await db.select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, email))

    if (existing) {
      console.log(`[seed-roles] Already exists — updating role: ${email} → ${role}`)
    } else {
      const result = await auth.api.signUpEmail({ body: { email, password, name } })
      if (!result) {
        console.error(`[seed-roles] Sign-up failed for ${email}`)
        continue
      }
      console.log(`[seed-roles] Created user: ${email}`)
    }

    await db.update(userTable).set({ role }).where(eq(userTable.email, email))
    console.log(`[seed-roles] Role set: ${email} → ${role}`)
  }

  console.log('\n[seed-roles] Done. Test credentials:')
  for (const { email, password, role } of SEED_USERS) {
    console.log(`  ${role.padEnd(8)} | ${email} / ${password}`)
  }
  console.log('  customer | sign up normally via POST /api/auth/sign-up/email')

  process.exit(0)
}

seedRoles().catch((err) => {
  console.error('[seed-roles] Error:', err)
  process.exit(1)
})
