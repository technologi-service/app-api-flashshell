// src/db/client.ts
// Uses @neondatabase/serverless (HTTP-based pooled) for all application queries.
// DO NOT use this client for LISTEN/NOTIFY — use pg.Client on DATABASE_DIRECT_URL instead.
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'

const sql = neon(process.env.DATABASE_URL!)
export const db = drizzle(sql, { schema })
