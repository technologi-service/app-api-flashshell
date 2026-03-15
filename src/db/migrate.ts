// src/db/migrate.ts
// IMPORTANT: Uses DATABASE_DIRECT_URL (not DATABASE_URL).
// Neon's pooler (PgBouncer) uses transaction mode which breaks Drizzle migration
// prepared statements. Always use the direct non-pooled URL for migrations.
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import { migrate } from 'drizzle-orm/neon-http/migrator'

async function main() {
  const sql = neon(process.env.DATABASE_DIRECT_URL!)
  const db = drizzle(sql)
  console.log('[migrate] Applying migrations...')
  await migrate(db, { migrationsFolder: './src/db/migrations' })
  console.log('[migrate] Done.')
  process.exit(0)
}

main().catch((err) => {
  console.error('[migrate] Failed:', err)
  process.exit(1)
})
