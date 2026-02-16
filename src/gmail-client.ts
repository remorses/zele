// Gmail API client for CLI/TUI use.
// Wraps the @googleapis/gmail SDK with structured methods, object params, and inferred return types.
// No abstract interfaces, no RPC layer — just a concrete class for Gmail.
// Cache is built into the client for expensive read paths.
// List/search entry-point calls always fetch fresh IDs and then reuse per-thread cache
// to avoid repeated N+1 hydration calls.
// Raw Google API responses are stored in the cache (gmail_v1.Schema$*) so the cache
// is resilient to changes in our own parsed types. Parsing happens at read time.
// When account is not provided (bootstrap/login flow), cache is skipped entirely.

import { gmail as gmailApi, type gmail_v1 } from '@googleapis/gmail'
import type { OAuth2Client } from 'google-auth-library'
import { createMimeMessage } from 'mimetext'
import { parseFrom, parseAddressList } from './email-utils.js'
import * as errore from 'errore'
import { withRetry, mapConcurrent, AuthError, isAuthLikeError, ApiError, NotFoundError, EmptyThreadError, MissingDataError } from './api-utils.js'
import { renderEmailBody } from './output.js'
import { getPrisma } from './db.js'
import type { AccountId } from './auth.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Sender {
  name?: string
  email: string
}

export interface ParsedMessage {
  id: string
  threadId: string
  subject: string
  snippet: string
  from: Sender
  to: Sender[]
  cc: Sender[] | null
  bcc: Sender[]
  replyTo?: string
  date: string
  labelIds: string[]
  unread: boolean
  starred: boolean
  isDraft: boolean
  messageId: string
  inReplyTo?: string
  references?: string
  listUnsubscribe?: string
  body: string // decoded body (html preferred for rich rendering)
  mimeType: string // 'text/plain' or 'text/html'
  textBody: string | null // decoded text/plain body when available (for reply parsing)
  attachments: AttachmentMeta[]
}

export interface AttachmentMeta {
  attachmentId: string
  filename: string
  mimeType: string
  size: number
}

export interface ThreadData {
  id: string
  historyId: string | null
  messages: ParsedMessage[]
  subject: string
  snippet: string
  from: Sender
  date: string
  labelIds: string[]
  hasUnread: boolean
  messageCount: number
}

export interface ThreadListItem {
  id: string
  historyId: string | null
  snippet: string
  subject: string
  from: Sender
  date: string
  labelIds: string[]
  unread: boolean
  messageCount: number
}

export interface ThreadListResult {
  threads: ThreadListItem[]
  /** Raw Google gmail_v1.Schema$Thread metadata responses, parallel to threads[]. */
  rawThreads: gmail_v1.Schema$Thread[]
  nextPageToken: string | null
  resultSizeEstimate: number
}

/** Result from getThread() — includes both parsed data and the raw Google response. */
export interface ThreadResult {
  parsed: ThreadData
  raw: gmail_v1.Schema$Thread
}

// ---------------------------------------------------------------------------
// Watch event type
// ---------------------------------------------------------------------------

export interface WatchEvent {
  account: AccountId
  type: 'new_message'
  message: ParsedMessage
  threadId: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYSTEM_LABEL_IDS = new Set([
  'INBOX',
  'TRASH',
  'SPAM',
  'DRAFT',
  'SENT',
  'STARRED',
  'UNREAD',
  'IMPORTANT',
  'CATEGORY_PERSONAL',
  'CATEGORY_SOCIAL',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
  'CATEGORY_PROMOTIONS',
  'MUTED',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeBase64Url(encoded: string) {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(base64, 'base64').toString('utf-8')
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  }

  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const codePoint = Number.parseInt(entity.slice(2), 16)
      if (!Number.isFinite(codePoint)) return match
      return String.fromCodePoint(codePoint)
    }

    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10)
      if (!Number.isFinite(codePoint)) return match
      return String.fromCodePoint(codePoint)
    }

    return namedEntities[entity.toLowerCase()] ?? match
  })
}

function sanitizeSnippet(snippet: string): string {
  return decodeHtmlEntities(snippet)
    .replace(/[\u00A0\u00AD\u034F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Sanitize header values to prevent CRLF injection attacks.
 * The mimetext library does not sanitize custom header values, so newlines
 * in In-Reply-To or References could inject arbitrary headers.
 */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, ' ').trim()
}

function encodeBase64Url(data: string | Buffer) {
  const buf = typeof data === 'string' ? Buffer.from(data) : data
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ---------------------------------------------------------------------------
// GmailClient
// ---------------------------------------------------------------------------

// TTL constants in milliseconds
const TTL = {
  THREAD: 30 * 60 * 1000, // 30 minutes
  LABELS: 30 * 60 * 1000, // 30 minutes
  PROFILE: 24 * 60 * 60 * 1000, // 24 hours
} as const

function isExpired(createdAt: Date, ttlMs: number): boolean {
  return createdAt.getTime() + ttlMs < Date.now()
}

/** Boundary helper: wrap a googleapis SDK call, converting auth-like errors to AuthError values.
 *  Non-auth errors are wrapped in ApiError so they remain error values (no throwing).
 *  Original error is preserved as `cause` for debugging. */
function gmailBoundary<T>(email: string, fn: () => Promise<T>) {
  return errore.tryAsync({
    try: fn,
    catch: (err) => isAuthLikeError(err)
      ? new AuthError({ email, reason: String(err) })
      : new ApiError({ reason: String(err), cause: err }),
  })
}

export class GmailClient {
  private gmail: gmail_v1.Gmail
  private labelIdCache: Record<string, string> = {}
  private account: AccountId | null

  constructor({ auth, account }: { auth: OAuth2Client; account?: AccountId }) {
    this.gmail = gmailApi({ version: 'v1', auth })
    this.account = account ?? null
  }

  // =========================================================================
  // Cache helpers (private) — skip all cache ops when account is null
  // =========================================================================

  private get cacheEnabled(): boolean {
    return this.account !== null
  }

  private async getCachedThread(threadId: string): Promise<gmail_v1.Schema$Thread | undefined> {
    if (!this.cacheEnabled) return undefined
    const prisma = await getPrisma()
    const row = await prisma.thread.findUnique({
      where: { email_appId_threadId: { email: this.account!.email, appId: this.account!.appId, threadId } },
    })
    if (!row || isExpired(row.createdAt, row.ttlMs)) return undefined
    return JSON.parse(row.rawData) as gmail_v1.Schema$Thread
  }

  private async cacheThreadData(threadId: string, raw: gmail_v1.Schema$Thread, parsed: ThreadData): Promise<void> {
    if (!this.cacheEnabled) return
    const prisma = await getPrisma()
    await prisma.thread.upsert({
      where: { email_appId_threadId: { email: this.account!.email, appId: this.account!.appId, threadId } },
      create: {
        email: this.account!.email, appId: this.account!.appId, threadId,
        subject: parsed.subject, snippet: parsed.snippet,
        fromEmail: parsed.from.email, fromName: parsed.from.name ?? '',
        date: parsed.date, labelIds: parsed.labelIds.join(','),
        hasUnread: parsed.hasUnread, msgCount: parsed.messageCount,
        historyId: parsed.historyId,
        rawData: JSON.stringify(raw), ttlMs: TTL.THREAD, createdAt: new Date(),
      },
      update: {
        subject: parsed.subject, snippet: parsed.snippet,
        fromEmail: parsed.from.email, fromName: parsed.from.name ?? '',
        date: parsed.date, labelIds: parsed.labelIds.join(','),
        hasUnread: parsed.hasUnread, msgCount: parsed.messageCount,
        historyId: parsed.historyId,
        rawData: JSON.stringify(raw), ttlMs: TTL.THREAD, createdAt: new Date(),
      },
    })
  }

  async invalidateThreads(threadIds: string[]): Promise<void> {
    if (!this.cacheEnabled) return
    const prisma = await getPrisma()
    await prisma.thread.deleteMany({ where: { email: this.account!.email, appId: this.account!.appId, threadId: { in: threadIds } } })
  }

  async invalidateThread(threadId: string): Promise<void> {
    if (!this.cacheEnabled) return
    const prisma = await getPrisma()
    await prisma.thread.deleteMany({ where: { email: this.account!.email, appId: this.account!.appId, threadId } })
  }

  private async getCachedLabels(): Promise<gmail_v1.Schema$Label[] | undefined> {
    if (!this.cacheEnabled) return undefined
    const prisma = await getPrisma()
    const row = await prisma.label.findUnique({ where: { email_appId: { email: this.account!.email, appId: this.account!.appId } } })
    if (!row || isExpired(row.createdAt, row.ttlMs)) return undefined
    return JSON.parse(row.rawData) as gmail_v1.Schema$Label[]
  }

  private async cacheLabelsData(raw: gmail_v1.Schema$Label[]): Promise<void> {
    if (!this.cacheEnabled) return
    const prisma = await getPrisma()
    await prisma.label.upsert({
      where: { email_appId: { email: this.account!.email, appId: this.account!.appId } },
      create: { email: this.account!.email, appId: this.account!.appId, rawData: JSON.stringify(raw), ttlMs: TTL.LABELS, createdAt: new Date() },
      update: { rawData: JSON.stringify(raw), ttlMs: TTL.LABELS, createdAt: new Date() },
    })
  }

  async invalidateLabels(): Promise<void> {
    if (!this.cacheEnabled) return
    const prisma = await getPrisma()
    await prisma.label.deleteMany({ where: { email: this.account!.email, appId: this.account!.appId } })
  }

  private async getCachedProfile(): Promise<{ emailAddress: string; messagesTotal: number; threadsTotal: number; historyId: string } | undefined> {
    if (!this.cacheEnabled) return undefined
    const prisma = await getPrisma()
    const row = await prisma.profile.findUnique({ where: { email_appId: { email: this.account!.email, appId: this.account!.appId } } })
    if (!row || isExpired(row.createdAt, row.ttlMs)) return undefined
    return { emailAddress: row.emailAddress, messagesTotal: row.messagesTotal, threadsTotal: row.threadsTotal, historyId: row.historyId }
  }

  private async cacheProfileData(profile: { emailAddress: string; messagesTotal: number; threadsTotal: number; historyId: string }): Promise<void> {
    if (!this.cacheEnabled) return
    const prisma = await getPrisma()
    await prisma.profile.upsert({
      where: { email_appId: { email: this.account!.email, appId: this.account!.appId } },
      create: { email: this.account!.email, appId: this.account!.appId, ...profile, ttlMs: TTL.PROFILE, createdAt: new Date() },
      update: { ...profile, ttlMs: TTL.PROFILE, createdAt: new Date() },
    })
  }

  // =========================================================================
  // Thread operations
  // =========================================================================

  async listThreads({
    query,
    folder,
    maxResults = 25,
    labelIds,
    pageToken,
  }: {
    query?: string
    folder?: string
    maxResults?: number
    labelIds?: string[]
    pageToken?: string
  } = {}): Promise<ThreadListResult | AuthError | ApiError> {
    const { q, resolvedLabelIds } = this.buildSearchParams(folder, query, labelIds)

    const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
      withRetry(() =>
        this.gmail.users.threads.list({
          userId: 'me',
          q: q || undefined,
          labelIds: resolvedLabelIds.length > 0 ? resolvedLabelIds : undefined,
          maxResults,
          pageToken: pageToken || undefined,
        }),
      ),
    )
    if (res instanceof Error) return res

    const rawThreads = res.data.threads ?? []

    // Hydrate with metadata — collect both raw and parsed
    const hydrated = await mapConcurrent(rawThreads, async (t) => {
      if (!t.id) return null

      const cached = await this.getCachedThread(t.id)
      if (cached && (!t.historyId || !cached.historyId || t.historyId === cached.historyId)) {
        return {
          parsed: this.parseThreadListItem(cached),
          raw: cached,
        }
      }

      // Boundary: threads.get — auth errors abort via mapConcurrent, others skip.
      const detail = await gmailBoundary(this.account?.email ?? 'unknown', () =>
        withRetry(() =>
          this.gmail.users.threads.get({
            userId: 'me',
            id: t.id!,
            format: 'full',
          }),
        ),
      )
      if (detail instanceof AuthError) return detail
      if (detail instanceof Error) return null

      const parsed = this.parseThread(detail.data)
      await this.cacheThreadData(t.id, detail.data, parsed)

      return {
        parsed: this.parseThreadListItem(detail.data),
        raw: detail.data,
      }
    })

    if (hydrated instanceof Error) return hydrated

    const valid = hydrated.filter((t): t is NonNullable<typeof t> => t !== null)
    const result: ThreadListResult = {
      threads: valid.map((t) => t.parsed),
      rawThreads: valid.map((t) => t.raw),
      nextPageToken: res.data.nextPageToken ?? null,
      resultSizeEstimate: res.data.resultSizeEstimate ?? 0,
    }

    return result
  }

  async getThread({ threadId }: { threadId: string }): Promise<ThreadResult> {
    // Check cache
    const cached = await this.getCachedThread(threadId)
    if (cached) {
      return { parsed: this.parseThread(cached), raw: cached }
    }

    const res = await withRetry(() =>
      this.gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'full',
      }),
    )

    const parsed = this.parseThread(res.data)
    const result: ThreadResult = { parsed, raw: res.data }

    // Write cache
    await this.cacheThreadData(threadId, res.data, parsed)

    return result
  }

  async getMessage({
    messageId,
    format = 'full',
  }: {
    messageId: string
    format?: 'full' | 'metadata' | 'minimal' | 'raw'
  }): Promise<ParsedMessage | { id: string; raw: string } | AuthError | ApiError> {
    const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
      withRetry(() =>
        this.gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format,
        }),
      ),
    )
    if (res instanceof Error) return res

    if (format === 'raw') {
      return {
        id: messageId,
        raw: res.data.raw ? decodeBase64Url(res.data.raw) : '',
      }
    }

    return this.parseMessage(res.data)
  }

  async getRawMessage({ messageId }: { messageId: string }): Promise<string | MissingDataError | AuthError | ApiError> {
    const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
      withRetry(() =>
        this.gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'raw',
        }),
      ),
    )
    if (res instanceof Error) return res

    if (!res.data.raw) return new MissingDataError({ what: 'raw email data', resource: `message ${messageId}` })
    return decodeBase64Url(res.data.raw)
  }

  // =========================================================================
  // Send / compose
  // =========================================================================

  async sendMessage({
    to,
    subject,
    body,
    cc,
    bcc,
    threadId,
    inReplyTo,
    references,
    attachments,
    fromEmail,
  }: {
    to: Array<{ name?: string; email: string }>
    subject: string
    body: string
    cc?: Array<{ name?: string; email: string }>
    bcc?: Array<{ name?: string; email: string }>
    threadId?: string
    inReplyTo?: string
    references?: string
    attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>
    fromEmail?: string
  }) {
    const raw = this.buildMimeMessage({
      to,
      subject,
      body,
      cc,
      bcc,
      inReplyTo,
      references,
      attachments,
      fromEmail,
    })

    const res = await withRetry(() =>
      this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw,
          threadId,
        },
      }),
    )

    return res.data
  }

  // =========================================================================
  // Reply / Forward (high-level composition)
  // =========================================================================

  /**
   * Reply to a thread. Handles reply-to resolution, reply-all CC computation,
   * References/In-Reply-To headers, and subject prefixing.
   */
  async replyToThread({
    threadId,
    body,
    replyAll = false,
    cc,
    fromEmail,
  }: {
    threadId: string
    body: string
    replyAll?: boolean
    cc?: Array<{ email: string }>
    fromEmail?: string
  }): Promise<EmptyThreadError | AuthError | ApiError | gmail_v1.Schema$Message> {
    const { parsed: thread } = await this.getThread({ threadId })
    if (thread.messages.length === 0) {
      return new EmptyThreadError({ threadId })
    }

    const lastMsg = thread.messages[thread.messages.length - 1]!

    const replyTo = lastMsg.replyTo ?? lastMsg.from.email
    const to = [{ email: replyTo }]

    let resolvedCc: Array<{ email: string }> | undefined
    if (replyAll) {
      const profile = await this.getProfile()
      if (profile instanceof Error) return profile
      const myEmail = profile.emailAddress.toLowerCase()

      const allRecipients = [
        ...lastMsg.to.map((r) => r.email),
        ...(lastMsg.cc?.map((r) => r.email) ?? []),
      ]
        .filter((e) => e.toLowerCase() !== myEmail)
        .filter((e) => e.toLowerCase() !== replyTo.toLowerCase())

      if (allRecipients.length > 0) {
        resolvedCc = allRecipients.map((e) => ({ email: e }))
      }
    }

    if (cc) {
      resolvedCc = [...(resolvedCc ?? []), ...cc]
    }

    const refs = [lastMsg.references, lastMsg.messageId].filter(Boolean).join(' ')

    const result = await this.sendMessage({
      to,
      subject: lastMsg.subject.startsWith('Re:') ? lastMsg.subject : `Re: ${lastMsg.subject}`,
      body,
      cc: resolvedCc,
      threadId,
      inReplyTo: lastMsg.messageId,
      references: refs || undefined,
      fromEmail,
    })

    await this.invalidateThread(threadId)

    return result
  }

  /**
   * Forward a thread. Fetches the last message, renders its body,
   * builds the "Forwarded message" block, and sends.
   */
  async forwardThread({
    threadId,
    to,
    body,
    fromEmail,
  }: {
    threadId: string
    to: Array<{ email: string }>
    body?: string
    fromEmail?: string
  }): Promise<EmptyThreadError | gmail_v1.Schema$Message> {
    const { parsed: thread } = await this.getThread({ threadId })
    if (thread.messages.length === 0) {
      return new EmptyThreadError({ threadId })
    }

    const lastMsg = thread.messages[thread.messages.length - 1]!
    const renderedBody = renderEmailBody(lastMsg.body, lastMsg.mimeType)

    const fromStr = lastMsg.from.name && lastMsg.from.name !== lastMsg.from.email
      ? `${lastMsg.from.name} <${lastMsg.from.email}>`
      : lastMsg.from.email

    const fullBody = [
      body ?? '',
      '',
      '---------- Forwarded message ----------',
      `From: ${fromStr}`,
      `Date: ${lastMsg.date}`,
      `Subject: ${lastMsg.subject}`,
      `To: ${lastMsg.to.map((t) => t.email).join(', ')}`,
      '',
      renderedBody,
    ].join('\n')

    return this.sendMessage({
      to,
      subject: `Fwd: ${lastMsg.subject}`,
      body: fullBody,
      fromEmail,
    })
  }

  // =========================================================================
  // Draft operations
  // =========================================================================

  async createDraft({
    to,
    subject,
    body,
    cc,
    bcc,
    threadId,
    fromEmail,
    attachments,
  }: {
    to: Array<{ name?: string; email: string }>
    subject: string
    body: string
    cc?: Array<{ name?: string; email: string }>
    bcc?: Array<{ name?: string; email: string }>
    threadId?: string
    fromEmail?: string
    attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>
  }) {
    const raw = this.buildMimeMessage({ to, subject, body, cc, bcc, attachments, fromEmail })

    const res = await withRetry(() =>
      this.gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: { raw, threadId },
        },
      }),
    )

    return res.data
  }

  async getDraft({ draftId }: { draftId: string }): Promise<NotFoundError | AuthError | ApiError | { id: string; message: ParsedMessage; to: string[]; cc: string[]; bcc: string[] }> {
    const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
      withRetry(() =>
        this.gmail.users.drafts.get({
          userId: 'me',
          id: draftId,
          format: 'full',
        }),
      ),
    )
    if (res instanceof Error) return res

    if (!res.data || !res.data.message) return new NotFoundError({ resource: `draft ${draftId}` })

    const message = this.parseMessage(res.data.message)
    const headers = res.data.message.payload?.headers ?? []

    return {
      id: res.data.id ?? draftId,
      message,
      to: this.getHeaderValues(headers, 'to'),
      cc: this.getHeaderValues(headers, 'cc'),
      bcc: this.getHeaderValues(headers, 'bcc'),
    }
  }

  async listDrafts({
    query,
    maxResults = 20,
    pageToken,
  }: {
    query?: string
    maxResults?: number
    pageToken?: string
  } = {}): Promise<{ drafts: Array<{ id: string; threadId: string | null; subject: string; to: string[]; date: string; snippet: string }>; nextPageToken: string | null } | AuthError | ApiError> {
    const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
      withRetry(() =>
        this.gmail.users.drafts.list({
          userId: 'me',
          q: query || undefined,
          maxResults,
          pageToken: pageToken || undefined,
        }),
      ),
    )
    if (res instanceof Error) return res

    const drafts = await mapConcurrent(res.data.drafts ?? [], async (draft) => {
      if (!draft.id) return null
      // Boundary: drafts.get — auth errors abort via mapConcurrent, others skip.
      const detail = await gmailBoundary(this.account?.email ?? 'unknown', () =>
        withRetry(() =>
          this.gmail.users.drafts.get({
            userId: 'me',
            id: draft.id!,
            format: 'metadata',
          }),
        ),
      )
      if (detail instanceof AuthError) return detail
      if (detail instanceof Error) return null
      if (!detail.data.message) return null
      const headers = detail.data.message.payload?.headers ?? []
      return {
        id: draft.id,
        threadId: detail.data.message.threadId ?? null,
        subject: this.getHeader(headers, 'subject') ?? '(no subject)',
        to: this.getHeaderValues(headers, 'to'),
        date: this.getHeader(headers, 'date') ?? '',
        snippet: detail.data.message.snippet ?? '',
      }
    })

    if (drafts instanceof Error) return drafts

    return {
      drafts: drafts.filter((d): d is NonNullable<typeof d> => d !== null),
      nextPageToken: res.data.nextPageToken ?? null,
    }
  }

  async sendDraft({ draftId }: { draftId: string }) {
    const res = await withRetry(() =>
      this.gmail.users.drafts.send({
        userId: 'me',
        requestBody: { id: draftId },
      }),
    )

    return res.data
  }

  async deleteDraft({ draftId }: { draftId: string }) {
    await withRetry(() =>
      this.gmail.users.drafts.delete({
        userId: 'me',
        id: draftId,
      }),
    )
  }

  // =========================================================================
  // Label mutations (read/unread, star, archive, trash, labels)
  // =========================================================================

  async markAsRead({ threadIds }: { threadIds: string[] }): Promise<void | AuthError | ApiError> {
    const messageIds = await this.getMessageIdsForThreads(threadIds, (labelIds) =>
      labelIds.includes('UNREAD'),
    )
    if (messageIds instanceof Error) return messageIds
    if (messageIds.length === 0) return
    await this.batchModifyMessages(messageIds, { removeLabelIds: ['UNREAD'] })
    await this.invalidateAfterThreadMutation(threadIds)
  }

  async markAsUnread({ threadIds }: { threadIds: string[] }): Promise<void | AuthError | ApiError> {
    const messageIds = await this.getMessageIdsForThreads(threadIds, (labelIds) =>
      !labelIds.includes('UNREAD'),
    )
    if (messageIds instanceof Error) return messageIds
    if (messageIds.length === 0) return
    await this.batchModifyMessages(messageIds, { addLabelIds: ['UNREAD'] })
    await this.invalidateAfterThreadMutation(threadIds)
  }

  async star({ threadIds }: { threadIds: string[] }): Promise<void | AuthError | ApiError> {
    const messageIds = await this.getMessageIdsForThreads(threadIds)
    if (messageIds instanceof Error) return messageIds
    if (messageIds.length === 0) return
    await this.batchModifyMessages(messageIds, { addLabelIds: ['STARRED'] })
    await this.invalidateAfterThreadMutation(threadIds)
  }

  async unstar({ threadIds }: { threadIds: string[] }): Promise<void | AuthError | ApiError> {
    const messageIds = await this.getMessageIdsForThreads(threadIds, (labelIds) =>
      labelIds.includes('STARRED'),
    )
    if (messageIds instanceof Error) return messageIds
    if (messageIds.length === 0) return
    await this.batchModifyMessages(messageIds, { removeLabelIds: ['STARRED'] })
    await this.invalidateAfterThreadMutation(threadIds)
  }

  async modifyLabels({
    threadIds,
    addLabelIds = [],
    removeLabelIds = [],
  }: {
    threadIds: string[]
    addLabelIds?: string[]
    removeLabelIds?: string[]
  }): Promise<void | AuthError | ApiError> {
    // Resolve add labels (auto-create if missing), but only look up remove labels (never create)
    const resolvedAdd = await Promise.all(addLabelIds.map((l) => this.resolveLabelId(l)))
    const addErr = resolvedAdd.find((r): r is AuthError | ApiError => r instanceof Error)
    if (addErr) return addErr

    const resolvedRemoveRaw = await Promise.all(removeLabelIds.map((l) => this.lookupLabelId(l)))
    const removeErr = resolvedRemoveRaw.find((r): r is AuthError | ApiError => r instanceof Error)
    if (removeErr) return removeErr
    const resolvedRemove = resolvedRemoveRaw.filter((id): id is string => typeof id === 'string')

    const messageIds = await this.getMessageIdsForThreads(threadIds)
    if (messageIds instanceof Error) return messageIds
    if (messageIds.length === 0) return

    await this.batchModifyMessages(messageIds, {
      addLabelIds: resolvedAdd.filter((r): r is string => typeof r === 'string'),
      removeLabelIds: resolvedRemove,
    })
    await this.invalidateAfterThreadMutation(threadIds)
  }

  async trash({ threadId }: { threadId: string }) {
    await withRetry(() =>
      this.gmail.users.threads.trash({
        userId: 'me',
        id: threadId,
      }),
    )
    await this.invalidateAfterThreadMutation([threadId])
  }

  async untrash({ threadId }: { threadId: string }) {
    await withRetry(() =>
      this.gmail.users.threads.untrash({
        userId: 'me',
        id: threadId,
      }),
    )
    await this.invalidateAfterThreadMutation([threadId])
  }

  async archive({ threadIds }: { threadIds: string[] }): Promise<void | AuthError | ApiError> {
    const messageIds = await this.getMessageIdsForThreads(threadIds)
    if (messageIds instanceof Error) return messageIds
    if (messageIds.length === 0) return
    await this.batchModifyMessages(messageIds, { removeLabelIds: ['INBOX'] })
    await this.invalidateAfterThreadMutation(threadIds)
  }

  /** Invalidate thread cache after a thread mutation. */
  private async invalidateAfterThreadMutation(threadIds: string[]): Promise<void> {
    await this.invalidateThreads(threadIds)
  }

  /** Moves all spam threads to trash. Does not permanently delete. */
  async trashAllSpam(): Promise<{ count: number } | AuthError | ApiError> {
    let totalDeleted = 0
    let pageToken: string | undefined

    while (true) {
      const res = await this.listThreads({
        folder: 'spam',
        maxResults: 100,
        pageToken,
      })
      if (res instanceof Error) return res

      if (res.threads.length === 0) break

      const threadIds = res.threads.map((t) => t.id)
      const messageIds = await this.getMessageIdsForThreads(threadIds)
      if (messageIds instanceof Error) return messageIds
      await this.batchModifyMessages(messageIds, {
        addLabelIds: ['TRASH'],
        removeLabelIds: ['SPAM', 'INBOX'],
      })

      totalDeleted += threadIds.length
      pageToken = res.nextPageToken ?? undefined
      if (!pageToken) break
    }

    return { count: totalDeleted }
  }

  // =========================================================================
  // Labels CRUD
  // =========================================================================

  async listLabels(): Promise<{ parsed: ReturnType<GmailClient['parseLabels']>; raw: gmail_v1.Schema$Label[] } | AuthError | ApiError> {
    // Check cache
    const cached = await this.getCachedLabels()
    if (cached) {
      return { parsed: this.parseLabels(cached), raw: cached }
    }

    const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
      withRetry(() =>
        this.gmail.users.labels.list({ userId: 'me' }),
      ),
    )
    if (res instanceof Error) return res

    const rawLabels = res.data.labels ?? []

    // Write cache
    await this.cacheLabelsData(rawLabels)

    return { parsed: this.parseLabels(rawLabels), raw: rawLabels }
  }

  async getLabel({ labelId }: { labelId: string }) {
    const res = await withRetry(() =>
      this.gmail.users.labels.get({
        userId: 'me',
        id: labelId,
      }),
    )

    return {
      id: res.data.id ?? labelId,
      name: res.data.name ?? '',
      type: (res.data.type ?? 'user') as 'system' | 'user',
      messagesTotal: res.data.messagesTotal ?? 0,
      messagesUnread: res.data.messagesUnread ?? 0,
      threadsTotal: res.data.threadsTotal ?? 0,
      threadsUnread: res.data.threadsUnread ?? 0,
      color: res.data.color
        ? {
            backgroundColor: res.data.color.backgroundColor ?? '',
            textColor: res.data.color.textColor ?? '',
          }
        : null,
    }
  }

  async createLabel({
    name,
    color,
  }: {
    name: string
    color?: { backgroundColor: string; textColor: string }
  }) {
    const res = await withRetry(() =>
      this.gmail.users.labels.create({
        userId: 'me',
        requestBody: {
          name,
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show',
          color,
        },
      }),
    )

    await this.invalidateLabels()

    return {
      id: res.data.id ?? '',
      name: res.data.name ?? name,
    }
  }

  async deleteLabel({ labelId }: { labelId: string }) {
    await withRetry(() =>
      this.gmail.users.labels.delete({
        userId: 'me',
        id: labelId,
      }),
    )
    this.labelIdCache = {}
    await this.invalidateLabels()
  }

  // =========================================================================
  // Label counts (unread counts per folder/label)
  // =========================================================================

  async getLabelCounts(): Promise<{ parsed: Array<{ label: string; count: number }>; raw: gmail_v1.Schema$Label[]; archiveEstimate: number | null } | AuthError | ApiError> {
    // Always fresh: label counts are user-facing live data.

    // Archive count is best-effort — auth errors propagate, others yield null.
    const archiveRes = await gmailBoundary(this.account?.email ?? 'unknown', () =>
      withRetry(() =>
        this.gmail.users.threads.list({
          userId: 'me',
          q: 'in:archive',
          maxResults: 1,
        }),
      ),
    )
    if (archiveRes instanceof AuthError) return archiveRes
    // archiveRes may be ApiError (non-auth failure) — archive count unavailable
    const labelsResult = await this.listLabels()
    if (labelsResult instanceof Error) return labelsResult

    // Fetch detailed counts for each label — collect both raw and parsed
    const rawDetails: gmail_v1.Schema$Label[] = []
    const counts = await mapConcurrent(labelsResult.parsed, async (label) => {
      if (!label.id) return null
      // Boundary: labels.get — auth errors abort via mapConcurrent, others skip.
      const detail = await gmailBoundary(this.account?.email ?? 'unknown', () =>
        withRetry(() =>
          this.gmail.users.labels.get({
            userId: 'me',
            id: label.id,
          }),
        ),
      )
      if (detail instanceof AuthError) return detail
      if (detail instanceof Error) return null
      rawDetails.push(detail.data)
      const labelName = (detail.data.name ?? detail.data.id ?? '').toLowerCase()
      const isTotalLabel = labelName === 'draft' || labelName === 'sent'
      return {
        label: labelName === 'draft' ? 'drafts' : labelName,
        count: Number(isTotalLabel ? detail.data.threadsTotal : detail.data.threadsUnread) || 0,
      }
    })

    if (counts instanceof Error) return counts

    const result = counts.filter((c): c is NonNullable<typeof c> => c !== null)

    // Add archive count (same as Zero's count() method)
    if (!(archiveRes instanceof Error)) {
      result.push({
        label: 'archive',
        count: Number(archiveRes.data.resultSizeEstimate ?? 0),
      })
    }

    const archiveEstimate = !(archiveRes instanceof Error) ? Number(archiveRes.data.resultSizeEstimate ?? 0) : null

    return { parsed: result, raw: rawDetails, archiveEstimate }
  }

  // =========================================================================
  // Attachments
  // =========================================================================

  async getAttachment({
    messageId,
    attachmentId,
  }: {
    messageId: string
    attachmentId: string
  }) {
    const res = await withRetry(() =>
      this.gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachmentId,
      }),
    )

    const data = res.data.data ?? ''
    // Convert base64url to standard base64
    return data.replace(/-/g, '+').replace(/_/g, '/')
  }

  // =========================================================================
  // Account / profile
  // =========================================================================

  async getProfile(): Promise<{ emailAddress: string; messagesTotal: number; threadsTotal: number; historyId: string } | AuthError | ApiError> {
    // Check cache
    const cached = await this.getCachedProfile()
    if (cached) return cached

    const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
      withRetry(() =>
        this.gmail.users.getProfile({ userId: 'me' }),
      ),
    )
    if (res instanceof Error) return res

    const profile = {
      emailAddress: res.data.emailAddress ?? '',
      messagesTotal: res.data.messagesTotal ?? 0,
      threadsTotal: res.data.threadsTotal ?? 0,
      historyId: res.data.historyId ?? '',
    }

    // Write cache
    await this.cacheProfileData(profile)

    return profile
  }

  // =========================================================================
  // Parsing: raw Google API responses → typed objects
  // =========================================================================

  /** Parse a raw gmail_v1.Schema$Thread (format: full) into ThreadData. */
  parseThread(raw: gmail_v1.Schema$Thread): ThreadData {
    const messages = (raw.messages ?? []).map((m) => this.parseMessage(m))

    if (messages.length === 0) {
      return {
        id: raw.id ?? '',
        historyId: raw.historyId ?? null,
        messages: [],
        subject: '',
        snippet: '',
        from: { email: '' },
        date: '',
        labelIds: [],
        hasUnread: false,
        messageCount: 0,
      }
    }

    const latest = messages.findLast((m) => !m.isDraft) ?? messages[messages.length - 1]!
    const allLabels = [...new Set(messages.flatMap((m) => m.labelIds))]

    return {
      id: raw.id ?? '',
      historyId: raw.historyId ?? null,
      messages,
      subject: latest.subject,
      snippet: latest.snippet,
      from: latest.from,
      date: latest.date,
      labelIds: allLabels,
      hasUnread: messages.some((m) => m.unread),
      messageCount: messages.filter((m) => !m.isDraft).length,
    }
  }

  /** Parse a raw gmail_v1.Schema$Message into ParsedMessage. */
  parseMessage(message: gmail_v1.Schema$Message): ParsedMessage {
    const headers = message.payload?.headers ?? []
    const labelIds = message.labelIds ?? []

    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null

    const fromHeader = getHeader('from') ?? ''
    const toHeader = getHeader('to') ?? ''
    const ccHeaders = headers
      .filter((h) => h.name?.toLowerCase() === 'cc')
      .map((h) => h.value ?? '')
      .filter((v) => v.length > 0)

    const { body, mimeType, textBody } = this.extractBody(message.payload ?? {})

    return {
      id: message.id ?? '',
      threadId: message.threadId ?? '',
      subject: (getHeader('subject') ?? '(no subject)').replace(/"/g, '').trim(),
      snippet: sanitizeSnippet(message.snippet ?? ''),
      from: parseFrom(fromHeader),
      to: toHeader ? parseAddressList(toHeader) : [],
      cc:
        ccHeaders.length > 0
          ? ccHeaders.filter((h) => h.trim().length > 0).flatMap((h) => parseAddressList(h))
          : null,
      bcc: [],
      replyTo: getHeader('reply-to') ?? undefined,
      date: getHeader('date') ?? '',
      labelIds,
      unread: labelIds.includes('UNREAD'),
      starred: labelIds.includes('STARRED'),
      isDraft: labelIds.includes('DRAFT'),
      messageId: getHeader('message-id') ?? '',
      inReplyTo: getHeader('in-reply-to') ?? undefined,
      references: getHeader('references') ?? undefined,
      listUnsubscribe: getHeader('list-unsubscribe') ?? undefined,
      body,
      mimeType,
      textBody,
      attachments: this.extractAttachmentMeta(message.payload?.parts ?? []),
    }
  }

  /** Parse raw gmail_v1.Schema$Thread (format: metadata) into ThreadListItem.
   *  Shows the other party in conversations where user sent the latest message. */
  parseThreadListItem(raw: gmail_v1.Schema$Thread): ThreadListItem {
    const messages = raw.messages ?? []
    const nonDraftMessages = messages.filter((m) => !m.labelIds?.includes('DRAFT'))
    const latest = nonDraftMessages[nonDraftMessages.length - 1] ?? messages[messages.length - 1]

    const headers = latest?.payload?.headers ?? []
    const allLabels = [...new Set(messages.flatMap((m) => m.labelIds ?? []))]

    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null

    // Determine display sender — show other party when user sent the latest message
    let displayFrom = parseFrom(getHeader('from') ?? '')
    const latestIsFromUser = latest?.labelIds?.includes('SENT') ?? false

    if (latestIsFromUser && this.account?.email) {
      const getMsgHeader = (msg: gmail_v1.Schema$Message, name: string) =>
        msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null

      // Find most recent message NOT from the user
      const otherPartyMsg = nonDraftMessages.findLast((m) => !m.labelIds?.includes('SENT'))
      if (otherPartyMsg) {
        const fromHeader = getMsgHeader(otherPartyMsg, 'from')
        if (fromHeader) displayFrom = parseFrom(fromHeader)
      } else {
        // All messages from user — show first recipient
        const firstMsg = nonDraftMessages[0] ?? messages[0]
        if (firstMsg) {
          const toHeader = getMsgHeader(firstMsg, 'to') ?? ''
          const recipients = parseAddressList(toHeader)
          if (recipients[0]) displayFrom = recipients[0]
        }
      }
    }

    return {
      id: raw.id ?? '',
      historyId: raw.historyId ?? null,
      snippet: sanitizeSnippet(latest?.snippet ?? ''),
      subject: (getHeader('subject') ?? '(no subject)').replace(/"/g, '').trim(),
      from: displayFrom,
      date: getHeader('date') ?? '',
      labelIds: allLabels,
      unread: allLabels.includes('UNREAD'),
      messageCount: nonDraftMessages.length,
    }
  }

  /** Parse raw gmail_v1.Schema$Label[] from labels.list into our label objects. */
  parseLabels(rawLabels: gmail_v1.Schema$Label[]) {
    return rawLabels.map((label) => ({
      id: label.id ?? '',
      name: label.name ?? '',
      type: (label.type ?? 'user') as 'system' | 'user',
      messageListVisibility: label.messageListVisibility ?? null,
      labelListVisibility: label.labelListVisibility ?? null,
      color: label.color
        ? {
            backgroundColor: label.color.backgroundColor ?? '',
            textColor: label.color.textColor ?? '',
          }
        : null,
    }))
  }

  /** Parse raw gmail_v1.Schema$Label[] (with counts) into label count objects. */
  parseLabelCounts(rawLabels: gmail_v1.Schema$Label[], archiveEstimate: number | null) {
    const result = rawLabels.map((detail) => {
      const labelName = (detail.name ?? detail.id ?? '').toLowerCase()
      const isTotalLabel = labelName === 'draft' || labelName === 'sent'
      return {
        label: labelName === 'draft' ? 'drafts' : labelName,
        count: Number(isTotalLabel ? detail.threadsTotal : detail.threadsUnread) || 0,
      }
    })

    if (archiveEstimate !== null) {
      result.push({ label: 'archive', count: archiveEstimate })
    }

    return result
  }

  // =========================================================================
  // Private: body/attachment extraction
  // =========================================================================

  private extractBody(payload: gmail_v1.Schema$MessagePart): {
    body: string
    mimeType: string
    textBody: string | null
  } {
    if (payload.body?.data) {
      const mime = payload.mimeType ?? 'text/plain'
      return {
        body: decodeBase64Url(payload.body.data),
        mimeType: mime,
        textBody: mime === 'text/plain' ? decodeBase64Url(payload.body.data) : null,
      }
    }

    if (!payload.parts) {
      return { body: '', mimeType: 'text/plain', textBody: null }
    }

    const htmlData = this.findBodyPart(payload.parts, 'text/html')
    const textData = this.findBodyPart(payload.parts, 'text/plain')
    const textBody = textData ? decodeBase64Url(textData) : null

    if (htmlData) {
      return { body: decodeBase64Url(htmlData), mimeType: 'text/html', textBody }
    }

    if (textData) {
      return { body: textBody!, mimeType: 'text/plain', textBody }
    }

    for (const part of payload.parts) {
      if (part.parts) {
        const nested = this.extractBody(part)
        if (nested.body) return nested
      }
    }

    return { body: '', mimeType: 'text/plain', textBody: null }
  }

  private findBodyPart(parts: gmail_v1.Schema$MessagePart[], mimeType: string): string | null {
    for (const part of parts) {
      if (part.mimeType === mimeType && part.body?.data) {
        return part.body.data
      }
      if (part.parts) {
        const found = this.findBodyPart(part.parts, mimeType)
        if (found) return found
      }
    }
    return null
  }

  private extractAttachmentMeta(parts: gmail_v1.Schema$MessagePart[]): AttachmentMeta[] {
    const results: AttachmentMeta[] = []

    for (const part of parts) {
      if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
        const disposition =
          part.headers?.find((h) => h.name?.toLowerCase() === 'content-disposition')?.value ?? ''
        const hasContentId = part.headers?.some((h) => h.name?.toLowerCase() === 'content-id')
        const isInline = disposition.toLowerCase().includes('inline')

        if (!isInline || !hasContentId) {
          results.push({
            attachmentId: part.body.attachmentId,
            filename: part.filename,
            mimeType: part.mimeType ?? 'application/octet-stream',
            size: Number(part.body.size ?? 0),
          })
        }
      }

      if (part.parts) {
        results.push(...this.extractAttachmentMeta(part.parts))
      }
    }

    return results
  }

  async getEmailAliases(): Promise<Array<{ email: string; name?: string; primary: boolean }> | AuthError | ApiError> {
    const profile = await this.getProfile()
    if (profile instanceof Error) return profile
    const primaryEmail = profile.emailAddress

    const aliases: Array<{ email: string; name?: string; primary: boolean }> = [
      { email: primaryEmail, primary: true },
    ]

    // Boundary: sendAs.list — auth errors propagate; permission-denied is expected
    // (some accounts lack Gmail settings access) and yields primary email only.
    const settings = await gmailBoundary(this.account?.email ?? 'unknown', () =>
      withRetry(() =>
        this.gmail.users.settings.sendAs.list({ userId: 'me' }),
      ),
    )
    if (settings instanceof AuthError) return settings
    if (settings instanceof Error) return aliases // permission denied — return primary only

    for (const alias of settings.data.sendAs ?? []) {
      if (alias.isPrimary && alias.sendAsEmail === primaryEmail) continue
      aliases.push({
        email: alias.sendAsEmail ?? '',
        name: alias.displayName ?? undefined,
        primary: alias.isPrimary ?? false,
      })
    }

    return aliases
  }

  // =========================================================================
  // History / sync
  // =========================================================================

  async listHistory({
    startHistoryId,
    labelId,
    historyTypes,
  }: {
    startHistoryId: string
    labelId?: string
    historyTypes?: Array<'messageAdded' | 'messageDeleted' | 'labelAdded' | 'labelRemoved'>
  }): Promise<{ history: gmail_v1.Schema$History[]; historyId: string } | AuthError | ApiError> {
    const allHistory: gmail_v1.Schema$History[] = []
    let pageToken: string | undefined
    let latestHistoryId = startHistoryId

    while (true) {
      const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
        withRetry(() =>
          this.gmail.users.history.list({
            userId: 'me',
            startHistoryId,
            labelId,
            historyTypes,
            pageToken,
          }),
        ),
      )
      if (res instanceof Error) return res

      if (res.data.history) {
        allHistory.push(...res.data.history)
      }
      latestHistoryId = res.data.historyId ?? latestHistoryId

      pageToken = res.data.nextPageToken ?? undefined
      if (!pageToken) break
    }

    return {
      history: allHistory,
      historyId: latestHistoryId,
    }
  }

  // =========================================================================
  // Watch: async generator for inbox polling via History API
  // =========================================================================

  /**
   * Poll for new messages using the Gmail History API.
   * Yields WatchEvent objects as new messages arrive.
   * Handles history seeding, expiry re-seeding, and client-side query filtering.
   * Persists historyId in the DB so it survives across CLI invocations.
   */
  async *watchInbox({
    folder = 'inbox',
    intervalMs = 15_000,
    query,
    once = false,
  }: {
    folder?: string
    intervalMs?: number
    query?: string
    once?: boolean
  } = {}): AsyncGenerator<WatchEvent> {
    if (!this.account) throw new MissingDataError({ what: 'authenticated account', resource: 'watchInbox' })

    const filterLabelId = WATCH_FOLDER_LABELS[folder]
    if (!filterLabelId) {
      throw new NotFoundError({ resource: `watch folder "${folder}". Supported: ${Object.keys(WATCH_FOLDER_LABELS).join(', ')}` })
    }

    // Seed historyId — guaranteed non-undefined after this block
    let historyId: string = await getLastHistoryId(this.account) ?? ''
    if (!historyId) {
      const profile = await this.getProfile()
      if (profile instanceof Error) throw profile
      historyId = profile.historyId
      await setLastHistoryId(this.account, historyId)
    }

    while (true) {
      // listHistory returns errors as values — check and handle history expiry.
      const historyResult = await this.listHistory({
        startHistoryId: historyId,
        labelId: filterLabelId,
        historyTypes: ['messageAdded'],
      })

      if (historyResult instanceof Error) {
        if (!isHistoryExpired(historyResult)) throw historyResult
        // historyId expired — Google only keeps ~7 days. Re-seed.
        const profile = await this.getProfile()
        if (profile instanceof Error) throw profile
        historyId = profile.historyId
        await setLastHistoryId(this.account, historyId)
        // Retry once after reseed
        const retryResult = await this.listHistory({ startHistoryId: historyId, labelId: filterLabelId, historyTypes: ['messageAdded'] })
        if (retryResult instanceof Error) throw retryResult
        yield* this.pollOnceFromHistory(retryResult, historyId, query, (newId) => { historyId = newId })
      } else {
        yield* this.pollOnceFromHistory(historyResult, historyId, query, (newId) => { historyId = newId })
      }

      if (once) return
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  /** Single poll tick from pre-fetched history — yields WatchEvents for new messages. */
  private async *pollOnceFromHistory(
    historyData: { history: gmail_v1.Schema$History[]; historyId: string },
    prevHistoryId: string,
    query: string | undefined,
    updateHistoryId: (newId: string) => void,
  ): AsyncGenerator<WatchEvent> {
    const { history, historyId: newHistoryId } = historyData

    if (newHistoryId !== prevHistoryId) {
      updateHistoryId(newHistoryId)
      await setLastHistoryId(this.account!, newHistoryId)
    }

    if (history.length === 0) return

    // Collect unique message IDs from messageAdded events
    const seenIds = new Set<string>()
    const messageIds: string[] = []

    for (const entry of history) {
      for (const added of entry.messagesAdded ?? []) {
        const id = added.message?.id
        if (id && !seenIds.has(id)) {
          seenIds.add(id)
          messageIds.push(id)
        }
      }
    }

    if (messageIds.length === 0) return

    // Hydrate messages with metadata (bounded concurrency).
    // getMessage returns errors as values — auth errors abort via mapConcurrent,
    // 404s (message deleted between history and hydration) are skipped.
    const hydrated = await mapConcurrent(messageIds, async (msgId) => {
      const msg = await this.getMessage({ messageId: msgId, format: 'metadata' })
      if (msg instanceof AuthError) return msg // abort batch
      if (msg instanceof Error) return null    // skip this message
      if ('raw' in msg) return null
      if (query && !matchesQuery(msg, query)) return null
      return msg
    })
    if (hydrated instanceof Error) throw hydrated // propagate to generator consumer

    for (const msg of hydrated) {
      if (!msg) continue
      yield {
        account: this.account!,
        type: 'new_message',
        message: msg,
        threadId: msg.threadId,
      }
    }
  }

  // =========================================================================
  // Private: MIME message construction
  // =========================================================================

  private buildMimeMessage({
    to,
    subject,
    body,
    cc,
    bcc,
    inReplyTo,
    references,
    attachments,
    fromEmail,
  }: {
    to: Array<{ name?: string; email: string }>
    subject: string
    body: string
    cc?: Array<{ name?: string; email: string }>
    bcc?: Array<{ name?: string; email: string }>
    inReplyTo?: string
    references?: string
    attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>
    fromEmail?: string
  }) {
    const msg = createMimeMessage()

    // Gmail API replaces the From header with the authenticated user's email on send.
    // For drafts, if no fromEmail is provided, Gmail uses the default sending address.
    // 'me' is a valid Gmail API alias that gets resolved server-side.
    msg.setSender(fromEmail || 'me')
    msg.setRecipients(to.map((r) => ({ name: r.name ?? '', addr: r.email })))

    if (cc && cc.length > 0) {
      msg.setCc(cc.map((r) => ({ name: r.name ?? '', addr: r.email })))
    }

    if (bcc && bcc.length > 0) {
      msg.setBcc(bcc.map((r) => ({ name: r.name ?? '', addr: r.email })))
    }

    msg.setSubject(subject)

    // Detect if body is HTML
    const isHtml = /<[a-z][\s\S]*>/i.test(body)
    msg.addMessage({
      contentType: isHtml ? 'text/html' : 'text/plain',
      data: body,
    })

    if (inReplyTo) {
      msg.setHeader('In-Reply-To', sanitizeHeaderValue(inReplyTo))
    }

    if (references) {
      const refs = references
        .split(' ')
        .filter(Boolean)
        .map((ref) => {
          ref = sanitizeHeaderValue(ref)
          if (!ref.startsWith('<')) ref = `<${ref}`
          if (!ref.endsWith('>')) ref = `${ref}>`
          return ref
        })
      msg.setHeader('References', refs.join(' '))
    }

    if (attachments) {
      for (const att of attachments) {
        msg.addAttachment({
          filename: att.filename,
          contentType: att.mimeType,
          data: att.content.toString('base64'),
        })
      }
    }

    return encodeBase64Url(msg.asRaw())
  }

  // =========================================================================
  // Private: label resolution
  // =========================================================================

  /** Look up a label ID by name. Returns null if not found (never creates). */
  private async lookupLabelId(labelNameOrId: string): Promise<string | null | AuthError | ApiError> {
    if (SYSTEM_LABEL_IDS.has(labelNameOrId)) return labelNameOrId
    if (this.labelIdCache[labelNameOrId]) return this.labelIdCache[labelNameOrId]!

    const labelsResult = await this.listLabels()
    if (labelsResult instanceof Error) return labelsResult
    const { parsed: labels } = labelsResult
    const match = labels.find((l) => l.name.toLowerCase() === labelNameOrId.toLowerCase())
    if (match) {
      this.labelIdCache[labelNameOrId] = match.id
      return match.id
    }

    return null
  }

  /** Resolve a label ID by name, auto-creating if it doesn't exist. */
  private async resolveLabelId(labelNameOrId: string): Promise<string | AuthError | ApiError> {
    if (SYSTEM_LABEL_IDS.has(labelNameOrId)) return labelNameOrId
    if (this.labelIdCache[labelNameOrId]) return this.labelIdCache[labelNameOrId]!

    const labelsResult = await this.listLabels()
    if (labelsResult instanceof Error) return labelsResult
    const { parsed: labels } = labelsResult
    const match = labels.find((l) => l.name.toLowerCase() === labelNameOrId.toLowerCase())
    if (match) {
      this.labelIdCache[labelNameOrId] = match.id
      return match.id
    }

    // Label doesn't exist — create it
    const created = await this.createLabel({
      name: labelNameOrId.charAt(0).toUpperCase() + labelNameOrId.slice(1).toLowerCase(),
    })
    this.labelIdCache[labelNameOrId] = created.id
    return created.id
  }

  // =========================================================================
  // Private: search / folder normalization
  // =========================================================================

  private buildSearchParams(
    folder?: string,
    query?: string,
    labelIds?: string[],
  ) {
    const resolvedLabelIds = [...(labelIds ?? [])]
    let q = query ?? ''

    if (!folder || folder === 'inbox') {
      if (!resolvedLabelIds.includes('INBOX')) {
        resolvedLabelIds.push('INBOX')
      }
      return { q, resolvedLabelIds }
    }

    // For non-inbox folders, use Gmail search syntax.
    // Caller-provided labelIds are preserved as additional filters.
    switch (folder) {
      case 'sent':
        q = `in:sent ${q}`.trim()
        break
      case 'trash':
      case 'bin':
        q = `in:trash ${q}`.trim()
        break
      case 'spam':
        q = `in:spam ${q}`.trim()
        break
      case 'drafts':
      case 'draft':
        q = `is:draft ${q}`.trim()
        break
      case 'starred':
        q = `is:starred ${q}`.trim()
        break
      case 'archive':
        q = `in:archive ${q}`.trim()
        break
      case 'snoozed':
        q = `label:Snoozed ${q}`.trim()
        break
      case 'all':
        q = `in:anywhere ${q}`.trim()
        break
      default:
        // Treat as a label name
        q = `label:${folder} ${q}`.trim()
        break
    }

    return { q, resolvedLabelIds }
  }

  // =========================================================================
  // Private: batch operations
  // =========================================================================

  private async getMessageIdsForThreads(
    threadIds: string[],
    filter?: (labelIds: string[]) => boolean,
  ): Promise<string[] | AuthError | ApiError> {
    const allIds: string[] = []

    const result = await mapConcurrent(threadIds, async (threadId) => {
      const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
        withRetry(() =>
          this.gmail.users.threads.get({
            userId: 'me',
            id: threadId,
            format: 'metadata',
          }),
        ),
      )
      if (res instanceof Error) return res

      for (const msg of res.data.messages ?? []) {
        if (!msg.id) continue
        if (filter && !filter(msg.labelIds ?? [])) continue
        allIds.push(msg.id)
      }
    })
    if (result instanceof Error) return result

    return [...new Set(allIds)]
  }

  private async batchModifyMessages(
    messageIds: string[],
    body: { addLabelIds?: string[]; removeLabelIds?: string[] },
  ) {
    if (messageIds.length === 0) return

    // Gmail batchModify accepts up to 1000 IDs
    const chunkSize = 1000
    for (let i = 0; i < messageIds.length; i += chunkSize) {
      const chunk = messageIds.slice(i, i + chunkSize)
      await withRetry(() =>
        this.gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: {
            ids: chunk,
            ...body,
          },
        }),
      )
    }
  }

  // =========================================================================
  // Private: header utilities
  // =========================================================================

  private getHeader(
    headers: gmail_v1.Schema$MessagePartHeader[],
    name: string,
  ): string | null {
    return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null
  }

  private getHeaderAll(
    headers: gmail_v1.Schema$MessagePartHeader[],
    name: string,
  ): string[] {
    return headers
      .filter((h) => h.name?.toLowerCase() === name.toLowerCase())
      .map((h) => h.value ?? '')
      .filter((v) => v.length > 0)
  }

  private getHeaderValues(
    headers: gmail_v1.Schema$MessagePartHeader[],
    name: string,
  ): string[] {
    const raw = this.getHeaderAll(headers, name)
    return raw.flatMap((v) =>
      v
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean),
    )
  }
}

// ---------------------------------------------------------------------------
// Watch: folder label mapping
// ---------------------------------------------------------------------------

const WATCH_FOLDER_LABELS: Record<string, string> = {
  inbox: 'INBOX',
  sent: 'SENT',
  trash: 'TRASH',
  spam: 'SPAM',
  starred: 'STARRED',
  drafts: 'DRAFT',
}

// ---------------------------------------------------------------------------
// Watch: sync state persistence (historyId in DB)
// ---------------------------------------------------------------------------

async function getLastHistoryId(account: AccountId): Promise<string | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.syncState.findUnique({
    where: { email_appId_key: { email: account.email, appId: account.appId, key: 'history_id' } },
  })
  return row?.value
}

async function setLastHistoryId(account: AccountId, historyId: string): Promise<void> {
  const prisma = await getPrisma()
  await prisma.syncState.upsert({
    where: { email_appId_key: { email: account.email, appId: account.appId, key: 'history_id' } },
    create: { email: account.email, appId: account.appId, key: 'history_id', value: historyId },
    update: { value: historyId },
  })
}

// ---------------------------------------------------------------------------
// Watch: history expiry detection
// ---------------------------------------------------------------------------

function isHistoryExpired(err: any): boolean {
  const status = err?.code ?? err?.status ?? err?.response?.status
  if (status === 404) return true
  if (status === 400) {
    const message = err?.message ?? err?.response?.data?.error?.message ?? ''
    if (message.includes('historyId')) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Watch: client-side Gmail query matching
// ---------------------------------------------------------------------------
// The History API doesn't support server-side query filtering, so we parse
// common Gmail search operators and match against message metadata.
//
// Supported operators: from:, to:, cc:, subject:, is:unread/read/starred,
// has:attachment, and plain text (matches subject + from).
// Multiple terms are AND-ed together. Quoted phrases and negation supported.
//
// Limitations vs full Gmail search:
// - label: not supported (labelIds are API IDs like Label_123, not names)
// - has:attachment uses Content-Type heuristic (metadata format lacks parts)
// - OR, {}, newer_than:, older_than:, etc. are server-only — warned & skipped
//
// See https://support.google.com/mail/answer/7190 for the full Gmail spec.
// ---------------------------------------------------------------------------

const SERVER_ONLY_OPERATORS = new Set([
  'in', 'label', 'after', 'before', 'newer_than', 'older_than',
  'filename', 'size', 'larger', 'smaller', 'deliveredto', 'rfc822msgid',
  'list', 'category',
])

const SUPPORTED_OPERATORS = new Set([
  'from', 'to', 'cc', 'subject', 'is', 'has',
])

interface QueryTerm {
  operator: string | null
  value: string
  negated: boolean
}

const warnedOperators = new Set<string>()

function matchesQuery(msg: ParsedMessage, query: string): boolean {
  const terms = parseQueryTerms(query)
  return terms.every((term) => matchesTerm(msg, term))
}

function parseQueryTerms(query: string): QueryTerm[] {
  const terms: QueryTerm[] = []
  const regex = /(-?)(?:(\w+):)?(?:"([^"]*)"|([\S]+))/gi
  let match: RegExpExecArray | null

  while ((match = regex.exec(query)) !== null) {
    const negated = match[1] === '-'
    const rawOperator = match[2]?.toLowerCase() ?? null
    const value = (match[3] ?? match[4] ?? '').toLowerCase()
    if (!value) continue

    if (!rawOperator && value === 'or') continue

    if (rawOperator && SERVER_ONLY_OPERATORS.has(rawOperator)) {
      if (!warnedOperators.has(rawOperator)) {
        warnedOperators.add(rawOperator)
        console.error(`# --query: "${rawOperator}:" is a server-only operator (use "mail search" instead), skipping`)
      }
      continue
    }

    if (rawOperator && !SUPPORTED_OPERATORS.has(rawOperator)) {
      if (!warnedOperators.has(rawOperator)) {
        warnedOperators.add(rawOperator)
        console.error(`# --query: unknown operator "${rawOperator}:", skipping`)
      }
      continue
    }

    terms.push({ operator: rawOperator, value, negated })
  }

  return terms
}

function senderMatches(sender: { name?: string; email: string }, value: string): boolean {
  const full = `${sender.name ?? ''} ${sender.email}`.toLowerCase()
  return full.includes(value)
}

function matchesTerm(msg: ParsedMessage, term: QueryTerm): boolean {
  let result: boolean

  switch (term.operator) {
    case 'from':
      result = senderMatches(msg.from, term.value)
      break
    case 'to':
      result = msg.to.some((r) => senderMatches(r, term.value))
      break
    case 'cc':
      result = (msg.cc ?? []).some((r) => senderMatches(r, term.value))
      break
    case 'subject':
      result = msg.subject.toLowerCase().includes(term.value)
      break
    case 'is':
      if (term.value === 'unread') result = msg.unread
      else if (term.value === 'read') result = !msg.unread
      else if (term.value === 'starred') result = msg.starred
      else result = false
      break
    case 'has':
      if (term.value === 'attachment') result = msg.mimeType.includes('multipart/mixed')
      else result = false
      break
    default: {
      const subject = msg.subject.toLowerCase()
      const from = `${msg.from.name ?? ''} ${msg.from.email}`.toLowerCase()
      result = subject.includes(term.value) || from.includes(term.value)
      break
    }
  }

  return term.negated ? !result : result
}
