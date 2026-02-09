// Prisma singleton for gtui.
// Manages a single SQLite database at ~/.gtui/gtui.db for all state:
// accounts (OAuth tokens), cache (threads, labels, profiles), and sync state.
// Runs idempotent schema migration on every startup using src/schema.sql.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from './generated/client.js'

export { PrismaClient }

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const GTUI_DIR = path.join(os.homedir(), '.gtui')
const DB_PATH = path.join(GTUI_DIR, 'gtui.db')

let prismaInstance: PrismaClient | null = null
let initPromise: Promise<PrismaClient> | null = null

/**
 * Get the singleton Prisma client instance.
 * Initializes the database on first call, running schema setup if needed.
 */
export function getPrisma(): Promise<PrismaClient> {
  if (prismaInstance) {
    return Promise.resolve(prismaInstance)
  }
  if (initPromise) {
    return initPromise
  }
  initPromise = initializePrisma()
  return initPromise
}

async function initializePrisma(): Promise<PrismaClient> {
  if (!fs.existsSync(GTUI_DIR)) {
    fs.mkdirSync(GTUI_DIR, { recursive: true })
  }

  const adapter = new PrismaLibSql({ url: `file:${DB_PATH}` })
  const prisma = new PrismaClient({ adapter })

  // Always run migrations — schema.sql uses IF NOT EXISTS so it's idempotent
  await migrateSchema(prisma)

  prismaInstance = prisma
  return prisma
}

async function migrateSchema(prisma: PrismaClient): Promise<void> {
  // When running from source (tsx), __dirname is src/
  // When running from dist, __dirname is dist/ and schema.sql is at ../src/schema.sql
  let schemaPath = path.join(__dirname, 'schema.sql')
  if (!fs.existsSync(schemaPath)) {
    schemaPath = path.join(__dirname, '..', 'src', 'schema.sql')
  }

  const sql = fs.readFileSync(schemaPath, 'utf-8')
  const statements = sql
    .split(';')
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0 && !/^CREATE\s+TABLE\s+["']?sqlite_sequence["']?\s*\(/i.test(s))
    // Make CREATE INDEX idempotent
    .map((s) => s.replace(/^CREATE\s+UNIQUE\s+INDEX\b(?!\s+IF)/i, 'CREATE UNIQUE INDEX IF NOT EXISTS')
                 .replace(/^CREATE\s+INDEX\b(?!\s+IF)/i, 'CREATE INDEX IF NOT EXISTS'))

  // Compatibility migration: older DBs may not have account_status yet.
  try {
    await prisma.$executeRawUnsafe(
      "ALTER TABLE \"accounts\" ADD COLUMN \"account_status\" TEXT NOT NULL DEFAULT 'active'",
    )
  } catch {
    // Column already exists.
  }


  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement)
  }
}

/**
 * Close the Prisma connection.
 */
export async function closePrisma(): Promise<void> {
  if (prismaInstance) {
    await prismaInstance.$disconnect()
    prismaInstance = null
    initPromise = null
  }
}
