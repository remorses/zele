// Prisma-based cache for Gmail API responses.
// Each cache entry is scoped to an account email. TTL-based expiry is checked
// at read time. All methods are async (Prisma is async).
// Single SQLite DB shared across all accounts via the Prisma singleton.

import { getPrisma } from './db.js'

// TTL constants in milliseconds
export const TTL = {
  THREAD_LIST: 5 * 60 * 1000, // 5 minutes
  THREAD: 30 * 60 * 1000, // 30 minutes
  LABELS: 30 * 60 * 1000, // 30 minutes
  PROFILE: 24 * 60 * 60 * 1000, // 24 hours
  LABEL_COUNTS: 2 * 60 * 1000, // 2 minutes
} as const

function isExpired(createdAt: Date, ttlMs: number): boolean {
  return createdAt.getTime() + ttlMs < Date.now()
}

// ---------------------------------------------------------------------------
// Thread list cache
// ---------------------------------------------------------------------------

export async function cacheThreadList(
  email: string,
  params: { folder?: string; query?: string; maxResults?: number; labelIds?: string[]; pageToken?: string },
  data: unknown,
): Promise<void> {
  const prisma = await getPrisma()
  const where = {
    email,
    folder: params.folder ?? '',
    query: params.query ?? '',
    label_ids: params.labelIds?.join(',') ?? '',
    page_token: params.pageToken ?? '',
    max_results: params.maxResults ?? 0,
  }

  await prisma.thread_lists.upsert({
    where: { email_folder_query_label_ids_page_token_max_results: where },
    create: { ...where, data: JSON.stringify(data), ttl_ms: TTL.THREAD_LIST },
    update: { data: JSON.stringify(data), ttl_ms: TTL.THREAD_LIST, created_at: new Date() },
  })
}

export async function getCachedThreadList<T = unknown>(
  email: string,
  params: { folder?: string; query?: string; maxResults?: number; labelIds?: string[]; pageToken?: string },
): Promise<T | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.thread_lists.findUnique({
    where: {
      email_folder_query_label_ids_page_token_max_results: {
        email,
        folder: params.folder ?? '',
        query: params.query ?? '',
        label_ids: params.labelIds?.join(',') ?? '',
        page_token: params.pageToken ?? '',
        max_results: params.maxResults ?? 0,
      },
    },
  })

  if (!row || isExpired(row.created_at, row.ttl_ms)) return undefined
  return JSON.parse(row.data) as T
}

export async function invalidateThreadLists(email: string): Promise<void> {
  const prisma = await getPrisma()
  await prisma.thread_lists.deleteMany({ where: { email } })
}

// ---------------------------------------------------------------------------
// Individual thread cache
// ---------------------------------------------------------------------------

export async function cacheThread(
  email: string,
  threadId: string,
  data: unknown,
): Promise<void> {
  const prisma = await getPrisma()
  await prisma.threads.upsert({
    where: { email_thread_id: { email, thread_id: threadId } },
    create: { email, thread_id: threadId, data: JSON.stringify(data), ttl_ms: TTL.THREAD },
    update: { data: JSON.stringify(data), ttl_ms: TTL.THREAD, created_at: new Date() },
  })
}

export async function getCachedThread<T = unknown>(
  email: string,
  threadId: string,
): Promise<T | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.threads.findUnique({
    where: { email_thread_id: { email, thread_id: threadId } },
  })

  if (!row || isExpired(row.created_at, row.ttl_ms)) return undefined
  return JSON.parse(row.data) as T
}

export async function invalidateThread(email: string, threadId: string): Promise<void> {
  const prisma = await getPrisma()
  await prisma.threads.deleteMany({ where: { email, thread_id: threadId } })
}

export async function invalidateThreads(email: string, threadIds: string[]): Promise<void> {
  const prisma = await getPrisma()
  await prisma.threads.deleteMany({ where: { email, thread_id: { in: threadIds } } })
}

// ---------------------------------------------------------------------------
// Labels cache
// ---------------------------------------------------------------------------

export async function cacheLabels(email: string, data: unknown): Promise<void> {
  const prisma = await getPrisma()
  await prisma.labels.upsert({
    where: { email },
    create: { email, data: JSON.stringify(data), ttl_ms: TTL.LABELS },
    update: { data: JSON.stringify(data), ttl_ms: TTL.LABELS, created_at: new Date() },
  })
}

export async function getCachedLabels<T = unknown>(email: string): Promise<T | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.labels.findUnique({ where: { email } })
  if (!row || isExpired(row.created_at, row.ttl_ms)) return undefined
  return JSON.parse(row.data) as T
}

export async function invalidateLabels(email: string): Promise<void> {
  const prisma = await getPrisma()
  await prisma.labels.deleteMany({ where: { email } })
}

// ---------------------------------------------------------------------------
// Label counts cache
// ---------------------------------------------------------------------------

export async function cacheLabelCounts(email: string, data: unknown): Promise<void> {
  const prisma = await getPrisma()
  await prisma.label_counts.upsert({
    where: { email },
    create: { email, data: JSON.stringify(data), ttl_ms: TTL.LABEL_COUNTS },
    update: { data: JSON.stringify(data), ttl_ms: TTL.LABEL_COUNTS, created_at: new Date() },
  })
}

export async function getCachedLabelCounts<T = unknown>(email: string): Promise<T | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.label_counts.findUnique({ where: { email } })
  if (!row || isExpired(row.created_at, row.ttl_ms)) return undefined
  return JSON.parse(row.data) as T
}

export async function invalidateLabelCounts(email: string): Promise<void> {
  const prisma = await getPrisma()
  await prisma.label_counts.deleteMany({ where: { email } })
}

// ---------------------------------------------------------------------------
// Profile cache
// ---------------------------------------------------------------------------

export async function cacheProfile(email: string, data: unknown): Promise<void> {
  const prisma = await getPrisma()
  await prisma.profiles.upsert({
    where: { email },
    create: { email, data: JSON.stringify(data), ttl_ms: TTL.PROFILE },
    update: { data: JSON.stringify(data), ttl_ms: TTL.PROFILE, created_at: new Date() },
  })
}

export async function getCachedProfile<T = unknown>(email: string): Promise<T | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.profiles.findUnique({ where: { email } })
  if (!row || isExpired(row.created_at, row.ttl_ms)) return undefined
  return JSON.parse(row.data) as T
}

// ---------------------------------------------------------------------------
// Sync state (persistent, no TTL)
// ---------------------------------------------------------------------------

export async function getLastHistoryId(email: string): Promise<string | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.sync_states.findUnique({
    where: { email_key: { email, key: 'history_id' } },
  })
  return row?.value
}

export async function setLastHistoryId(email: string, historyId: string): Promise<void> {
  const prisma = await getPrisma()
  await prisma.sync_states.upsert({
    where: { email_key: { email, key: 'history_id' } },
    create: { email, key: 'history_id', value: historyId },
    update: { value: historyId },
  })
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

export async function clearExpired(): Promise<void> {
  const prisma = await getPrisma()
  const now = Date.now()
  // Use raw SQL for the timestamp arithmetic across all cache tables
  await prisma.$executeRawUnsafe(
    `DELETE FROM thread_lists WHERE (strftime('%s', created_at) * 1000 + ttl_ms) < ?`,
    now,
  )
  await prisma.$executeRawUnsafe(
    `DELETE FROM threads WHERE (strftime('%s', created_at) * 1000 + ttl_ms) < ?`,
    now,
  )
  await prisma.$executeRawUnsafe(
    `DELETE FROM labels WHERE (strftime('%s', created_at) * 1000 + ttl_ms) < ?`,
    now,
  )
  await prisma.$executeRawUnsafe(
    `DELETE FROM label_counts WHERE (strftime('%s', created_at) * 1000 + ttl_ms) < ?`,
    now,
  )
  await prisma.$executeRawUnsafe(
    `DELETE FROM profiles WHERE (strftime('%s', created_at) * 1000 + ttl_ms) < ?`,
    now,
  )
}

export async function clearAll(email: string): Promise<void> {
  const prisma = await getPrisma()
  await prisma.thread_lists.deleteMany({ where: { email } })
  await prisma.threads.deleteMany({ where: { email } })
  await prisma.labels.deleteMany({ where: { email } })
  await prisma.label_counts.deleteMany({ where: { email } })
  await prisma.profiles.deleteMany({ where: { email } })
  await prisma.sync_states.deleteMany({ where: { email } })
}
