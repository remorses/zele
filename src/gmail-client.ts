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
import type { OAuth2Client } from 'googleapis-common'
import { createMimeMessage } from 'mimetext'
import { parseFrom, parseAddressList, resolveReplyRecipients, replySubject, threadAnchor, checkThreadLatestSeen, type SentInThread, type ThreadReplyEnvelope } from './email-utils.js'
import * as errore from 'errore'
import { withRetry, mapConcurrent, isTruthy, AuthError, isAuthLikeError, ApiError, NotFoundError, EmptyThreadError, MissingDataError, abortableSleep, SelfRecipientError, AmbiguousRecipientError, UnseenLatestError } from './api-utils.js'
import { renderEmailBody } from './output.js'
import * as orm from 'drizzle-orm'
import { getDb, schema } from './db.js'
import type { AccountId } from './auth.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthVerdict = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror' | 'bestguesspass'

export interface AuthResult {
  spf: AuthVerdict
  dkim: AuthVerdict
  dmarc: AuthVerdict
  /** true when all three are 'pass' — the email is fully authenticated */
  authentic: boolean
  /** raw Authentication-Results header value */
  raw: string
}

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
  listUnsubscribePost?: string
  body: string // decoded body (html preferred for rich rendering)
  mimeType: string // 'text/plain' or 'text/html'
  textBody: string | null // decoded text/plain body when available (for reply parsing)
  attachments: AttachmentMeta[]
  /** SPF/DKIM/DMARC authentication results from Gmail. null for sent/draft messages. */
  auth: AuthResult | null
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
  to: Sender[]
  cc: Sender[]
  date: string
  labelIds: string[]
  unread: boolean
  starred: boolean
  sent: boolean
  messageCount: number
  inReplyTo: string | null
  hasAttachments: boolean
  listUnsubscribe: string | null
  listUnsubscribePost: string | null
}

export interface ThreadListResult {
  threads: ThreadListItem[]
  /** Raw Google gmail_v1.Schema$Thread metadata responses, parallel to threads[]. */
  rawThreads: gmail_v1.Schema$Thread[]
  nextPageToken: string | null
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

export function buildGmailMimeMessage({
  to,
  subject,
  body,
  cc,
  bcc,
  inReplyTo,
  references,
  attachments,
  fromEmail,
  draft = false,
  plainText = false,
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
  draft?: boolean
  plainText?: boolean
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

  const isHtml = !plainText && (draft
    ? /<\/?(?:html|head|body|div|p|br|span|a|b|strong|i|em|u|ul|ol|li|table|tr|td|th|blockquote|pre|h[1-6]|img|hr)(?:\s[^<>]*|\/?)>/i.test(body)
    : /<[a-z][\s\S]*>/i.test(body))
  // Gmail's plain-text composer hard-wraps draft paragraphs on send.
  // HTML keeps natural wrapping while preserving only the supplied line breaks.
  const draftHtml = draft && !isHtml
    ? `<div style="white-space:pre-wrap">${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r\n|\r|\n/g, '<br>')}</div>`
    : body
  msg.addMessage({
    contentType: isHtml || draft ? 'text/html' : 'text/plain',
    data: draft ? Buffer.from(draftHtml).toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd() : body,
    ...(draft ? { encoding: 'base64' as const } : {}),
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

/**
 * Known folder names that map to Gmail system folders/labels.
 * Used to validate custom label names and prevent query injection.
 */
const KNOWN_FOLDERS = new Set([
  'inbox',
  'sent',
  'trash',
  'bin',
  'spam',
  'drafts',
  'draft',
  'starred',
  'archive',
  'snoozed',
  'all',
])

/** Folder in `q` like sent. Gmail search can lag threads.get; threadMatchesListQuery drops stale unread hits. */
export function buildGmailSearchParams({
  folder,
  query,
  labelIds,
}: {
  folder?: string
  query?: string
  labelIds?: string[]
}) {
  const resolvedLabelIds = [...(labelIds ?? [])]
  let q = query ?? ''

  // mail search passes no folder: search all mail (Gmail excludes spam/trash).
  if (!folder) {
    return { q: q.trim(), resolvedLabelIds }
  }
  if (folder === 'inbox') {
    q = `in:inbox ${q}`.trim()
    return { q, resolvedLabelIds }
  }

  const normalizedFolder = folder.toLowerCase()

  if (!KNOWN_FOLDERS.has(normalizedFolder) && !/^[\w\/-]+$/.test(normalizedFolder)) {
    throw new Error(
      `Invalid folder/label name: "${folder}". Use alphanumeric characters, underscores, hyphens, and slashes only.`,
    )
  }

  switch (normalizedFolder) {
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
      q = `label:${normalizedFolder} ${q}`.trim()
      break
  }

  return { q, resolvedLabelIds }
}

/** Re-check UNREAD/STARRED after hydration. Gmail search can lag threads.get. */
export function threadMatchesListQuery(
  thread: { unread: boolean; starred: boolean },
  query?: string,
): boolean {
  if (!query) return true
  if (/\bOR\b|\{/.test(query)) return true
  return parseQueryTerms(query, { warn: false }).every((t) => {
    if (t.operator !== 'is') return true
    const v = t.value === 'unread' ? thread.unread
      : t.value === 'read' ? !thread.unread
      : t.value === 'starred' ? thread.starred
      : null
    return v === null ? true : t.negated ? !v : v
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
    const row = getDb().query.thread.findFirst({
      where: { email: this.account!.email, appId: this.account!.appId, threadId },
    }).sync()
    if (!row || isExpired(row.createdAt, row.ttlMs)) return undefined
    return JSON.parse(row.rawData) as gmail_v1.Schema$Thread
  }

  private async cacheThreadData(threadId: string, raw: gmail_v1.Schema$Thread, parsed: ThreadData): Promise<void> {
    if (!this.cacheEnabled) return
    const now = new Date()
    const values = {
      email: this.account!.email,
      appId: this.account!.appId,
      threadId,
      subject: parsed.subject,
      snippet: parsed.snippet,
      fromEmail: parsed.from.email,
      fromName: parsed.from.name ?? '',
      date: parsed.date,
      labelIds: parsed.labelIds.join(','),
      hasUnread: parsed.hasUnread,
      msgCount: parsed.messageCount,
      historyId: parsed.historyId,
      rawData: JSON.stringify(raw),
      ttlMs: TTL.THREAD,
      createdAt: now,
    }
    getDb()
      .insert(schema.thread)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.thread.email, schema.thread.appId, schema.thread.threadId],
        set: {
          subject: values.subject,
          snippet: values.snippet,
          fromEmail: values.fromEmail,
          fromName: values.fromName,
          date: values.date,
          labelIds: values.labelIds,
          hasUnread: values.hasUnread,
          msgCount: values.msgCount,
          historyId: values.historyId,
          rawData: values.rawData,
          ttlMs: values.ttlMs,
          createdAt: values.createdAt,
        },
      })
      .run()
  }

  async invalidateThreads(threadIds: string[]): Promise<void> {
    if (!this.cacheEnabled) return
    if (threadIds.length === 0) return
    getDb()
      .delete(schema.thread)
      .where(
        orm.and(
          orm.eq(schema.thread.email, this.account!.email),
          orm.eq(schema.thread.appId, this.account!.appId),
          orm.inArray(schema.thread.threadId, threadIds),
        ),
      )
      .run()
  }

  async invalidateThread(threadId: string): Promise<void> {
    if (!this.cacheEnabled) return
    getDb()
      .delete(schema.thread)
      .where(
        orm.and(
          orm.eq(schema.thread.email, this.account!.email),
          orm.eq(schema.thread.appId, this.account!.appId),
          orm.eq(schema.thread.threadId, threadId),
        ),
      )
      .run()
  }

  private async getCachedLabels(): Promise<gmail_v1.Schema$Label[] | undefined> {
    if (!this.cacheEnabled) return undefined
    const row = getDb().query.label.findFirst({
      where: { email: this.account!.email, appId: this.account!.appId },
    }).sync()
    if (!row || isExpired(row.createdAt, row.ttlMs)) return undefined
    return JSON.parse(row.rawData) as gmail_v1.Schema$Label[]
  }

  private async cacheLabelsData(raw: gmail_v1.Schema$Label[]): Promise<void> {
    if (!this.cacheEnabled) return
    const now = new Date()
    getDb()
      .insert(schema.label)
      .values({
        email: this.account!.email,
        appId: this.account!.appId,
        rawData: JSON.stringify(raw),
        ttlMs: TTL.LABELS,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.label.email, schema.label.appId],
        set: { rawData: JSON.stringify(raw), ttlMs: TTL.LABELS, createdAt: now },
      })
      .run()
  }

  async invalidateLabels(): Promise<void> {
    if (!this.cacheEnabled) return
    getDb()
      .delete(schema.label)
      .where(
        orm.and(orm.eq(schema.label.email, this.account!.email), orm.eq(schema.label.appId, this.account!.appId)),
      )
      .run()
  }

  private async getCachedProfile(): Promise<{ emailAddress: string; messagesTotal: number; threadsTotal: number; historyId: string } | undefined> {
    if (!this.cacheEnabled) return undefined
    const row = getDb().query.profile.findFirst({
      where: { email: this.account!.email, appId: this.account!.appId },
    }).sync()
    if (!row || isExpired(row.createdAt, row.ttlMs)) return undefined
    return { emailAddress: row.emailAddress, messagesTotal: row.messagesTotal, threadsTotal: row.threadsTotal, historyId: row.historyId }
  }

  private async cacheProfileData(profile: { emailAddress: string; messagesTotal: number; threadsTotal: number; historyId: string }): Promise<void> {
    if (!this.cacheEnabled) return
    const now = new Date()
    getDb()
      .insert(schema.profile)
      .values({
        email: this.account!.email,
        appId: this.account!.appId,
        ...profile,
        ttlMs: TTL.PROFILE,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.profile.email, schema.profile.appId],
        set: { ...profile, ttlMs: TTL.PROFILE, createdAt: now },
      })
      .run()
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
    const { q, resolvedLabelIds } = buildGmailSearchParams({ folder, query, labelIds })

    const fetchPage = async ({
      token,
      pageSize,
    }: {
      token?: string
      pageSize: number
    }): Promise<ThreadListResult | AuthError | ApiError> => {
      const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
        withRetry(() =>
          this.gmail.users.threads.list({
            userId: 'me',
            q: q || undefined,
            labelIds: resolvedLabelIds.length > 0 ? resolvedLabelIds : undefined,
            maxResults: pageSize,
            pageToken: token || undefined,
          }),
        ),
      )
      if (res instanceof Error) return res

      const pageThreads = res.data.threads ?? []
      const hydrated = await mapConcurrent(pageThreads, async (t) => {
        if (!t.id) return null

        const cached = await this.getCachedThread(t.id)
        if (cached && t.historyId && cached.historyId && t.historyId === cached.historyId) {
          return { parsed: this.parseThreadListItem(cached), raw: cached }
        }

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

      const matched = hydrated.filter(isTruthy).filter((t) => threadMatchesListQuery(t.parsed, query))
      return {
        threads: matched.map((t) => t.parsed),
        rawThreads: matched.map((t) => t.raw),
        nextPageToken: res.data.nextPageToken ?? null,
      }
    }

    const threads: ThreadListItem[] = []
    const rawThreads: gmail_v1.Schema$Thread[] = []
    let token = pageToken
    let nextPageToken: string | null = null

    while (threads.length < maxResults) {
      const page = await fetchPage({
        token,
        pageSize: maxResults - threads.length,
      })
      if (page instanceof Error) return page
      threads.push(...page.threads)
      rawThreads.push(...page.rawThreads)
      nextPageToken = page.nextPageToken
      if (!nextPageToken) break
      token = nextPageToken
    }

    return {
      threads,
      rawThreads,
      nextPageToken,
    }
  }

  async getThread({
    threadId,
    skipCache = false,
  }: {
    threadId: string
    // mail read and reply seen-checks must skip cache. A stale cached last
    // message would be recorded as seen, then a live reply fetch would never
    // match, and the agent would loop on mail read.
    skipCache?: boolean
  }): Promise<ThreadResult | AuthError | ApiError> {
    if (!skipCache) {
      const cached = await this.getCachedThread(threadId)
      if (cached) {
        return { parsed: this.parseThread(cached), raw: cached }
      }
    }

    const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
      withRetry(() =>
        this.gmail.users.threads.get({
          userId: 'me',
          id: threadId,
          format: 'full',
        }),
      ),
    )
    if (res instanceof Error) return res

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
    const raw = buildGmailMimeMessage({
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

    const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
      withRetry(() =>
        this.gmail.users.messages.send({
          userId: 'me',
          requestBody: {
            raw,
            threadId,
          },
        }),
      ),
    )
    if (res instanceof Error) return res

    return res.data
  }

  // =========================================================================
  // Reply / Forward (high-level composition)
  // =========================================================================

  /**
   * Resolve everything needed to compose a message inside an existing thread:
   * recipients (see resolveReplyRecipients), Cc, and the In-Reply-To/References
   * headers taken from the same anchor message.
   *
   * This is the single place recipient inference happens — sendInThread and
   * createDraftReply both go through it. Do not reintroduce
   * "reply to the sender of the last message" anywhere: that mails you back
   * whenever the last message in the thread is one you sent.
   */
  async resolveThreadReply({
    threadId,
    to,
    cc,
    replyAll = false,
    allowSelf = false,
    seenMessageId,
  }: {
    threadId: string
    to?: Array<{ name?: string; email: string }>
    cc?: Array<{ name?: string; email: string }>
    replyAll?: boolean
    allowSelf?: boolean
    /** undefined skips the check (TUI, --force, --dry-run). null means never read. */
    seenMessageId?: string | null
  }): Promise<ThreadReplyEnvelope | EmptyThreadError | SelfRecipientError | AmbiguousRecipientError | UnseenLatestError | AuthError | ApiError> {
    const thread = await this.getThread({ threadId, skipCache: true })
    if (thread instanceof Error) return thread

    const messages = thread.parsed.messages
    if (messages.length === 0) {
      return new EmptyThreadError({ threadId })
    }

    if (seenMessageId !== undefined) {
      const last = threadAnchor(messages)
      if (!last) return new EmptyThreadError({ threadId })
      const unseen = checkThreadLatestSeen({ threadId, lastMessageId: last.id, seenMessageId })
      if (unseen) return unseen
    }

    // An explicit recipient without reply-all needs no inference, so an
    // unrelated alias-settings outage must not block the override.
    const selfAddresses = to && to.length > 0 && !replyAll
      ? []
      : await this.getSelfAddresses()
    if (selfAddresses instanceof Error) return selfAddresses

    const resolution = resolveReplyRecipients({
      messages,
      selfAddresses,
      threadId,
      replyAll,
      explicitTo: to,
      extraCc: cc,
      allowSelf,
    })
    if (resolution instanceof Error) return resolution

    const { anchor } = resolution
    const references = [anchor.references, anchor.messageId].filter(Boolean).join(' ')

    return {
      to: resolution.to,
      cc: resolution.cc.length > 0 ? resolution.cc : undefined,
      anchorSubject: anchor.subject,
      inReplyTo: anchor.messageId || undefined,
      references: references || undefined,
      source: resolution.source,
    }
  }

  /** Account address plus send-as aliases, used to detect "this is me" when replying.
   *  Falls back to the primary address when Gmail settings access is unavailable. */
  private async getSelfAddresses(): Promise<string[] | AuthError | ApiError> {
    const aliases = await this.getEmailAliases()
    if (aliases instanceof Error) return aliases
    return aliases.map((a) => a.email).filter(Boolean)
  }

  /**
   * Send a message into an existing thread with correct threading headers.
   * Recipients are inferred from the thread unless `to` is given; `subject`
   * defaults to the thread subject prefixed with "Re:".
   *
   * This is also how replies are sent — a reply is just a message in a thread
   * with an inferred recipient and subject.
   */
  async sendInThread({
    threadId,
    body,
    to,
    subject,
    cc,
    bcc,
    replyAll = false,
    allowSelf = false,
    fromEmail,
    attachments,
    seenMessageId,
  }: {
    threadId: string
    body: string
    to?: Array<{ name?: string; email: string }>
    subject?: string
    cc?: Array<{ name?: string; email: string }>
    bcc?: Array<{ name?: string; email: string }>
    replyAll?: boolean
    allowSelf?: boolean
    fromEmail?: string
    attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>
    seenMessageId?: string | null
  }): Promise<EmptyThreadError | SelfRecipientError | AmbiguousRecipientError | UnseenLatestError | AuthError | ApiError | SentInThread<gmail_v1.Schema$Message>> {
    const envelope = await this.resolveThreadReply({ threadId, to, cc, replyAll, allowSelf, seenMessageId })
    if (envelope instanceof Error) return envelope

    const result = await this.sendMessage({
      to: envelope.to,
      subject: subject ?? replySubject(envelope.anchorSubject),
      body,
      cc: envelope.cc,
      bcc,
      threadId,
      inReplyTo: envelope.inReplyTo,
      references: envelope.references,
      fromEmail,
      attachments,
    })
    if (result instanceof Error) return result

    await this.invalidateThread(threadId)

    return {
      message: result,
      to: envelope.to.map((r) => r.email),
      cc: (envelope.cc ?? []).map((r) => r.email),
      bcc: (bcc ?? []).map((r) => r.email),
      recipientSource: envelope.source,
    }
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
  }): Promise<EmptyThreadError | AuthError | ApiError | gmail_v1.Schema$Message> {
    const thread = await this.getThread({ threadId })
    if (thread instanceof Error) return thread

    const lastMsg = threadAnchor(thread.parsed.messages)
    if (!lastMsg) return new EmptyThreadError({ threadId })

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
    const raw = buildGmailMimeMessage({ to, subject, body, cc, bcc, attachments, fromEmail, draft: true })

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

  async getDraft({ draftId }: { draftId: string }): Promise<NotFoundError | AuthError | ApiError | { id: string; message: ParsedMessage; to: Sender[]; cc: Sender[]; bcc: Sender[] }> {
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

    return {
      id: res.data.id ?? draftId,
      message,
      to: message.to,
      cc: message.cc ?? [],
      bcc: message.bcc,
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

  /**
   * Update an existing draft. Gmail replaces the entire message content,
   * so the caller must provide all fields (merge with existing draft before calling).
   */
  async updateDraft({
    draftId,
    to,
    subject,
    body,
    cc,
    bcc,
    threadId,
    fromEmail,
    attachments,
  }: {
    draftId: string
    to: Array<{ name?: string; email: string }>
    subject: string
    body: string
    cc?: Array<{ name?: string; email: string }>
    bcc?: Array<{ name?: string; email: string }>
    threadId?: string
    fromEmail?: string
    attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>
  }) {
    const raw = buildGmailMimeMessage({ to, subject, body, cc, bcc, attachments, fromEmail, draft: true })

    const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
      withRetry(() =>
        this.gmail.users.drafts.update({
          userId: 'me',
          id: draftId,
          requestBody: {
            message: { raw, threadId },
          },
        }),
      ),
    )
    if (res instanceof Error) return res

    return res.data
  }

  /**
   * Create a draft reply to a thread. Shares recipient resolution and
   * In-Reply-To/References header logic with sendInThread(), but saves the
   * message as a draft instead of sending it.
   */
  async createDraftReply({
    threadId,
    body,
    to,
    replyAll = false,
    cc,
    bcc,
    allowSelf = false,
    fromEmail,
    attachments,
    seenMessageId,
  }: {
    threadId: string
    body: string
    to?: Array<{ name?: string; email: string }>
    replyAll?: boolean
    cc?: Array<{ name?: string; email: string }>
    bcc?: Array<{ name?: string; email: string }>
    allowSelf?: boolean
    fromEmail?: string
    attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>
    seenMessageId?: string | null
  }): Promise<EmptyThreadError | SelfRecipientError | AmbiguousRecipientError | UnseenLatestError | AuthError | ApiError | SentInThread<gmail_v1.Schema$Draft>> {
    const envelope = await this.resolveThreadReply({ threadId, to, cc, replyAll, allowSelf, seenMessageId })
    if (envelope instanceof Error) return envelope

    const raw = buildGmailMimeMessage({
      draft: true,
      to: envelope.to,
      subject: replySubject(envelope.anchorSubject),
      body,
      cc: envelope.cc,
      bcc,
      inReplyTo: envelope.inReplyTo,
      references: envelope.references,
      fromEmail,
      attachments,
    })

    const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
      withRetry(() =>
        this.gmail.users.drafts.create({
          userId: 'me',
          requestBody: {
            message: { raw, threadId },
          },
        }),
      ),
    )
    if (res instanceof Error) return res

    return {
      message: res.data,
      to: envelope.to.map((r) => r.email),
      cc: (envelope.cc ?? []).map((r) => r.email),
      bcc: (bcc ?? []).map((r) => r.email),
      recipientSource: envelope.source,
    }
  }

  /**
   * Create a draft forwarding a thread. Reuses the same forwarded-message body
   * building logic as forwardThread(), but saves as a draft instead of sending.
   */
  async createDraftForward({
    threadId,
    to,
    body,
    fromEmail,
  }: {
    threadId: string
    to: Array<{ email: string }>
    body?: string
    fromEmail?: string
  }): Promise<EmptyThreadError | AuthError | ApiError | gmail_v1.Schema$Draft> {
    const thread = await this.getThread({ threadId })
    if (thread instanceof Error) return thread

    const lastMsg = threadAnchor(thread.parsed.messages)
    if (!lastMsg) return new EmptyThreadError({ threadId })

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

    const raw = buildGmailMimeMessage({
      draft: true,
      plainText: true,
      to,
      subject: `Fwd: ${lastMsg.subject}`,
      body: fullBody,
      fromEmail,
    })

    const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
      withRetry(() =>
        this.gmail.users.drafts.create({
          userId: 'me',
          requestBody: {
            message: { raw, threadId },
          },
        }),
      ),
    )
    if (res instanceof Error) return res

    return res.data
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
    const mod = await this.batchModifyMessages(messageIds, { removeLabelIds: ['UNREAD'] })
    if (mod instanceof Error) return mod
    await this.invalidateAfterThreadMutation(threadIds)
  }

  async markAsUnread({ threadIds }: { threadIds: string[] }): Promise<void | AuthError | ApiError> {
    const messageIds = await this.getMessageIdsForThreads(threadIds, (labelIds) =>
      !labelIds.includes('UNREAD'),
    )
    if (messageIds instanceof Error) return messageIds
    if (messageIds.length === 0) return
    const mod = await this.batchModifyMessages(messageIds, { addLabelIds: ['UNREAD'] })
    if (mod instanceof Error) return mod
    await this.invalidateAfterThreadMutation(threadIds)
  }

  async star({ threadIds }: { threadIds: string[] }): Promise<void | AuthError | ApiError> {
    const messageIds = await this.getMessageIdsForThreads(threadIds)
    if (messageIds instanceof Error) return messageIds
    if (messageIds.length === 0) return
    const mod = await this.batchModifyMessages(messageIds, { addLabelIds: ['STARRED'] })
    if (mod instanceof Error) return mod
    await this.invalidateAfterThreadMutation(threadIds)
  }

  async unstar({ threadIds }: { threadIds: string[] }): Promise<void | AuthError | ApiError> {
    const messageIds = await this.getMessageIdsForThreads(threadIds, (labelIds) =>
      labelIds.includes('STARRED'),
    )
    if (messageIds instanceof Error) return messageIds
    if (messageIds.length === 0) return
    const mod = await this.batchModifyMessages(messageIds, { removeLabelIds: ['STARRED'] })
    if (mod instanceof Error) return mod
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

    const resolvedRemoveRaw = await Promise.all(removeLabelIds.map((l) => this.lookupLabel(l)))
    const removeErr = resolvedRemoveRaw.find((r): r is AuthError | ApiError => r instanceof Error)
    if (removeErr) return removeErr
    const resolvedRemove = resolvedRemoveRaw.filter((id): id is string => typeof id === 'string')

    const messageIds = await this.getMessageIdsForThreads(threadIds)
    if (messageIds instanceof Error) return messageIds
    if (messageIds.length === 0) return

    const mod = await this.batchModifyMessages(messageIds, {
      addLabelIds: resolvedAdd.filter((r): r is string => typeof r === 'string'),
      removeLabelIds: resolvedRemove,
    })
    if (mod instanceof Error) return mod
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
    const mod = await this.batchModifyMessages(messageIds, { removeLabelIds: ['INBOX'] })
    if (mod instanceof Error) return mod
    await this.invalidateAfterThreadMutation(threadIds)
  }

  async markAsSpam({ threadIds }: { threadIds: string[] }): Promise<void | AuthError | ApiError> {
    const messageIds = await this.getMessageIdsForThreads(threadIds)
    if (messageIds instanceof Error) return messageIds
    if (messageIds.length === 0) return
    const mod = await this.batchModifyMessages(messageIds, { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] })
    if (mod instanceof Error) return mod
    await this.invalidateAfterThreadMutation(threadIds)
  }

  async unmarkSpam({ threadIds }: { threadIds: string[] }): Promise<void | AuthError | ApiError> {
    const messageIds = await this.getMessageIdsForThreads(threadIds, (labelIds) =>
      labelIds.includes('SPAM'),
    )
    if (messageIds instanceof Error) return messageIds
    if (messageIds.length === 0) return
    const mod = await this.batchModifyMessages(messageIds, { removeLabelIds: ['SPAM'], addLabelIds: ['INBOX'] })
    if (mod instanceof Error) return mod
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
      const mod = await this.batchModifyMessages(messageIds, {
        addLabelIds: ['TRASH'],
        removeLabelIds: ['SPAM', 'INBOX'],
      })
      if (mod instanceof Error) return mod

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
  // Filters
  // =========================================================================

  async listFilters(): Promise<{ parsed: gmail_v1.Schema$Filter[] } | AuthError | ApiError> {
    const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
      withRetry(() => this.gmail.users.settings.filters.list({ userId: 'me' })),
    )
    if (res instanceof Error) return res
    return { parsed: res.data.filter ?? [] }
  }

  async createFilter(opts: {
    from?: string
    query?: string
    addLabelIds?: string[]
    removeLabelIds?: string[]
  }): Promise<gmail_v1.Schema$Filter | AuthError | ApiError> {
    const criteria: gmail_v1.Schema$FilterCriteria = {}
    if (opts.from) criteria.from = opts.from
    if (opts.query) criteria.query = opts.query

    const action: gmail_v1.Schema$FilterAction = {}
    if (opts.addLabelIds?.length) action.addLabelIds = opts.addLabelIds
    if (opts.removeLabelIds?.length) action.removeLabelIds = opts.removeLabelIds

    const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
      withRetry(() =>
        this.gmail.users.settings.filters.create({
          userId: 'me',
          requestBody: { criteria, action },
        }),
      ),
    )
    if (res instanceof Error) return res
    return res.data
  }

  async deleteFilter(filterId: string): Promise<void | AuthError | ApiError> {
    const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
      withRetry(() =>
        this.gmail.users.settings.filters.delete({
          userId: 'me',
          id: filterId,
        }),
      ),
    )
    if (res instanceof Error) return res
  }

  /** Resolve a label name to its ID, auto-creating if missing. Public wrapper for filter commands. */
  async resolveLabel(nameOrId: string): Promise<string | AuthError | ApiError> {
    return this.resolveLabelId(nameOrId)
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

    const latest = threadAnchor(messages) ?? messages[messages.length - 1]!
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

    // Authentication-Results: multiple MTAs can add this header. Prefer the one
    // stamped by Gmail's trusted authserv-id (mx.google.com) to avoid trusting
    // headers injected by upstream/untrusted relays.
    const authHeaders = headers
      .filter((h) => h.name?.toLowerCase() === 'authentication-results')
      .map((h) => h.value ?? '')
      .filter((v) => v.length > 0)
    const trustedAuthHeader =
      authHeaders.find((v) => v.trim().toLowerCase().startsWith('mx.google.com'))
      ?? authHeaders[0]
      ?? null
    const isSentOrDraft = labelIds.includes('SENT') || labelIds.includes('DRAFT')
    const auth = trustedAuthHeader && !isSentOrDraft ? parseAuthResults(trustedAuthHeader) : null

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
      listUnsubscribePost: getHeader('list-unsubscribe-post') ?? undefined,
      body,
      mimeType,
      textBody,
      attachments: this.extractAttachmentMeta(message.payload?.parts ?? []),
      auth,
    }
  }

  /** Parse raw gmail_v1.Schema$Thread (format: metadata) into ThreadListItem.
   *  `from` is the latest message From header. Do not rewrite it to the other party. */
  parseThreadListItem(raw: gmail_v1.Schema$Thread): ThreadListItem {
    const messages = raw.messages ?? []
    const nonDraftMessages = messages.filter((m) => !m.labelIds?.includes('DRAFT'))
    const latest = nonDraftMessages[nonDraftMessages.length - 1] ?? messages[messages.length - 1]

    const headers = latest?.payload?.headers ?? []
    const allLabels = [...new Set(messages.flatMap((m) => m.labelIds ?? []))]

    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null

    const toHeader = getHeader('to') ?? ''
    const ccHeaders = headers
      .filter((h) => h.name?.toLowerCase() === 'cc')
      .map((h) => h.value ?? '')
      .filter((v) => v.length > 0)

    // Check if any non-draft message in the thread is a reply (has In-Reply-To header)
    const inReplyTo =
      nonDraftMessages
        .map(
          (m) =>
            m.payload?.headers?.find((h) => h.name?.toLowerCase() === 'in-reply-to')?.value ??
            null,
        )
        .find((v) => v !== null) ?? null

    // Check if any message has attachments (non-inline)
    const hasAttachments = messages.some((m) => this.hasNonInlineAttachments(m.payload))

    // List-Unsubscribe / List-Unsubscribe-Post from latest message (RFC 2369 + RFC 8058).
    // Used by `mail list` to surface can_unsubscribe / one_click booleans and
    // by `mail unsubscribe` to plan the unsubscribe flow without re-fetching.
    const listUnsubscribe = getHeader('list-unsubscribe') ?? null
    const listUnsubscribePost = getHeader('list-unsubscribe-post') ?? null

    return {
      id: raw.id ?? '',
      historyId: raw.historyId ?? null,
      snippet: sanitizeSnippet(latest?.snippet ?? ''),
      subject: (getHeader('subject') ?? '(no subject)').replace(/"/g, '').trim(),
      from: parseFrom(getHeader('from') ?? ''),
      to: toHeader ? parseAddressList(toHeader) : [],
      cc: ccHeaders.length > 0
        ? ccHeaders.filter((h) => h.trim().length > 0).flatMap((h) => parseAddressList(h))
        : [],
      date: getHeader('date') ?? '',
      labelIds: allLabels,
      unread: allLabels.includes('UNREAD'),
      starred: allLabels.includes('STARRED'),
      sent: latest?.labelIds?.includes('SENT') ?? false,
      messageCount: nonDraftMessages.length,
      inReplyTo,
      hasAttachments,
      listUnsubscribe,
      listUnsubscribePost,
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

  /** Quick check: does the message payload tree contain any non-inline attachments?
   *  Checks the root part itself (some messages have attachment metadata there)
   *  then recurses into child parts. */
  private hasNonInlineAttachments(part: gmail_v1.Schema$MessagePart | undefined): boolean {
    if (!part) return false
    if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
      const disposition =
        part.headers?.find((h) => h.name?.toLowerCase() === 'content-disposition')?.value ?? ''
      const hasContentId = part.headers?.some((h) => h.name?.toLowerCase() === 'content-id')
      const isInline = disposition.toLowerCase().includes('inline')
      if (!isInline || !hasContentId) return true
    }
    for (const child of part.parts ?? []) {
      if (this.hasNonInlineAttachments(child)) return true
    }
    return false
  }

  async getEmailAliases(): Promise<Array<{ email: string; name?: string; primary: boolean }> | AuthError | ApiError> {
    const profile = await this.getProfile()
    if (profile instanceof Error) return profile
    const primaryEmail = profile.emailAddress

    const aliases: Array<{ email: string; name?: string; primary: boolean }> = [
      { email: primaryEmail, primary: true },
    ]

    // Alias discovery is part of reply safety. If it fails, fail closed rather
    // than treating a send-as alias as an external sender and mailing it.
    const settings = await gmailBoundary(this.account?.email ?? 'unknown', () =>
      withRetry(() =>
        this.gmail.users.settings.sendAs.list({ userId: 'me' }),
      ),
    )
    if (settings instanceof Error) return settings

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
    signal,
  }: {
    folder?: string
    intervalMs?: number
    query?: string
    signal?: AbortSignal
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

    while (!signal?.aborted) {
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

      await abortableSleep(intervalMs, signal)
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
  // Private: label resolution
  // =========================================================================

  /** Look up a label ID by name. Returns null if not found (never creates). */
  async lookupLabel(labelNameOrId: string): Promise<string | null | AuthError | ApiError> {
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
  ): Promise<void | AuthError | ApiError> {
    if (messageIds.length === 0) return

    // Gmail batchModify accepts up to 1000 IDs
    const chunkSize = 1000
    for (let i = 0; i < messageIds.length; i += chunkSize) {
      const chunk = messageIds.slice(i, i + chunkSize)
      const res = await gmailBoundary(this.account?.email ?? 'unknown', () =>
        withRetry(() =>
          this.gmail.users.messages.batchModify({
            userId: 'me',
            requestBody: {
              ids: chunk,
              ...body,
            },
          }),
        ),
      )
      if (res instanceof Error) return res
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
// Email authentication: parse the Authentication-Results header
// ---------------------------------------------------------------------------
// Gmail adds an Authentication-Results header to every received message with
// SPF, DKIM, and DMARC verdicts. Format is semi-structured:
//   Authentication-Results: mx.google.com;
//       dkim=pass header.i=@example.com header.s=sel1;
//       spf=pass (...) smtp.mailfrom=user@example.com;
//       dmarc=pass (p=REJECT) header.from=example.com
// We extract the verdict keyword after each protocol name.
// ---------------------------------------------------------------------------

const AUTH_VERDICTS = new Set(['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror', 'bestguesspass'])

/** Parse a Gmail Authentication-Results header into structured verdicts. */
export function parseAuthResults(header: string): AuthResult {
  const lower = header.toLowerCase()
  const extract = (protocol: string): AuthVerdict => {
    // Match "protocol=verdict" — verdict is a word that stops at whitespace, semicolons, or parens
    const re = new RegExp(`\\b${protocol}\\s*=\\s*([a-z]+)`)
    const match = re.exec(lower)
    const verdict = match?.[1] ?? 'none'
    return AUTH_VERDICTS.has(verdict) ? verdict as AuthVerdict : 'none'
  }
  const spf = extract('spf')
  const dkim = extract('dkim')
  const dmarc = extract('dmarc')
  return {
    spf,
    dkim,
    dmarc,
    authentic: spf === 'pass' && dkim === 'pass' && dmarc === 'pass',
    raw: header,
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
  const row = getDb().query.syncState.findFirst({
    where: { email: account.email, appId: account.appId, key: 'history_id' },
  }).sync()
  return row?.value
}

async function setLastHistoryId(account: AccountId, historyId: string): Promise<void> {
  getDb()
    .insert(schema.syncState)
    .values({ email: account.email, appId: account.appId, key: 'history_id', value: historyId })
    .onConflictDoUpdate({
      target: [schema.syncState.email, schema.syncState.appId, schema.syncState.key],
      set: { value: historyId },
    })
    .run()
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

function parseQueryTerms(query: string, { warn = true }: { warn?: boolean } = {}): QueryTerm[] {
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
      if (warn && !warnedOperators.has(rawOperator)) {
        warnedOperators.add(rawOperator)
        console.error(`# --query: "${rawOperator}:" is a server-only operator (use "mail search" instead), skipping`)
      }
      continue
    }

    if (rawOperator && !SUPPORTED_OPERATORS.has(rawOperator)) {
      if (warn && !warnedOperators.has(rawOperator)) {
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
