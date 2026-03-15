// src/db/client.ts
// Uses @neondatabase/serverless (HTTP-based pooled) for all application queries.
// DO NOT use this client for LISTEN/NOTIFY — use pg.Client on DATABASE_DIRECT_URL instead.
// NOTE: DATABASE_URL validation is deferred to first query so unit tests can import
// this module without a live DB connection.
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'

const sql = neon(process.env.DATABASE_URL ?? 'postgresql://placeholder:placeholder@placeholder/placeholder')
export const db = drizzle(sql, { schema })
