// Prisma singleton for zele.
// Manages a single SQLite database at ~/.zele/sqlite.db for all state:
// accounts (OAuth tokens), cache (threads, labels, profiles), and sync state.
// Runs idempotent schema setup on every startup using src/schema.sql.
//
// Schema init uses a direct libsql transaction (BEGIN IMMEDIATE) so all DDL
// runs under a single write-lock acquisition. This avoids the SQLITE_BUSY
// contention that happens when multiple CLI processes each try to acquire the
// write lock 13+ times (once per CREATE TABLE/INDEX statement). The busy_timeout
// PRAGMA (15s) handles the wait if another process holds the lock.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from './generated/client.js'

export { PrismaClient }

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ZELE_DIR = path.join(os.homedir(), '.zele')
const DB_PATH = path.join(ZELE_DIR, 'sqlite.db')

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
  // Create directory with restrictive permissions (owner only)
  if (!fs.existsSync(ZELE_DIR)) {
    fs.mkdirSync(ZELE_DIR, { recursive: true, mode: 0o700 })
  } else {
    // Ensure existing directory has correct permissions
    fs.chmodSync(ZELE_DIR, 0o700)
  }

  // Run schema + migrations atomically via direct libsql client.
  // Uses a single BEGIN IMMEDIATE transaction so only one write-lock
  // acquisition is needed instead of one per DDL statement.
  await applySchemaAndMigrate()

  const adapter = new PrismaLibSql({ url: `file:${DB_PATH}` })
  const prisma = new PrismaClient({ adapter })

  // WAL mode: allows concurrent readers + single writer, persists on the DB file.
  // busy_timeout: wait up to 15s for locks to clear instead of failing instantly.
  // Prevents "database is locked" errors when multiple processes (TUI, watch, CLI)
  // access the DB, or after macOS sleep/wake leaves stale locks.
  await prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL')
  await prisma.$executeRawUnsafe('PRAGMA busy_timeout = 15000')

  // Secure database files (owner read/write only)
  secureDatabase()

  prismaInstance = prisma
  return prisma
}

/**
 * Run schema.sql DDL and column migrations inside a single BEGIN IMMEDIATE
 * transaction via the libsql client directly (bypassing Prisma).
 *
 * This acquires the SQLite write lock once for the entire init sequence
 * instead of once per statement, eliminating SQLITE_BUSY contention when
 * multiple CLI processes start concurrently.
 *
 * The libsql client is closed after init; Prisma handles all runtime queries.
 */
async function applySchemaAndMigrate(): Promise<void> {
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

  const libsql = createClient({ url: `file:${DB_PATH}` })
  try {
    // Set busy_timeout on the init connection too, so BEGIN IMMEDIATE
    // waits up to 15s if another process holds the lock.
    await libsql.execute('PRAGMA busy_timeout = 15000')
    await libsql.execute('PRAGMA journal_mode = WAL')

    // "write" mode = BEGIN IMMEDIATE: acquires the write lock upfront.
    // All DDL + migration runs atomically; auto-rollback on any failure.
    const tx = await libsql.transaction('write')
    try {
      // Schema DDL
      for (const statement of statements) {
        await tx.execute(statement)
      }

      // Column migrations (idempotent: ADD COLUMN for pre-IMAP/SMTP DBs).
      // SQLite errors on duplicate columns, so check first.
      const cols = await tx.execute(`PRAGMA table_info("Account")`)
      const colNames = new Set(cols.rows.map((r) => String(r[1])))

      if (!colNames.has('accountType')) {
        await tx.execute(`ALTER TABLE "Account" ADD COLUMN "accountType" TEXT NOT NULL DEFAULT 'google'`)
      }
      if (!colNames.has('capabilities')) {
        await tx.execute(`ALTER TABLE "Account" ADD COLUMN "capabilities" TEXT NOT NULL DEFAULT ''`)
      }

      // Backfill: existing Google accounts should have capabilities set
      await tx.execute(`
        UPDATE "Account"
        SET "capabilities" = 'gmail,calendar,smtp'
        WHERE "accountType" = 'google' AND ("capabilities" = '' OR "capabilities" IS NULL)
      `)

      await tx.commit()
    } finally {
      tx.close()
    }
  } finally {
    libsql.close()
  }
}

/**
 * Set restrictive permissions on database files.
 * SQLite WAL mode creates additional -wal and -shm files that also need protection.
 */
function secureDatabase(): void {
  const filesToSecure = [
    DB_PATH,
    `${DB_PATH}-wal`,
    `${DB_PATH}-shm`,
  ]

  for (const filePath of filesToSecure) {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, 0o600)
    }
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
