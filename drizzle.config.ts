import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  out: './src/db/migrations',
  schema: './src/db/schema',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_DIRECT_URL!
    // IMPORTANT: Always use DATABASE_DIRECT_URL (not DATABASE_URL)
    // Neon's pooler (PgBouncer) blocks drizzle-kit's prepared statements
  }
})
