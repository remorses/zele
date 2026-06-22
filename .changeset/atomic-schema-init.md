---
'zele': patch
---

Run schema initialization inside a single atomic SQLite transaction instead of 13+ individual write transactions.

Previously each `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` statement ran as its own auto-committed write transaction via Prisma's `$executeRawUnsafe`. When multiple CLI processes started concurrently (TUI + watch + CLI commands), they all fought over the write lock 13+ times each, causing `SQLITE_BUSY` errors.

Now schema DDL and column migrations run inside a single `BEGIN IMMEDIATE` transaction via the libsql client directly. This acquires the write lock once for the entire init sequence and releases it once, eliminating the contention window. The `busy_timeout` PRAGMA (15s) handles the wait if another process holds the lock.
